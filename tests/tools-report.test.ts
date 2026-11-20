import { describe, expect, it } from 'vitest';
import { REPORT_PERIODS, reportStartLine } from '@/lib/domain/report';
import { MINUTE } from '@/lib/domain/time';
import { MemoryStore } from '@/lib/server/store';
import { createSession, loadSession } from '@/lib/server/session';
import { executeTool } from '@/lib/server/execute';
import { NOW, call, freshState, makeDeps } from './helpers';

const report = (period: string, state = freshState(), o: Parameters<typeof call>[3] = {}) => call(state, 'generateReport', { period }, o);

describe('generateReport', () => {
  it('records the request and says it is on its way, naming the kind of report', async () => {
    for (const period of REPORT_PERIODS) {
      const out = await report(period, freshState(), { claim: `id-${period}` });
      expect(out.status).toBe(200);
      expect(out.result.say).toBe(reportStartLine(period));
      expect(out.state.itdesk.report).toEqual({ id: `id-${period}`, period, requestedAt: NOW, status: 'pending' });
    }
    const weekly = await report('last_7_days');
    expect(weekly.result.say).toBe("I'm putting together your weekly report for the last seven days. It'll download in a few seconds. Meanwhile, anything else I can help with?");
    expect(weekly.result.next).toMatch(/carry on/i);
    expect(weekly.state.events.at(-1)).toMatchObject({ tool: 'generateReport', ok: true, title: 'Weekly report requested' });
    expect((await report('today')).state.events.at(-1)?.title).toBe('Daily report requested');
    expect((await report('this_month')).state.events.at(-1)?.title).toBe('Monthly report requested');
  });
  it('asks daily, weekly or monthly instead of guessing when no period was said', async () => {
    const out = await report('');
    expect(out.result).toMatchObject({ ok: false, error: 'period_needed', say: 'Daily, weekly or monthly?' });
    expect(out.state.itdesk.report ?? null).toBeNull();
  });
  it('refuses periods it does not know', async () => {
    expect((await report('quarterly')).result.error).toBe('invalid_arguments');
  });
  it('does not start a second report while one is being put together', async () => {
    const first = await report('last_7_days', freshState(), { claim: 'first' });
    const again = await report('this_month', first.state, { claim: 'second', now: NOW + MINUTE });
    expect(again.result).toMatchObject({ ok: true, say: "I'm still putting together your weekly report. It'll download in a few seconds." });
    expect(again.result.next).toMatch(/monthly/);
    expect(again.state.itdesk.report).toMatchObject({ id: 'first', period: 'last_7_days', status: 'pending' });
    expect(again.state.events.at(-1)?.title).toBe('Weekly report already in progress');
  });
  it('starts a new report once the last one is done, failed, or abandoned', async () => {
    const first = await report('today', freshState(), { claim: 'first' });
    const done = structuredClone(first.state);
    done.itdesk.report!.status = 'ready';
    expect((await report('today', done, { claim: 'second' })).state.itdesk.report).toMatchObject({ id: 'second', status: 'pending' });
    done.itdesk.report!.status = 'failed';
    expect((await report('today', done, { claim: 'third' })).state.itdesk.report?.id).toBe('third');
    // A page that never picked it up leaves it pending; two minutes later it no longer blocks.
    expect((await report('today', first.state, { claim: 'fourth', now: NOW + 2 * MINUTE + 1 })).state.itdesk.report?.id).toBe('fourth');
  });
  it('is for the IT desk only', async () => {
    const store = new MemoryStore();
    const code = await createSession(store, NOW);
    const deps = (s: Parameters<typeof makeDeps>[0], now: number) => makeDeps(s, now);
    expect((await executeTool(code, 'generateReport', { period: 'today' }, { makeDeps: deps, store, persona: 'employee' })).status).toBe(403);
    expect((await loadSession(store, code))!.state.itdesk.report ?? null).toBeNull();
    const it = await executeTool(code, 'generateReport', { period: 'today' }, { makeDeps: deps, store, persona: 'itdesk' });
    expect(it.status).toBe(200);
    const saved = (await loadSession(store, code))!.state.itdesk.report;
    expect(saved).toMatchObject({ period: 'today', status: 'pending' });
    expect(saved?.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
