// Turns what the browser measured during a call into spoken evidence. Pure: no I/O, no clock.

export const FOCUSES = ['calls', 'network', 'audio', 'signin', 'general'] as const;
export type DiagnosticFocus = (typeof FOCUSES)[number];

export const SITES = { slack: 'Slack', github: 'GitHub', google: 'Google', microsoft: 'Microsoft sign-in' } as const;
type SiteKey = keyof typeof SITES;

const NET_TYPES = ['slow-2g', '2g', '3g', '4g'] as const;
const CAMERA_STATES = ['granted', 'denied', 'prompt'] as const;

interface SiteCheck {
  site: SiteKey;
  ok: boolean;
  ms?: number;
}

// What the browser measured. A missing field means that check could not run.
export interface DiagnosticResults {
  online?: boolean;
  lossUpPct?: number;
  lossDownPct?: number;
  rttMs?: number;
  jitterMs?: number;
  // Agora network quality: 1 excellent to 6 disconnected.
  uplink?: number;
  downlink?: number;
  sites?: SiteCheck[];
  // Peak input level over about a second, 0 to 1.
  micLevel?: number;
  micMuted?: boolean;
  outputs?: number;
  camera?: (typeof CAMERA_STATES)[number];
  // Positive when the laptop clock is ahead of the server.
  clockSkewSec?: number;
  netType?: (typeof NET_TYPES)[number];
  netDownlinkMbps?: number;
  netRttMs?: number;
  batteryPct?: number;
  charging?: boolean;
  browser?: string;
  os?: string;
}

export type Severity = 'ok' | 'warn' | 'bad';
export const CHECK_GROUPS = ['internet', 'call', 'mic', 'speakers', 'camera', 'clock', 'battery'] as const;
type CheckGroup = (typeof CHECK_GROUPS)[number];

export interface Finding {
  key: string;
  group: CheckGroup;
  severity: Severity;
  say: string;
  // Matters for the problem Priya described.
  relevant: boolean;
  // Guided fix in kb.ts for this finding.
  guide?: string;
}

// Groups that matter per problem, most telling first.
const FOCUS_GROUPS: Record<DiagnosticFocus, CheckGroup[]> = {
  calls: ['call', 'internet', 'mic', 'speakers', 'camera'],
  audio: ['mic', 'speakers', 'call'],
  network: ['internet', 'call'],
  signin: ['clock', 'internet'],
  general: ['internet', 'battery', 'call', 'clock'],
};

const LOSS = { warn: 2, bad: 5 };
const RTT_MS = { warn: 300, bad: 600 };
const JITTER_MS = { warn: 30, bad: 60 };
const SLOW_SITE_MS = 1500;
const CLOCK_SKEW_SEC = 120;
const SILENT_MIC = 0.01;
const LOW_BATTERY = 15;
const SLOW_LINK_MBPS = 1;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const tier = (n: number, t: { warn: number; bad: number }): Severity => (n > t.bad ? 'bad' : n > t.warn ? 'warn' : 'ok');
const percent = (n: number) => `${n < 1 ? Math.round(n * 10) / 10 : Math.round(n)} percent`;
// Seconds from 300 ms up, so no spoken number sounds like an error code.
const duration = (ms: number) => (ms < 300 ? `${Math.round(ms)} milliseconds` : `${ms < 1000 ? Math.round(ms / 10) / 100 : Math.round(ms / 100) / 10} seconds`);
const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const list = (items: string[], last = 'and') => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}`);

function span(sec: number): string {
  const s = Math.abs(sec);
  if (s < CLOCK_SKEW_SEC) return unit(Math.round(s), 'second');
  if (s < 2 * 3600) return unit(Math.round(s / 60), 'minute');
  if (s < 48 * 3600) return unit(Math.round(s / 3600), 'hour');
  return unit(Math.round(s / 86400), 'day');
}

type Draft = Omit<Finding, 'relevant'>;

function internet(r: DiagnosticResults, focus: DiagnosticFocus): Draft[] {
  const out: Draft[] = [];
  const sites = r.sites ?? [];
  const reached = sites.filter((s) => s.ok);
  const missed = sites.filter((s) => !s.ok);
  const names = (xs: SiteCheck[]) => xs.map((s) => SITES[s.site]);
  // A service that answered proves the browser is online, whatever navigator.onLine says.
  if (r.online === false && !reached.length) {
    out.push({ key: 'offline', group: 'internet', severity: 'bad', say: 'Your browser says this laptop is offline.', guide: 'wifi' });
  } else if (sites.length && !reached.length) {
    out.push({ key: 'sites', group: 'internet', severity: 'bad', say: `None of ${list(names(missed), 'or')} answered, so your internet connection looks down.`, guide: 'wifi' });
  } else if (missed.length) {
    const guide = focus === 'signin' && missed.some((s) => s.site === 'microsoft') ? 'sso-loop' : 'dns-captive-portal';
    out.push({ key: 'sites', group: 'internet', severity: 'bad', say: `${list(names(missed))} did not answer from your browser, though ${list(names(reached))} did.`, guide });
  } else if (reached.length) {
    const timed = reached.filter((s) => finite(s.ms)).sort((a, b) => b.ms! - a.ms!);
    const slowest = timed[0];
    if (slowest && slowest.ms! > SLOW_SITE_MS) {
      out.push({ key: 'sites', group: 'internet', severity: 'warn', say: `${SITES[slowest.site]} took ${duration(slowest.ms!)} to answer; under half a second is normal.`, guide: 'wifi' });
    } else {
      const all = reached.length > 1 ? `${list(names(reached))} all answered` : `${names(reached)[0]} answered`;
      out.push({ key: 'sites', group: 'internet', severity: 'ok', say: `${all}${slowest ? `, the slowest in ${duration(slowest.ms!)}` : ''}.` });
    }
  }
  const slowType = r.netType === 'slow-2g' || r.netType === '2g' ? 'bad' : r.netType === '3g' ? 'warn' : null;
  if (slowType) {
    out.push({ key: 'link', group: 'internet', severity: slowType, say: `Your browser rates your connection as slow as ${r.netType === 'slow-2g' ? 'slow 2G' : String(r.netType).toUpperCase()}.`, guide: 'wifi' });
  } else if (finite(r.netDownlinkMbps) && r.netDownlinkMbps < SLOW_LINK_MBPS) {
    out.push({ key: 'link', group: 'internet', severity: 'warn', say: `Your browser estimates your download speed at ${Math.round(r.netDownlinkMbps * 10) / 10} megabits a second, which is slow.`, guide: 'wifi' });
  } else if (r.netType || finite(r.netDownlinkMbps)) {
    out.push({ key: 'link', group: 'internet', severity: 'ok', say: 'Your browser rates your connection speed as fine.' });
  }
  return out;
}

const QUALITY_WORD: Record<number, string> = { 4: 'poor', 5: 'very poor', 6: 'disconnected' };

function call(r: DiagnosticResults): Draft[] {
  const out: Draft[] = [];
  const up = finite(r.lossUpPct) ? r.lossUpPct : undefined;
  const down = finite(r.lossDownPct) ? r.lossDownPct : undefined;
  if (up !== undefined || down !== undefined) {
    const outbound = (up ?? -1) >= (down ?? -1);
    const loss = Math.max(up ?? 0, down ?? 0);
    const severity = tier(loss, LOSS);
    const say =
      severity === 'ok' ? (loss === 0 ? "There's no packet loss on the call." : `Packet loss on the call is ${percent(loss)}, which is fine.`)
      : outbound ? `You're losing ${percent(loss)} of your call audio on the way out, so your voice breaks up.`
      : `You're losing ${percent(loss)} of the call audio coming to you, so other voices break up.`;
    out.push({ key: 'loss', group: 'call', severity, say, ...(severity === 'ok' ? {} : { guide: 'wifi' }) });
  }
  if (finite(r.rttMs)) {
    const severity = tier(r.rttMs, RTT_MS);
    const say = `Your round trip to the call server is ${duration(r.rttMs)}${severity === 'ok' ? ', which is fine.' : '; under 150 milliseconds is normal.'}`;
    out.push({ key: 'rtt', group: 'call', severity, say, ...(severity === 'ok' ? {} : { guide: 'wifi' }) });
  }
  if (finite(r.jitterMs)) {
    const severity = tier(r.jitterMs, JITTER_MS);
    const say = severity === 'ok' ? `Call audio jitter is ${duration(r.jitterMs)}, which is fine.` : `Your call audio jitter is ${duration(r.jitterMs)}, so sound arrives unevenly.`;
    out.push({ key: 'jitter', group: 'call', severity, say, ...(severity === 'ok' ? {} : { guide: 'wifi' }) });
  }
  const quality = [
    { side: 'upload', q: r.uplink },
    { side: 'download', q: r.downlink },
  ].filter((x): x is { side: string; q: number } => finite(x.q) && x.q >= 1 && x.q <= 6);
  if (quality.length) {
    const worst = quality.reduce((a, b) => (b.q > a.q ? b : a));
    const severity: Severity = worst.q >= 5 ? 'bad' : worst.q === 4 ? 'warn' : 'ok';
    const say = severity === 'ok' ? 'The call rates your network quality as good.' : `The call rates your ${worst.side} as ${QUALITY_WORD[worst.q]}.`;
    out.push({ key: 'quality', group: 'call', severity, say, ...(severity === 'ok' ? {} : { guide: 'wifi' }) });
  }
  return out;
}

function devices(r: DiagnosticResults, focus: DiagnosticFocus): Draft[] {
  const out: Draft[] = [];
  if (r.micMuted === true) {
    out.push({ key: 'mic', group: 'mic', severity: 'warn', say: 'Your microphone is muted on this call; unmute it with the microphone button on this page.' });
  } else if (finite(r.micLevel)) {
    // Silence while the agent waits is normal, so it only counts for sound problems.
    if (r.micLevel >= SILENT_MIC) out.push({ key: 'mic', group: 'mic', severity: 'ok', say: 'Your microphone is picking up sound.' });
    else if (focus === 'audio' || focus === 'calls') {
      out.push({ key: 'mic', group: 'mic', severity: 'warn', say: 'Your microphone picked up almost no sound while I checked, so it may be using the wrong input.', guide: 'meeting-audio' });
    }
  }
  if (finite(r.outputs)) {
    out.push(
      r.outputs > 0
        ? { key: 'speakers', group: 'speakers', severity: 'ok', say: `Your browser sees ${unit(Math.round(r.outputs), 'audio output')}.` }
        : { key: 'speakers', group: 'speakers', severity: 'bad', say: "Your browser can't see any speaker or headphones.", guide: 'meeting-audio' },
    );
  }
  if (r.camera === 'denied') {
    out.push({ key: 'camera', group: 'camera', severity: 'warn', say: 'Camera access is blocked for this browser.', guide: 'meeting-video' });
  } else if (r.camera) {
    out.push({ key: 'camera', group: 'camera', severity: 'ok', say: 'Camera access is not blocked.' });
  }
  return out;
}

function clock(r: DiagnosticResults, focus: DiagnosticFocus): Draft[] {
  if (!finite(r.clockSkewSec)) return [];
  const s = r.clockSkewSec;
  if (Math.abs(s) <= CLOCK_SKEW_SEC) {
    return [{ key: 'clock', group: 'clock', severity: 'ok', say: Math.abs(s) < 1 ? 'Your laptop clock is exactly right.' : `Your laptop clock is within ${span(s)} of the server.` }];
  }
  const say = `Your laptop clock is ${span(s)} ${s > 0 ? 'ahead' : 'behind'}. Sign-in fails when the clock is more than two minutes off, so turn on Set time and date automatically in System Settings, General, Date and Time.`;
  return [{ key: 'clock', group: 'clock', severity: focus === 'signin' ? 'bad' : 'warn', say }];
}

function battery(r: DiagnosticResults): Draft[] {
  if (!finite(r.batteryPct)) return [];
  const pct = Math.round(r.batteryPct);
  if (pct < LOW_BATTERY && r.charging === false) {
    return [{ key: 'battery', group: 'battery', severity: 'warn', say: `Your battery is at ${pct} percent and not charging, which can slow the laptop down.`, guide: 'battery-drain' }];
  }
  return [{ key: 'battery', group: 'battery', severity: 'ok', say: `Your battery is at ${pct} percent${r.charging ? ' and charging' : ''}.` }];
}

const SEVERITY_RANK: Record<Severity, number> = { bad: 0, warn: 1, ok: 2 };

// One finding per check that could run: relevant ones first, then worst first, then by how telling the check is for the problem.
export function diagnose(r: DiagnosticResults, focus: DiagnosticFocus): Finding[] {
  const groups = FOCUS_GROUPS[focus];
  const order = (g: CheckGroup) => (groups.includes(g) ? groups.indexOf(g) : groups.length + CHECK_GROUPS.indexOf(g));
  const drafts = [...internet(r, focus), ...call(r), ...devices(r, focus), ...clock(r, focus), ...battery(r)];
  return drafts
    .map((d, i) => ({ f: { ...d, relevant: groups.includes(d.group) }, i }))
    .sort((a, b) => Number(b.f.relevant) - Number(a.f.relevant) || SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || order(a.f.group) - order(b.f.group) || a.i - b.i)
    .map(({ f }) => f);
}

const MAX_SITES_IN = 64;
const YEAR_SEC = 365 * 86400;

const clamp = (v: unknown, lo: number, hi: number, int = false) => (finite(v) ? Math.min(hi, Math.max(lo, int ? Math.trunc(v) : v)) : undefined);
const oneOf = <T extends string>(v: unknown, options: readonly T[]) => (options.includes(v as T) ? (v as T) : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const label = (v: unknown) => (typeof v === 'string' ? v.replace(/[^\w .\-/]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || undefined : undefined);

function parseSites(v: unknown): SiteCheck[] | undefined | null {
  if (!Array.isArray(v)) return undefined;
  if (v.length > MAX_SITES_IN) return null;
  const out: SiteCheck[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const { site, ok, ms } = raw as Record<string, unknown>;
    if (!Object.hasOwn(SITES, site as string) || typeof ok !== 'boolean' || out.some((s) => s.site === site)) continue;
    const time = clamp(ms, 0, 60_000);
    out.push({ site: site as SiteKey, ok, ...(time === undefined ? {} : { ms: time }) });
  }
  return out;
}

// Strict copy of a browser post: known keys only, numbers finite and clamped, labels short. Null when it is not a results object.
export function parseResults(raw: unknown): DiagnosticResults | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const sites = parseSites(r.sites);
  if (sites === null) return null;
  const parsed: DiagnosticResults = {
    online: bool(r.online),
    lossUpPct: clamp(r.lossUpPct, 0, 100),
    lossDownPct: clamp(r.lossDownPct, 0, 100),
    rttMs: clamp(r.rttMs, 0, 60_000),
    jitterMs: clamp(r.jitterMs, 0, 60_000),
    uplink: clamp(r.uplink, 0, 6, true),
    downlink: clamp(r.downlink, 0, 6, true),
    sites,
    micLevel: clamp(r.micLevel, 0, 1),
    micMuted: bool(r.micMuted),
    outputs: clamp(r.outputs, 0, 64, true),
    camera: oneOf(r.camera, CAMERA_STATES),
    clockSkewSec: clamp(r.clockSkewSec, -YEAR_SEC, YEAR_SEC),
    netType: oneOf(r.netType, NET_TYPES),
    netDownlinkMbps: clamp(r.netDownlinkMbps, 0, 10_000),
    netRttMs: clamp(r.netRttMs, 0, 60_000),
    batteryPct: clamp(r.batteryPct, 0, 100),
    charging: bool(r.charging),
    browser: label(r.browser),
    os: label(r.os),
  };
  return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined)) as DiagnosticResults;
}
