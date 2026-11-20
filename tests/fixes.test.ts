import { describe, expect, it, vi } from 'vitest';
import { failure, success } from '@/lib/integrations/http';
import type { NewTicket } from '@/lib/integrations/types';
import { mergeTickets } from '@/lib/domain/followup';
import { beginTool } from '@/lib/domain/tools';
import type { SessionState } from '@/lib/domain/types';
import { buildSessionView } from '@/lib/domain/view';
import { createSession, loadSession, updateSession } from '@/lib/server/session';
import { MemoryStore } from '@/lib/server/store';
import { logCallFixes } from '@/lib/server/fixes';
import { NOW, call, codeOf, confirmed, freshState, makeDeps } from './helpers';

async function verified(state = freshState()) {
  const sent = await call(state, 'verifyIdentity', {}, { code: '421987' });
  return (await call(sent.state, 'checkIdentity', { code: '421987' })).state;
}

// A password reset done on the call, not yet logged as fixed.
async function afterReset(state?: SessionState) {
  return (await confirmed(await verified(state), 'prepareAccountAction', { action: 'resetPassword' })).state;
}

const created = (n = 'INC0012001') => vi.fn(async (_t: NewTicket) => success({ number: n, sysId: `sys-${n}` }));

describe('a fix made on the call leaves one resolved record', () => {
  it('logs a password reset that ends with markResolved once, with the reset in the record', async () => {
    const create = created();
    const s = await afterReset();
    expect(s.accountFix).toMatchObject({ actions: ['resetPassword'], status: 'open' });
    expect(s.metrics.resolvedByAgent).toBe(0);
    const out = await confirmed(s, 'markResolved', { summary: 'Password reset and sign-in works' }, { tickets: { create } });
    expect(create).toHaveBeenCalledTimes(1);
    const t = create.mock.calls[0][0];
    expect(t).toMatchObject({ shortDescription: 'Password reset and sign-in works', category: 'inquiry', correlationId: expect.stringMatching(/^askit:NMB-7K2:fix\d+$/) });
    expect(t.resolution?.notes).toBe('Resolved on the call by ASK IT. Password reset and sign-in works. Steps that worked. Password reset link sent.');
    expect(t.description).toMatch(/Account action on the call was password reset link sent\./);
    expect(out.state.tickets[0]).toMatchObject({ summary: 'Password reset and sign-in works', fixedOnCall: true });
    expect(out.state.accountFix).toMatchObject({ status: 'logged' });
    expect(out.state.metrics.resolvedByAgent).toBe(1);
    const wrap = await call(out.state, 'wrapUpCall', {}, { tickets: { create } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(wrap.result.say).toMatch(/1 issue resolved without IT/);
  });
  it('logs the account action at wrap up when markResolved never came, and only once', async () => {
    const create = created('INC0012009');
    const wrap = await call(await afterReset(), 'wrapUpCall', {}, { tickets: { create } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ shortDescription: 'Password reset', category: 'inquiry', correlationId: expect.stringMatching(/^askit:NMB-7K2:fix\d+$/) });
    expect(create.mock.calls[0][0].resolution?.notes).toBe('Resolved on the call by ASK IT. Password reset link sent. The call ended before sign-in was confirmed.');
    expect(wrap.state.tickets[0]).toMatchObject({ number: 'INC0012009', state: 'Resolved', raisedHere: true });
    expect(wrap.state.metrics.resolvedByAgent).toBe(1);
    expect(wrap.state.lastResolution).toMatchObject({ number: 'INC0012009' });
    expect(wrap.result.say).toMatch(/1 issue resolved without IT/);
    expect(wrap.state.documents[0].markdown).toMatch(/INC0012009 Password reset/);
    await call(wrap.state, 'wrapUpCall', {}, { tickets: { create } });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('puts two account actions on the same call into one record', async () => {
    const create = created();
    let s = (await confirmed(await verified(), 'prepareAccountAction', { action: 'unlock' })).state;
    s = (await confirmed(s, 'prepareAccountAction', { action: 'resetPassword' })).state;
    await call(s, 'wrapUpCall', {}, { tickets: { create } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].shortDescription).toBe('Account unlocked and password reset');
  });
  it('records nothing when no account action succeeded', async () => {
    const create = created();
    const s = await verified();
    s.account.locked = false;
    const unneeded = await confirmed(s, 'prepareAccountAction', { action: 'unlock' });
    expect(unneeded.state.accountFix ?? null).toBeNull();
    const failed = await confirmed(await verified(), 'prepareAccountAction', { action: 'resetMfa' }, { identity: { lifecycle: async () => failure({ kind: 'unavailable', status: 503 }) } });
    expect(failed.state.accountFix ?? null).toBeNull();
    await call(failed.state, 'wrapUpCall', {}, { tickets: { create } });
    expect(create).not.toHaveBeenCalled();
  });
  it('lets a markResolved being confirmed own the account action, so wrap up does not log it too', async () => {
    const create = created();
    const prep = await call(await afterReset(), 'markResolved', { summary: 'Sign-in works' });
    const claimed = beginTool('confirmAction', prep.state, { code: codeOf(prep.result) }, NOW, 'A')!;
    expect(claimed.accountFix).toMatchObject({ status: 'logging', claim: 'A' });
    await call(claimed, 'wrapUpCall', {}, { tickets: { create } });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('a fix record ServiceNow did not take', () => {
  const refused = { mode: 'live' as const, create: async () => failure<{ number: string; sysId: string }>({ kind: 'unavailable', status: 503 }) };
  it('is retried once at wrap up, looking for it first, and then carries the real number', async () => {
    const s = (await confirmed(await afterReset(), 'markResolved', { summary: 'Sign-in works' }, { tickets: refused })).state;
    const local = s.tickets[0].number;
    expect(local).toMatch(/^LOCAL-/);
    expect(s.accountFix).toMatchObject({ status: 'logged' });
    const find = vi.fn(async () => success(null));
    const create = created('INC0012044');
    const wrap = await call(s, 'wrapUpCall', {}, { tickets: { mode: 'live', find, create } });
    expect(find).toHaveBeenCalledWith(s.unsyncedFix!.ticket.correlationId);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual(s.unsyncedFix!.ticket);
    expect(wrap.state.tickets.find((t) => t.number === local)).toBeUndefined();
    expect(wrap.state.tickets[0]).toMatchObject({ number: 'INC0012044', sysId: 'sys-INC0012044', state: 'Resolved' });
    expect(wrap.state.tickets[0].syncFailed).toBeUndefined();
    expect(wrap.state.lastResolution).toMatchObject({ number: 'INC0012044' });
    expect(wrap.state.unsyncedFix ?? null).toBeNull();
    expect(wrap.state.metrics.resolvedByAgent).toBe(1);
  });
  it('uses the record an earlier attempt made when it turns up', async () => {
    const s = (await confirmed(await afterReset(), 'markResolved', { summary: 'Sign-in works' }, { tickets: refused })).state;
    const create = created();
    const wrap = await call(s, 'wrapUpCall', {}, { tickets: { mode: 'live', find: async () => success({ number: 'INC0012045', sysId: 'x45' }), create } });
    expect(create).not.toHaveBeenCalled();
    expect(wrap.state.tickets[0]).toMatchObject({ number: 'INC0012045', state: 'Resolved' });
  });
  it('is only retried once, then kept as a local record', async () => {
    const s = (await confirmed(await afterReset(), 'markResolved', { summary: 'Sign-in works' }, { tickets: refused })).state;
    const create = vi.fn(refused.create);
    const wrap = await call(s, 'wrapUpCall', {}, { tickets: { ...refused, find: async () => success(null), create } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(wrap.state.tickets[0]).toMatchObject({ number: expect.stringMatching(/^LOCAL-/), syncFailed: true, state: 'Resolved' });
    expect(wrap.state.unsyncedFix ?? null).toBeNull();
    expect(wrap.state.events.some((e) => /not saved in ServiceNow/.test(e.title))).toBe(true);
    await call(wrap.state, 'wrapUpCall', {}, { tickets: { ...refused, create } });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('logging a fix when the call ends', () => {
  async function stored(state: SessionState) {
    const store = new MemoryStore(() => NOW);
    const code = await createSession(store, NOW);
    await updateSession(store, code, () => ({ state: { ...state, id: code } }));
    return { store, code };
  }
  it('logs an account action the call ended without logging, once', async () => {
    const { store, code } = await stored(await afterReset());
    const create = created('INC0012050');
    const deps = (s: SessionState) => makeDeps(s, NOW, { tickets: { create } });
    await logCallFixes(store, code, NOW, deps);
    await logCallFixes(store, code, NOW, deps);
    expect(create).toHaveBeenCalledTimes(1);
    const s = (await loadSession(store, code))!.state;
    expect(s.tickets[0]).toMatchObject({ number: 'INC0012050', state: 'Resolved' });
    expect(s.accountFix).toMatchObject({ status: 'logged' });
    expect(s.metrics.resolvedByAgent).toBe(1);
    expect(s.events.at(-1)).toMatchObject({ kind: 'call', ok: true, title: 'Logged as resolved by ASK IT, Password reset, INC0012050' });
  });
  it('does nothing when there is nothing to log', async () => {
    const { store, code } = await stored(freshState());
    const create = created();
    await logCallFixes(store, code, NOW, (s) => makeDeps(s, NOW, { tickets: { create } }));
    expect(create).not.toHaveBeenCalled();
  });
});

describe('simulated mode', () => {
  it('adds the record to the simulated desk, so IT sees it resolved today', async () => {
    const out = await confirmed(await afterReset(), 'markResolved', { summary: 'Sign-in works' });
    const number = out.state.tickets[0].number;
    expect(out.state.tickets[0]).toMatchObject({ source: 'simulated', state: 'Resolved' });
    expect(out.state.itdesk.backlog.find((i) => i.number === number)).toMatchObject({ state: '6', stateLabel: 'Resolved', resolvedAt: NOW, caller: 'Deepak Gowda', category: 'inquiry', group: { name: 'Service Desk' } });
    const desk = await call(out.state, 'showDashboard', {});
    expect(desk.state.itdesk.board).toMatchObject({ kind: 'dashboard', resolvedToday: 1 });
    const mine = await call(out.state, 'listMyTickets', { status: 'resolved', period: '' });
    expect((mine.result.data as { tickets: { number: string }[] }).tickets.map((t) => t.number)).toContain(number);
    const v = buildSessionView(mine.state, NOW, 1, { tickets: 'simulated', identity: 'simulated', notify: 'simulated', status: 'live' });
    expect(v.tickets.find((t) => t.number === number)).toMatchObject({ summary: 'Sign-in works', fixedOnCall: true });
    expect(v.tickets.find((t) => t.number === 'INC0011987')).not.toHaveProperty('fixedOnCall');
    expect(v.ticketList?.tickets.find((t) => t.number === number)).toMatchObject({ fixedOnCall: true });
  });
});

describe('follow-ups leave fixes made on the call alone', () => {
  it('never rings for a record made on the call, whether this session made it or lists it for the first time', async () => {
    const out = await confirmed(freshState(NOW, { tickets: 'live' }), 'markResolved', { summary: 'VPN fixed' }, { tickets: { create: created('INC0012001') } });
    const listed = { number: 'INC0012001', sysId: 'sys-INC0012001', summary: 'VPN fixed', state: 'Resolved', urgency: 3 as const, createdAt: NOW, updatedAt: NOW, correlationId: 'askit:NMB-7K2:fix1234' };
    mergeTickets(out.state, [listed], 'live', NOW + 60_000);
    expect(out.state.followUp ?? null).toBeNull();
    const fresh = freshState(NOW, { tickets: 'live' });
    mergeTickets(fresh, [listed], 'live', NOW);
    expect(fresh.followUp ?? null).toBeNull();
    expect(fresh.followUpLog?.queue ?? []).toEqual([]);
    expect(fresh.tickets.find((t) => t.number === 'INC0012001')).toMatchObject({ fixedOnCall: true });
  });
  it('does not confirm or reopen an ASK IT record', async () => {
    const out = await confirmed(freshState(), 'markResolved', { summary: 'Printer fixed' });
    const close = vi.fn(async () => success(null));
    const fix = await call(out.state, 'confirmFix', { ticket: out.state.tickets[0].number, outcome: 'fixed', note: '' }, { tickets: { close } });
    expect(fix.result.error).toBe('askit_fix');
    expect(fix.result.say).toBe('That one was fixed with you on a call, so there is nothing to confirm.');
    expect(close).not.toHaveBeenCalled();
    // Reopened and resolved again by IT, it rings and can be confirmed like any other.
    const s = out.state;
    s.followUpLog = { queue: [], rung: [s.tickets[0].number] };
    const again = await call(s, 'confirmFix', { ticket: s.tickets[0].number, outcome: 'fixed', note: '' }, { tickets: { close } });
    expect(again.result.ok).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
