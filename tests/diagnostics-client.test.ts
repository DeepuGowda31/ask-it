import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectDiagnostics, platform, probeSite, rtcResults, type DiagnosticsEnv } from '@/lib/client/diagnostics';
import { hangingFetch } from './fakes';

afterEach(() => vi.useRealTimers());

describe('rtcResults', () => {
  it('turns Agora counters into loss, round trip, jitter and quality', () => {
    expect(rtcResults({ rtt: 84, sent: { packets: 1000, lost: 140, jitterMs: 12 }, received: { packets: 950, lost: 50 }, quality: { up: 2, down: 4 } })).toEqual({
      rttMs: 84,
      lossUpPct: 14,
      lossDownPct: 5,
      jitterMs: 12,
      uplink: 2,
      downlink: 4,
    });
  });
  it.each([
    ['no stats at all', {}],
    ['too few packets to judge', { sent: { packets: 20, lost: 5 }, received: { packets: 10, lost: 0 } }],
    ['fields the browser does not give', { sent: { packets: 1000 }, received: { lost: 3 } }],
    ['unknown quality and zero round trip', { rtt: 0, quality: { up: 0, down: 0 } }],
    ['broken numbers', { rtt: NaN, sent: { packets: Infinity, lost: -1, jitterMs: NaN }, quality: { up: 9, down: -1 } }],
  ])('reports nothing for %s', (_label, sample) => expect(rtcResults(sample)).toEqual({}));
  it('caps loss at 100 percent', () => {
    expect(rtcResults({ sent: { packets: 100, lost: 500 } })).toEqual({ lossUpPct: 100 });
  });
});

describe('platform', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Chrome', 'macOS'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'Safari', 'macOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', 'Edge', 'Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox', 'Linux'],
  ])('reads %s', (ua, browser, os) => expect(platform(ua)).toEqual({ browser, os }));
  it('leaves out what it cannot tell', () => expect(platform('curl/8')).toEqual({}));
});

describe('probeSite', () => {
  it('measures an opaque answer as reachable, without CORS or cookies', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    expect(await probeSite('https://slack.com', fetchImpl as unknown as typeof fetch)).toEqual({ ok: true, ms: expect.any(Number) });
    expect(fetchImpl).toHaveBeenCalledWith('https://slack.com', expect.objectContaining({ method: 'HEAD', mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal) }));
  });
  it('reports a network error or a timeout as unreachable', async () => {
    expect(await probeSite('https://slack.com', (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch)).toEqual({ ok: false });
    vi.useFakeTimers();
    const pending = probeSite('https://slack.com', hangingFetch());
    await vi.advanceTimersByTimeAsync(2600);
    expect(await pending).toEqual({ ok: false });
  });
});

// A browser where every API exists and answers.
function browser(o: Partial<DiagnosticsEnv> = {}): DiagnosticsEnv {
  let t = 1_000_000;
  return {
    code: 'NMB-7K2',
    now: () => (t += 10),
    fetch: (async (url: string) => (url.startsWith('/api/state') ? new Response('{}', { headers: { date: new Date(1_000_000 - 300_000).toUTCString() } }) : new Response(null))) as unknown as typeof fetch,
    nav: {
      onLine: true,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      connection: { effectiveType: '4g', downlink: 9.5, rtt: 50 },
      mediaDevices: { enumerateDevices: async () => [{ kind: 'audiooutput' }, { kind: 'audiooutput' }, { kind: 'audioinput' }] as MediaDeviceInfo[] },
      permissions: { query: async () => ({ state: 'prompt' }) as PermissionStatus },
      getBattery: async () => ({ level: 0.42, charging: true }),
    },
    probe: { sample: () => ({ rtt: 60, sent: { packets: 500, lost: 0, jitterMs: 4 }, quality: { up: 1, down: 1 } }), mic: { getVolumeLevel: () => 0.3 } },
    micMuted: false,
    canPickOutput: true,
    ...o,
  };
}

describe('collectDiagnostics', () => {
  it('runs every check and reports what the browser gave', async () => {
    vi.useFakeTimers();
    const pending = collectDiagnostics(browser());
    await vi.advanceTimersByTimeAsync(1200);
    const r = await pending;
    expect(r).toMatchObject({
      online: true,
      rttMs: 60,
      lossUpPct: 0,
      jitterMs: 4,
      uplink: 1,
      downlink: 1,
      micLevel: 0.3,
      micMuted: false,
      outputs: 2,
      camera: 'prompt',
      netType: '4g',
      netDownlinkMbps: 9.5,
      netRttMs: 50,
      batteryPct: 42,
      charging: true,
      browser: 'Chrome',
      os: 'macOS',
    });
    expect(r.clockSkewSec).toBeGreaterThanOrEqual(299);
    expect(r.clockSkewSec).toBeLessThanOrEqual(301);
    expect(r.sites?.map((s) => s.site)).toEqual(['slack', 'github', 'google', 'microsoft']);
    expect(r.sites?.every((s) => s.ok)).toBe(true);
  });

  it('reports unavailable checks as missing, never as a made-up value', async () => {
    vi.useFakeTimers();
    const broken = browser({
      fetch: (async () => { throw new TypeError('offline'); }) as typeof fetch,
      nav: { onLine: false, userAgent: '' },
      probe: null,
      canPickOutput: false,
    });
    const pending = collectDiagnostics(broken);
    await vi.advanceTimersByTimeAsync(3000);
    const r = await pending;
    expect(r).toEqual({ online: false, micMuted: false, sites: ['slack', 'github', 'google', 'microsoft'].map((site) => ({ site, ok: false })) });
  });

  it('counts no outputs as unknown where the browser cannot list them', async () => {
    vi.useFakeTimers();
    const env = browser({ canPickOutput: false });
    env.nav.mediaDevices = { enumerateDevices: async () => [] };
    const pending = collectDiagnostics(env);
    await vi.advanceTimersByTimeAsync(1200);
    expect((await pending).outputs).toBeUndefined();
  });

  it('finishes within three seconds even when every API hangs', async () => {
    vi.useFakeTimers();
    const never = <T,>() => new Promise<T>(() => {});
    const hung = browser({
      fetch: hangingFetch(),
      nav: { onLine: true, userAgent: '', mediaDevices: { enumerateDevices: never }, permissions: { query: never }, getBattery: never },
      probe: { sample: () => { throw new Error('client gone'); }, mic: { getVolumeLevel: () => { throw new Error('track closed'); } } },
    });
    let done = false;
    const pending = collectDiagnostics(hung).then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(3000);
    expect(done).toBe(true);
    const r = await pending;
    expect(r).toMatchObject({ online: true, micMuted: false });
    expect(r.sites?.every((s) => !s.ok)).toBe(true);
    expect(r).not.toHaveProperty('clockSkewSec');
    expect(r).not.toHaveProperty('micLevel');
    expect(r).not.toHaveProperty('outputs');
  });
});
