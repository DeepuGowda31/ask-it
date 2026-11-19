import { SITES, type DiagnosticResults } from '@/lib/domain/diagnose';
import type { AudioLevelSource } from './signal';

// Raw readings from the live Agora client; CallSession fills it from the SDK.
export interface RtcSample {
  // getRTCStats().RTT, ms to Agora's edge.
  rtt?: number;
  // getLocalAudioStats(): sendPackets, sendPacketsLost, sendJitterMs.
  sent?: { packets?: number; lost?: number; jitterMs?: number };
  // getRemoteAudioStats() for the agent: receivePackets, receivePacketsLost.
  received?: { packets?: number; lost?: number };
  // Last "network-quality" event.
  quality?: { up: number; down: number } | null;
}

export interface CallProbe {
  sample(): RtcSample;
  mic: AudioLevelSource | null;
}

interface NavigatorLike {
  onLine?: boolean;
  userAgent?: string;
  connection?: { effectiveType?: string; downlink?: number; rtt?: number };
  mediaDevices?: { enumerateDevices(): Promise<{ kind: string }[]> };
  permissions?: { query(descriptor: { name: string }): Promise<{ state: string }> };
  getBattery?: () => Promise<{ level: number; charging: boolean }>;
}

export interface DiagnosticsEnv {
  code: string;
  now: () => number;
  fetch: typeof fetch;
  nav: NavigatorLike;
  probe: CallProbe | null;
  micMuted: boolean;
  // The browser can list and pick speakers; without it, no outputs means unknown.
  canPickOutput: boolean;
}

const SITE_URLS: Record<keyof typeof SITES, string> = {
  slack: 'https://slack.com',
  github: 'https://github.com',
  google: 'https://www.google.com',
  microsoft: 'https://login.microsoftonline.com',
};
const FETCH_TIMEOUT_MS = 2500;
const API_TIMEOUT_MS = 1000;
const MIC_SAMPLE_MS = 1000;
const MIC_EVERY_MS = 100;
// Fewer packets than about a second of audio say nothing about loss.
const MIN_PACKETS = 50;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolves undefined when `p` fails or takes longer than `ms`.
function within<T>(p: () => Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    Promise.resolve()
      .then(p)
      .then(
        (v) => resolve(v),
        () => resolve(undefined),
      )
      .finally(() => clearTimeout(timer));
  });
}

const lossPct = (lost: unknown, total: number) => (finite(lost) && lost >= 0 && total >= MIN_PACKETS ? Math.min(100, Math.round((lost / total) * 1000) / 10) : undefined);

// Only values the SDK actually gave; zero round trip and quality 0 mean unknown.
export function rtcResults(s: RtcSample): DiagnosticResults {
  const sentPackets = s.sent?.packets;
  const received = s.received?.packets;
  const out: DiagnosticResults = {
    rttMs: finite(s.rtt) && s.rtt > 0 ? s.rtt : undefined,
    lossUpPct: finite(sentPackets) ? lossPct(s.sent?.lost, sentPackets) : undefined,
    lossDownPct: finite(received) && finite(s.received?.lost) ? lossPct(s.received.lost, received + s.received.lost) : undefined,
    jitterMs: finite(s.sent?.jitterMs) && s.sent.jitterMs >= 0 ? s.sent.jitterMs : undefined,
    uplink: s.quality && s.quality.up >= 1 && s.quality.up <= 6 ? s.quality.up : undefined,
    downlink: s.quality && s.quality.down >= 1 && s.quality.down <= 6 ? s.quality.down : undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export function platform(ua: string): { browser?: string; os?: string } {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : undefined;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : undefined;
  return { ...(browser ? { browser } : {}), ...(os ? { os } : {}) };
}

// Any answer, even an opaque one, means the service is reachable. No cookies are sent.
export async function probeSite(url: string, fetchImpl: typeof fetch, now: () => number = Date.now): Promise<{ ok: boolean; ms?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const start = now();
  try {
    await fetchImpl(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: controller.signal });
    return { ok: true, ms: Math.max(0, now() - start) };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// Laptop clock minus the server's Date header, from the midpoint of one same-origin request.
async function clockSkew(env: DiagnosticsEnv): Promise<number | undefined> {
  const start = env.now();
  const res = await env.fetch(`/api/state?session=${encodeURIComponent(env.code)}`, { cache: 'no-store' });
  const server = Date.parse(res.headers.get('date') ?? '');
  if (!finite(server)) return undefined;
  // The header has whole seconds, so the server's moment is half a second later on average.
  return Math.round(((start + env.now()) / 2 - (server + 500)) / 1000);
}

// Peak level over about a second; undefined when the track cannot be read.
async function micPeak(mic: AudioLevelSource): Promise<number | undefined> {
  let peak = 0;
  for (let t = 0; t < MIC_SAMPLE_MS; t += MIC_EVERY_MS) {
    const level = mic.getVolumeLevel();
    if (!finite(level)) return undefined;
    peak = Math.max(peak, level);
    await sleep(MIC_EVERY_MS);
  }
  return peak;
}

async function outputs(env: DiagnosticsEnv): Promise<number | undefined> {
  const list = await env.nav.mediaDevices?.enumerateDevices();
  if (!list) return undefined;
  const n = list.filter((d) => d.kind === 'audiooutput').length;
  return n || env.canPickOutput ? n : undefined;
}

// Runs every check at once, each with its own timeout, so the whole run stays under three seconds.
export async function collectDiagnostics(env: DiagnosticsEnv): Promise<DiagnosticResults> {
  const { nav } = env;
  let rtc: DiagnosticResults = {};
  try {
    rtc = env.probe ? rtcResults(env.probe.sample()) : {};
  } catch {
    // client already left
  }
  const sites = Promise.all(
    (Object.keys(SITE_URLS) as (keyof typeof SITES)[]).map(async (site) => ({ site, ...(await probeSite(SITE_URLS[site], env.fetch, env.now)) })),
  );
  const mic = env.probe?.mic;
  const [siteResults, skew, micLevel, outputCount, camera, battery] = await Promise.all([
    sites,
    within(() => clockSkew(env), FETCH_TIMEOUT_MS),
    mic ? within(() => micPeak(mic), MIC_SAMPLE_MS + 500) : undefined,
    within(() => outputs(env), API_TIMEOUT_MS),
    within(async () => (await nav.permissions?.query({ name: 'camera' }))?.state, API_TIMEOUT_MS),
    within(async () => nav.getBattery?.(), API_TIMEOUT_MS),
  ]);
  const c = nav.connection;
  const results: DiagnosticResults = {
    online: typeof nav.onLine === 'boolean' ? nav.onLine : undefined,
    ...rtc,
    sites: siteResults,
    micLevel,
    micMuted: env.micMuted,
    outputs: outputCount,
    camera: camera === 'granted' || camera === 'denied' || camera === 'prompt' ? camera : undefined,
    clockSkewSec: skew,
    netType: c?.effectiveType === 'slow-2g' || c?.effectiveType === '2g' || c?.effectiveType === '3g' || c?.effectiveType === '4g' ? c.effectiveType : undefined,
    netDownlinkMbps: finite(c?.downlink) ? c.downlink : undefined,
    netRttMs: finite(c?.rtt) ? c.rtt : undefined,
    batteryPct: battery && finite(battery.level) ? Math.round(battery.level * 100) : undefined,
    charging: typeof battery?.charging === 'boolean' ? battery.charging : undefined,
    ...platform(nav.userAgent ?? ''),
  };
  return Object.fromEntries(Object.entries(results).filter(([, v]) => v !== undefined));
}
