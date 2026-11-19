import { describe, expect, it } from 'vitest';
import { diagnose, parseResults, type DiagnosticFocus, type DiagnosticResults, type Finding } from '@/lib/domain/diagnose';

const ALL_SITES_OK: DiagnosticResults['sites'] = [
  { site: 'slack', ok: true, ms: 120 },
  { site: 'github', ok: true, ms: 180 },
  { site: 'google', ok: true, ms: 90 },
  { site: 'microsoft', ok: true, ms: 210 },
];

const HEALTHY: DiagnosticResults = {
  online: true,
  lossUpPct: 0,
  lossDownPct: 0.4,
  rttMs: 45,
  jitterMs: 6,
  uplink: 1,
  downlink: 2,
  sites: ALL_SITES_OK,
  micLevel: 0.2,
  micMuted: false,
  outputs: 2,
  camera: 'granted',
  clockSkewSec: 2,
  netType: '4g',
  netDownlinkMbps: 10,
  batteryPct: 64,
  charging: false,
  browser: 'Chrome',
  os: 'macOS',
};

const find = (fs: Finding[], key: string) => fs.find((f) => f.key === key);
const severity = (r: DiagnosticResults, key: string, focus: DiagnosticFocus = 'general') => find(diagnose(r, focus), key)?.severity;

describe('diagnose thresholds', () => {
  it.each([
    [{ lossUpPct: 0 }, 'ok'],
    [{ lossUpPct: 2 }, 'ok'],
    [{ lossUpPct: 2.1 }, 'warn'],
    [{ lossUpPct: 5 }, 'warn'],
    [{ lossUpPct: 5.1 }, 'bad'],
    [{ lossDownPct: 14 }, 'bad'],
    [{ lossUpPct: 1, lossDownPct: 3 }, 'warn'],
  ] as const)('packet loss %o is %s', (r, s) => expect(severity(r, 'loss')).toBe(s));

  it.each([
    [150, 'ok'],
    [300, 'ok'],
    [301, 'warn'],
    [600, 'warn'],
    [601, 'bad'],
  ])('round trip of %i ms is %s', (rttMs, s) => expect(severity({ rttMs }, 'rtt')).toBe(s));

  it.each([
    [10, 'ok'],
    [30, 'ok'],
    [31, 'warn'],
    [61, 'bad'],
  ])('jitter of %i ms is %s', (jitterMs, s) => expect(severity({ jitterMs }, 'jitter')).toBe(s));

  it.each([
    [1, 1, 'ok'],
    [3, 2, 'ok'],
    [4, 1, 'warn'],
    [1, 5, 'bad'],
    [6, 6, 'bad'],
    [0, 0, undefined],
    [0, 4, 'warn'],
  ])('network quality up %i down %i is %s', (uplink, downlink, s) => expect(severity({ uplink, downlink }, 'quality')).toBe(s));

  it.each([
    [0, 'ok', 'ok'],
    [120, 'ok', 'ok'],
    [-120, 'ok', 'ok'],
    [121, 'bad', 'warn'],
    [-600, 'bad', 'warn'],
  ] as const)('clock skew of %i s is %s for sign-in and %s otherwise', (clockSkewSec, signin, other) => {
    expect(severity({ clockSkewSec }, 'clock', 'signin')).toBe(signin);
    expect(severity({ clockSkewSec }, 'clock', 'network')).toBe(other);
  });

  it.each([
    [64, false, 'ok'],
    [14, false, 'warn'],
    [5, true, 'ok'],
    [15, false, 'ok'],
  ])('battery at %i%% (charging %s) is %s', (batteryPct, charging, s) => expect(severity({ batteryPct, charging }, 'battery')).toBe(s));

  it.each([
    ['4g', undefined, 'ok'],
    ['3g', undefined, 'warn'],
    ['2g', undefined, 'bad'],
    ['slow-2g', undefined, 'bad'],
    [undefined, 0.6, 'warn'],
    ['4g', 0.6, 'warn'],
    [undefined, 5, 'ok'],
  ] as const)('browser link type %s at %s Mbps is %s', (netType, netDownlinkMbps, s) => expect(severity({ netType, netDownlinkMbps }, 'link')).toBe(s));

  it('flags no speakers, a blocked camera and a muted mic', () => {
    expect(severity({ outputs: 0 }, 'speakers')).toBe('bad');
    expect(severity({ outputs: 1 }, 'speakers')).toBe('ok');
    expect(severity({ camera: 'denied' }, 'camera', 'calls')).toBe('warn');
    expect(severity({ camera: 'prompt' }, 'camera', 'calls')).toBe('ok');
    expect(severity({ micMuted: true, micLevel: 0 }, 'mic', 'network')).toBe('warn');
  });

  it('only calls a silent mic a problem for call and audio problems', () => {
    expect(severity({ micLevel: 0.005 }, 'mic', 'audio')).toBe('warn');
    expect(severity({ micLevel: 0.005 }, 'mic', 'calls')).toBe('warn');
    expect(severity({ micLevel: 0.2 }, 'mic', 'audio')).toBe('ok');
    expect(find(diagnose({ micLevel: 0.005 }, 'network'), 'mic')).toBeUndefined();
    expect(severity({ micLevel: 0.2 }, 'mic', 'network')).toBe('ok');
  });
});

describe('diagnose reachability', () => {
  it('names the services that did not answer', () => {
    const r = { sites: [{ site: 'slack', ok: false }, ...ALL_SITES_OK!.slice(1)] } as DiagnosticResults;
    const f = find(diagnose(r, 'network'), 'sites')!;
    expect(f).toMatchObject({ severity: 'bad', guide: 'dns-captive-portal' });
    expect(f.say).toMatch(/^Slack did not answer from your browser/);
  });
  it('points a blocked Microsoft sign-in at the sign-in guide', () => {
    const r = { sites: [...ALL_SITES_OK!.slice(0, 3), { site: 'microsoft', ok: false }] } as DiagnosticResults;
    expect(find(diagnose(r, 'signin'), 'sites')).toMatchObject({ severity: 'bad', guide: 'sso-loop', say: expect.stringMatching(/^Microsoft sign-in did not answer/) });
  });
  it('treats nothing answering as the internet being down', () => {
    const r: DiagnosticResults = { sites: ALL_SITES_OK!.map((s) => ({ site: s.site, ok: false })) };
    expect(find(diagnose(r, 'network'), 'sites')).toMatchObject({ severity: 'bad', guide: 'wifi', say: expect.stringMatching(/internet connection looks down/) });
  });
  it('warns about a slow service with the time it took', () => {
    const r = { sites: [...ALL_SITES_OK!.slice(1), { site: 'slack', ok: true, ms: 2140 }] } as DiagnosticResults;
    expect(find(diagnose(r, 'network'), 'sites')).toMatchObject({ severity: 'warn', say: expect.stringMatching(/^Slack took 2\.1 seconds to answer/) });
  });
  it('reports healthy reachability with the slowest time', () => {
    expect(find(diagnose({ sites: ALL_SITES_OK }, 'network'), 'sites')).toMatchObject({ severity: 'ok', say: expect.stringMatching(/the slowest in 210 milliseconds/) });
  });
  it('reports offline only when nothing contradicts it', () => {
    expect(find(diagnose({ online: false }, 'network'), 'offline')).toMatchObject({ severity: 'bad', guide: 'wifi' });
    const contradicted = diagnose({ online: false, sites: ALL_SITES_OK }, 'network');
    expect(find(contradicted, 'offline')).toBeUndefined();
    expect(find(contradicted, 'sites')?.severity).toBe('ok');
    expect(find(diagnose({ online: true }, 'network'), 'offline')).toBeUndefined();
  });
  it('does not repeat a dead connection as unreachable services', () => {
    const r: DiagnosticResults = { online: false, sites: ALL_SITES_OK!.map((s) => ({ site: s.site, ok: false })) };
    expect(diagnose(r, 'network').map((f) => f.key)).toEqual(['offline']);
  });
});

describe('diagnose wording', () => {
  it('says the evidence with the number', () => {
    expect(find(diagnose({ lossUpPct: 14.3 }, 'calls'), 'loss')!.say).toBe("You're losing 14 percent of your call audio on the way out, so your voice breaks up.");
    expect(find(diagnose({ lossDownPct: 8 }, 'calls'), 'loss')!.say).toBe("You're losing 8 percent of the call audio coming to you, so other voices break up.");
    expect(find(diagnose({ lossUpPct: 0.4 }, 'calls'), 'loss')!.say).toBe('Packet loss on the call is 0.4 percent, which is fine.');
    expect(find(diagnose({ clockSkewSec: 250 }, 'signin'), 'clock')!.say).toMatch(/^Your laptop clock is 4 minutes ahead\. Sign-in fails/);
    expect(find(diagnose({ clockSkewSec: -3 * 3600 }, 'signin'), 'clock')!.say).toMatch(/^Your laptop clock is 3 hours behind\./);
    expect(find(diagnose({ batteryPct: 8, charging: false }, 'general'), 'battery')!.say).toMatch(/^Your battery is at 8 percent and not charging/);
  });
  it('never says a number that sounds like an error code', () => {
    const r: DiagnosticResults = { rttMs: 450, jitterMs: 520, sites: [{ site: 'slack', ok: true, ms: 480 }] };
    for (const f of diagnose(r, 'network')) expect(f.say).not.toMatch(/\b[45]\d\d\b|[()[\]{}]/);
    expect(find(diagnose(r, 'network'), 'rtt')!.say).toMatch(/0\.45 seconds/);
  });
});

describe('diagnose ranking', () => {
  it('puts the worst relevant finding first', () => {
    const r: DiagnosticResults = { ...HEALTHY, lossUpPct: 14, rttMs: 420, batteryPct: 5 };
    const fs = diagnose(r, 'calls');
    expect(fs.slice(0, 2).map((f) => f.key)).toEqual(['loss', 'rtt']);
    expect(fs[0]).toMatchObject({ severity: 'bad', relevant: true, guide: 'wifi' });
  });
  it('keeps problems outside the focus behind the relevant ones', () => {
    const fs = diagnose({ ...HEALTHY, batteryPct: 5 }, 'network');
    expect(fs[0]).toMatchObject({ relevant: true, severity: 'ok' });
    expect(find(fs, 'battery')).toMatchObject({ severity: 'warn', relevant: false });
  });
  it('ranks the clock first for sign-in', () => {
    expect(diagnose({ ...HEALTHY, clockSkewSec: 400 }, 'signin')[0]).toMatchObject({ key: 'clock', severity: 'bad' });
    expect(diagnose(HEALTHY, 'signin')[0]).toMatchObject({ key: 'clock', severity: 'ok' });
  });
  it('gives one finding per check, all fine for a healthy laptop', () => {
    const fs = diagnose(HEALTHY, 'calls');
    expect(fs.every((f) => f.severity === 'ok')).toBe(true);
    expect(new Set(fs.map((f) => f.key)).size).toBe(fs.length);
    expect(fs.map((f) => f.group)).toEqual(expect.arrayContaining(['internet', 'call', 'mic', 'speakers', 'camera', 'clock', 'battery']));
  });
});

describe('diagnose with missing or broken numbers', () => {
  it('returns nothing when every check was unavailable', () => {
    for (const focus of ['calls', 'network', 'audio', 'signin', 'general'] as const) expect(diagnose({}, focus)).toEqual([]);
  });
  it.each([NaN, Infinity, -Infinity, undefined])('skips a check whose number is %s', (n) => {
    const r = { lossUpPct: n, rttMs: n, jitterMs: n, clockSkewSec: n, batteryPct: n, micLevel: n, outputs: n, uplink: n } as unknown as DiagnosticResults;
    expect(diagnose(r, 'calls')).toEqual([]);
  });
  it('treats an empty site list as unavailable', () => {
    expect(diagnose({ sites: [] }, 'network')).toEqual([]);
  });
});

describe('parseResults', () => {
  it('keeps valid fields and drops unknown keys', () => {
    expect(parseResults({ ...HEALTHY, extra: 'x', __proto__: { polluted: true } })).toEqual(HEALTHY);
  });
  it('rejects anything that is not an object', () => {
    for (const raw of [null, undefined, 'x', 3, [], true]) expect(parseResults(raw)).toBeNull();
  });
  it('clamps numbers into range and drops non-finite ones', () => {
    expect(parseResults({ lossUpPct: -3, lossDownPct: 250, rttMs: 1e12, jitterMs: -1, clockSkewSec: -1e15, batteryPct: 140, micLevel: 7, outputs: 3.7, uplink: 9, downlink: -2, netDownlinkMbps: 1e9 })).toEqual({
      lossUpPct: 0,
      lossDownPct: 100,
      rttMs: 60000,
      jitterMs: 0,
      clockSkewSec: -31536000,
      batteryPct: 100,
      micLevel: 1,
      outputs: 3,
      uplink: 6,
      downlink: 0,
      netDownlinkMbps: 10000,
    });
    expect(parseResults({ rttMs: 'NaN', jitterMs: '12', lossUpPct: null, batteryPct: {} })).toEqual({});
  });
  it('accepts only known enums, booleans and short clean labels', () => {
    expect(parseResults({ camera: 'maybe', netType: '5g', online: 'yes', charging: 1, micMuted: false, browser: 'Chrome <script>', os: 'x'.repeat(200) })).toEqual({ micMuted: false, browser: 'Chrome script', os: 'x'.repeat(40) });
  });
  it('bounds the site list and drops unknown or repeated sites', () => {
    const sites = [
      { site: 'slack', ok: true, ms: 100, extra: 1 },
      { site: 'slack', ok: false },
      { site: 'evil.example', ok: true },
      { site: 'github', ok: 'yes' },
      { site: 'google', ok: false, ms: -5 },
      ...Array.from({ length: 50 }, () => ({ site: 'microsoft', ok: true })),
    ];
    expect(parseResults({ sites })).toEqual({ sites: [{ site: 'slack', ok: true, ms: 100 }, { site: 'google', ok: false, ms: 0 }, { site: 'microsoft', ok: true }] });
    expect(parseResults({ sites: 'slack' })).toEqual({});
    expect(parseResults({ sites: Array.from({ length: 500 }, () => ({ site: 'slack', ok: true })) })).toBeNull();
  });
});
