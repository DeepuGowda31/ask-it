import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginTool, runTool, toolAllowed } from '@/lib/domain/tools';
import { DIAGNOSTICS_WAIT_MS, recordDiagnostics } from '@/lib/domain/tools/diagnostics';
import type { DiagnosticResults } from '@/lib/domain/diagnose';
import type { SessionState } from '@/lib/domain/types';
import { executeTool } from '@/lib/server/execute';
import { createSession, loadSession, updateSession } from '@/lib/server/session';
import { MemoryStore } from '@/lib/server/store';
import { NOW, call, freshState, makeDeps } from './helpers';

afterEach(() => vi.useRealTimers());

const HEALTHY: DiagnosticResults = {
  online: true,
  lossUpPct: 0,
  lossDownPct: 0.4,
  rttMs: 45,
  jitterMs: 6,
  uplink: 1,
  downlink: 1,
  sites: [
    { site: 'slack', ok: true, ms: 120 },
    { site: 'github', ok: true, ms: 180 },
    { site: 'google', ok: true, ms: 90 },
    { site: 'microsoft', ok: true, ms: 210 },
  ],
  micLevel: 0.2,
  micMuted: false,
  outputs: 2,
  camera: 'granted',
  clockSkewSec: 2,
  batteryPct: 64,
  charging: false,
};

const requested = (focus = 'calls', state = freshState()) => beginTool('runDiagnostics', state, { focus }, NOW, 'claim-1')!;

// The browser's post lands while the tool waits; the tool then reads it from the store.
async function diagnosed(results: DiagnosticResults, focus = 'calls') {
  const begun = requested(focus);
  const posted = recordDiagnostics(begun, begun.diagnostics!.id, results, NOW + 2000).state;
  return call(begun, 'runDiagnostics', { focus }, { reload: async () => posted });
}

describe('runDiagnostics request', () => {
  it('records a request the browser can pick up before it waits', () => {
    expect(requested('signin').diagnostics).toEqual({ id: 'DX-101', focus: 'signin', status: 'requested', requestedAt: NOW });
  });
  it('joins a request still in flight instead of starting another', () => {
    const begun = requested();
    expect(beginTool('runDiagnostics', begun, { focus: 'calls' }, NOW + 1000, 'claim-2')).toBeNull();
  });
  it('starts a fresh run after a finished one, or after one that was abandoned', () => {
    const begun = requested();
    const done = recordDiagnostics(begun, 'DX-101', HEALTHY, NOW + 1000).state;
    expect(requested('network', done).diagnostics).toMatchObject({ id: 'DX-102', focus: 'network', status: 'requested' });
    const stuck = beginTool('runDiagnostics', begun, { focus: 'calls' }, NOW + 60_000, 'claim-3')!;
    expect(stuck.diagnostics).toMatchObject({ id: 'DX-102', status: 'requested', requestedAt: NOW + 60_000 });
  });
  it('rejects an unknown focus and is for employees only', async () => {
    const out = await call(freshState(), 'runDiagnostics', { focus: 'printer' });
    expect(out.result.error).toBe('invalid_arguments');
    expect(out.state.diagnostics).toBeNull();
    expect(toolAllowed('runDiagnostics', 'employee')).toBe(true);
    expect(toolAllowed('runDiagnostics', 'itdesk')).toBe(false);
  });
});

describe('runDiagnostics result', () => {
  it('speaks the top two findings with numbers, then the matching guide', async () => {
    const out = await diagnosed({ ...HEALTHY, lossUpPct: 14, rttMs: 420 });
    expect(out.status).toBe(200);
    expect(out.result.say).toBe(
      "You're losing 14 percent of your call audio on the way out, so your voice breaks up. Your round trip to the call server is 0.42 seconds; under 150 milliseconds is normal. The guide \"Office Wi-Fi not connecting\" should help. Shall we go through it?",
    );
    expect(out.result.next).toMatch(/startTroubleshooting with articleId wifi/);
    const data = out.result.data as { focus: string; guide: string; findings: unknown[] };
    expect(data).toMatchObject({ focus: 'calls', guide: 'wifi' });
    expect(data.findings.slice(0, 2)).toMatchObject([{ key: 'loss', severity: 'bad' }, { key: 'rtt', severity: 'warn' }]);
    expect(out.state.diagnostics).toMatchObject({ status: 'done' });
    expect(out.state.events.at(-1)).toMatchObject({ tool: 'runDiagnostics', ok: true, title: 'Laptop check · calls · 2 issues' });
  });
  it('says so when everything is fine and suggests the guide for the problem', async () => {
    const out = await diagnosed(HEALTHY, 'audio');
    expect(out.result.say).toBe(
      'Everything I could check looks fine. Your microphone is picking up sound. So the problem is probably not your connection or laptop. Shall we go through "Zoom or Teams audio not working"?',
    );
    expect(out.result.next).toMatch(/articleId meeting-audio/);
    expect(out.state.events.at(-1)?.title).toBe('Laptop check · audio · all fine');
  });
  it('gives the fix itself when no guide covers it', async () => {
    const out = await diagnosed({ ...HEALTHY, clockSkewSec: -400 }, 'signin');
    expect(out.result.say).toMatch(/^Your laptop clock is 7 minutes behind\. Sign-in fails .* Date and Time\.$/);
    expect(out.result.next).toMatch(/Ask whether that fixed it/);
    expect(out.result.data).toMatchObject({ guide: null });
  });
  it('is honest when the browser gave no readings', async () => {
    const out = await diagnosed({}, 'network');
    expect(out.result).toMatchObject({ ok: false, error: 'checks_unavailable' });
    expect(out.result.say).toBe('Your browser could not give me any readings for that, so I can\'t tell from here. Shall we go through "Office Wi-Fi not connecting" instead?');
    expect(out.state.events.at(-1)?.title).toBe('Laptop check · network · no readings');
  });
  it('times out honestly when the browser never answers, and records it', async () => {
    vi.useFakeTimers({ now: NOW });
    const begun = requested('general');
    const reload = vi.fn(async () => begun);
    const pending = call(begun, 'runDiagnostics', { focus: 'general' }, { reload });
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_WAIT_MS + 500);
    const out = await pending;
    expect(out.result).toMatchObject({ ok: false, error: 'checks_unavailable' });
    expect(out.result.say).toBe('I couldn\'t run the checks from your browser just now, so let\'s go through the steps together instead. Shall we start "Laptop running slow"?');
    expect(out.result.next).toMatch(/articleId slow-laptop/);
    expect(out.state.diagnostics).toMatchObject({ id: 'DX-101', status: 'timeout' });
    expect(reload.mock.calls.length).toBeGreaterThan(20);
    expect(reload.mock.calls.length).toBeLessThan(40);
  });
  it('keeps the result when the post lands just as the wait ends', async () => {
    const begun = requested();
    const posted = recordDiagnostics(begun, 'DX-101', HEALTHY, NOW + 6000).state;
    const out = runTool('runDiagnostics', posted, { focus: 'calls' }, NOW, 'DX-101', 'claim-1');
    expect(out.state.diagnostics?.status).toBe('done');
    expect(out.result.say).toMatch(/^Everything I could check looks fine\./);
  });
});

describe('recordDiagnostics', () => {
  it('accepts the first result for the current request and stores findings', () => {
    const begun = requested();
    const out = recordDiagnostics(begun, 'DX-101', { ...HEALTHY, lossUpPct: 14 }, NOW + 2000);
    expect(out.outcome).toBe('accepted');
    expect(out.state.diagnostics).toMatchObject({ status: 'done', doneAt: NOW + 2000, results: { lossUpPct: 14 } });
    expect(out.state.diagnostics?.findings?.[0]).toMatchObject({ key: 'loss', severity: 'bad' });
    expect(begun.diagnostics?.status).toBe('requested');
  });
  it('ignores a second result for the same request', () => {
    const begun = requested();
    const first = recordDiagnostics(begun, 'DX-101', HEALTHY, NOW + 1000).state;
    const again = recordDiagnostics(first, 'DX-101', { lossUpPct: 90 }, NOW + 1200);
    expect(again).toEqual({ state: first, outcome: 'duplicate' });
  });
  it('rejects a wrong id, no request, and a stale or timed-out request', () => {
    const begun = requested();
    expect(recordDiagnostics(begun, 'DX-999', HEALTHY, NOW).outcome).toBe('unknown');
    expect(recordDiagnostics(freshState(), 'DX-101', HEALTHY, NOW).outcome).toBe('unknown');
    expect(recordDiagnostics(begun, 'DX-101', HEALTHY, NOW + DIAGNOSTICS_WAIT_MS + 5000).outcome).toBe('expired');
    const timedOut: SessionState = { ...begun, diagnostics: { ...begun.diagnostics!, status: 'timeout' } };
    expect(recordDiagnostics(timedOut, 'DX-101', HEALTHY, NOW + 1000)).toEqual({ state: timedOut, outcome: 'expired' });
  });
});

describe('runDiagnostics through the server', () => {
  it('persists the request first, then answers as soon as the browser posts', async () => {
    const store = new MemoryStore();
    const code = await createSession(store, NOW);
    const started = Date.now();
    const pending = executeTool(code, 'runDiagnostics', { focus: 'network' }, { makeDeps, store });
    let id: string | undefined;
    while (!id) {
      await new Promise((r) => setTimeout(r, 20));
      const d = (await loadSession(store, code))!.state.diagnostics;
      if (d?.status === 'requested') id = d.id;
    }
    await updateSession(store, code, (s) => recordDiagnostics(s, id!, { ...HEALTHY, sites: [{ site: 'slack', ok: false }, ...HEALTHY.sites!.slice(1)] }, Date.now()));
    const out = await pending;
    expect(Date.now() - started).toBeLessThan(1500);
    expect(out.status).toBe(200);
    expect(out.result.say).toMatch(/^Slack did not answer from your browser, though GitHub, Google and Microsoft sign-in did\./);
    const { state } = (await loadSession(store, code))!;
    expect(state.diagnostics).toMatchObject({ id, status: 'done' });
    expect(state.events).toHaveLength(1);
  });
});

describe('runDiagnostics picks the guide from what they said', () => {
  const HOME = "I'm working from home on my phone hotspot and the internet is not working";
  async function told(results: DiagnosticResults, focus: string, problem: string) {
    const begun = beginTool('runDiagnostics', freshState(), { focus, problem }, NOW, 'claim-1')!;
    const posted = recordDiagnostics(begun, begun.diagnostics!.id, results, NOW + 2000).state;
    return call(begun, 'runDiagnostics', { focus, problem }, { reload: async () => posted });
  }
  it('offers the home guide, not office Wi-Fi, for someone at home', async () => {
    expect((await told(HEALTHY, 'network', HOME)).result.say).toMatch(/Shall we go through "Home Wi-Fi or hotspot has no internet"\?$/);
    expect((await told({}, 'network', HOME)).result.say).toMatch(/"Home Wi-Fi or hotspot has no internet" instead\?$/);
  });
  it('keeps the usual guide without their words, or when their words point elsewhere', async () => {
    expect((await told(HEALTHY, 'network', '')).result.say).toMatch(/"Office Wi-Fi not connecting"\?$/);
    expect((await told(HEALTHY, 'network', 'my printer keeps jamming')).result.say).toMatch(/"Office Wi-Fi not connecting"\?$/);
  });
});
