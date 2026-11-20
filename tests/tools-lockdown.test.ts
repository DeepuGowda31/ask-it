import { describe, expect, it, vi } from 'vitest';
import { failure, success, type Failure } from '@/lib/integrations/http';
import { ServiceNowTickets } from '@/lib/integrations/servicenow';
import { beginTool, runTool } from '@/lib/domain/tools';
import { MINUTE } from '@/lib/domain/time';
import type { SessionState } from '@/lib/domain/types';
import { NOW, call, codeOf, freshState } from './helpers';
import { fakeFetch, jsonResponse } from './fakes';

const WHAT = { what: 'laptop left in an Uber', when: 'about an hour ago' };
const UNAVAILABLE: Failure = { kind: 'unavailable', status: 503 };

// Deepak with an active, unlocked account and an authenticator enrolled.
function unlocked() {
  const s = freshState();
  s.account.locked = false;
  return s;
}

async function prepared(state = unlocked(), args: Record<string, string> = WHAT) {
  const prep = await call(state, 'prepareSecurityLockdown', args);
  return { state: prep.state, code: codeOf(prep.result), prep };
}

// Every outbound lockdown call, in the order made.
function recorder(fail: Partial<Record<string, Failure>> = {}) {
  const log: string[] = [];
  const step = (name: string) => vi.fn(async () => {
    log.push(name);
    return fail[name] ? failure<null>(fail[name]) : success(null);
  });
  const identity = { block: step('block'), endSessions: step('endSessions'), revokeRefreshTokens: step('revokeRefreshTokens'), lifecycle: step('lifecycle') };
  const create = vi.fn(async () => {
    log.push('create');
    return fail.create ? failure<{ number: string; sysId: string }>(fail.create) : success({ number: 'INC0012001', sysId: 's1' });
  });
  return { log, identity, tickets: { create } };
}

describe('prepareSecurityLockdown', () => {
  it('asks for a yes without needing an email code, and calls nothing yet', async () => {
    const r = recorder();
    const out = await call(unlocked(), 'prepareSecurityLockdown', WHAT, r);
    expect(out.status).toBe(200);
    expect(out.result.data).toMatchObject({ status: 'awaiting_confirmation', summary: 'Lock down your account: laptop left in an Uber', warnings: [] });
    expect(out.result.say).toMatch(/block your account.*sign you out.*saved sign-ins.*multi-factor.*urgent security incident.*IT security/);
    expect(out.result.say).toMatch(/no email code/i);
    expect(out.result.next).toMatch(/confirmAction/);
    expect(out.state.pending[0]).toMatchObject({ status: 'pending', payload: { kind: 'lockdown', what: 'laptop left in an Uber', when: 'about an hour ago' } });
    expect(r.log).toEqual([]);
  });
  it('needs what happened, but not when', async () => {
    const empty = await call(unlocked(), 'prepareSecurityLockdown', { what: '  ', when: '' });
    expect(empty.result.error).toBe('invalid_arguments');
    expect((await call(unlocked(), 'prepareSecurityLockdown', { what: 'stolen bag', when: '' })).status).toBe(200);
    expect((await call(unlocked(), 'prepareSecurityLockdown', { what: 'x'.repeat(2001), when: '' })).result.error).toBe('invalid_arguments');
  });
  it('keeps very long or odd text off the screen summary and out of what is spoken', async () => {
    const what = `left it (maybe) in a taxi [blue] ${'and then '.repeat(200)}`.trim();
    const { prep, state, code } = await prepared(unlocked(), { what, when: '{yesterday}' });
    expect(prep.result.say).not.toContain('taxi');
    expect(state.pending[0].summary.length).toBeLessThanOrEqual(140);
    const r = recorder();
    const done = await call(state, 'confirmAction', { code }, r);
    const ticket = (r.tickets.create.mock.calls[0] as unknown[])[0] as { shortDescription: string; description: string };
    expect(ticket.shortDescription.length).toBeLessThanOrEqual(160);
    expect(ticket.description).toContain(what);
    expect(ticket.description).toContain('{yesterday}');
    expect(done.status).toBe(200);
  });
});

describe('confirmAction on a lockdown', () => {
  it('runs every step once, in order, and locks the account locally', async () => {
    const { state, code } = await prepared();
    const r = recorder();
    const out = await call(state, 'confirmAction', { code }, r);
    expect(out.status).toBe(200);
    expect(r.log).toEqual(['block', 'endSessions', 'revokeRefreshTokens', 'lifecycle', 'create']);
    expect(r.identity.block).toHaveBeenCalledWith('auth0|sim-deepak');
    expect(r.identity.lifecycle).toHaveBeenCalledWith({ userId: 'auth0|sim-deepak', email: 'deepak.gowda@nimbuslabs.example' }, 'resetMfa');
    expect(r.tickets.create).toHaveBeenCalledWith(expect.objectContaining({ urgency: 1, impact: 1, category: 'hardware', correlationId: `askit:NMB-7K2:${code}`, shortDescription: 'Lost or stolen device: laptop left in an Uber' }));
    expect(out.state.account).toMatchObject({ locked: true, factors: [] });
    expect(out.state.lockdown).toMatchObject({ at: NOW, incident: 'INC0012001', steps: ['block', 'sessions', 'refreshTokens', 'mfa', 'incident'].map((step) => ({ step, ok: true })) });
    expect(out.state.tickets[0]).toMatchObject({ number: 'INC0012001', urgency: 1, state: 'New', raisedHere: true });
    expect(out.state.pending[0].status).toBe('done');
    expect(out.result.say).toBe(
      "Done. Your account is blocked, you're signed out everywhere, saved sign-ins are revoked and your multi-factor sign-in is reset. I raised urgent security incident I-N-C one two zero zero one. The IT channel alert is simulated because no webhook is set up. Getting back in later needs the usual email verification.",
    );
    expect(out.result.data).toMatchObject({ incident: 'INC0012001', failed: [] });
  });
  it('alerts the IT channel once with the incident on a fresh card', async () => {
    const { state, code } = await prepared();
    const out = await call(state, 'confirmAction', { code }, { ...recorder(), notifyMode: 'live' });
    expect(out.alerts).toHaveLength(1);
    expect(out.alerts[0].card).toMatchObject({ status: 'escalated', ticket: 'INC0012001', alias: 'INC0012001', title: 'Lost or stolen device: laptop left in an Uber' });
    expect(out.alerts[0].text).toMatch(/^Security lockdown for Deepak Gowda .*: laptop left in an Uber\. P1 incident INC0012001\. All steps done/);
    expect(out.state.lockdown?.alertId).toBe(out.alerts[0].id);
    expect(out.result.say).toMatch(/alerting the IT channel now/);
  });
  it('needs no email verification to lock, but unlocking afterwards still does', async () => {
    const { state, code } = await prepared();
    expect(state.verification.status).toBe('none');
    const done = await call(state, 'confirmAction', { code }, recorder());
    expect(done.status).toBe(200);
    const unlock = await call(done.state, 'prepareAccountAction', { action: 'unlock' });
    expect(unlock.result.error).toBe('verification_required');
  });
  it('drops a verification made before the lockdown, so unlocking needs a fresh email code', async () => {
    let s = unlocked();
    s = (await call(s, 'verifyIdentity')).state;
    s = (await call(s, 'checkIdentity', { code: s.verification.simulatedCode! })).state;
    expect(s.verification.status).toBe('approved');
    const { state, code } = await prepared(s);
    const done = await call(state, 'confirmAction', { code }, recorder());
    expect(done.state.verification).toMatchObject({ status: 'none', approvedAt: null, simulatedCode: null });
    const unlock = await call(done.state, 'prepareAccountAction', { action: 'unlock' });
    expect(unlock.result.error).toBe('verification_required');
  });
  it('still raises the incident in time when Auth0 hangs', async () => {
    vi.useFakeTimers();
    try {
      const { state, code } = await prepared();
      const r = recorder();
      const hang = vi.fn(() => new Promise<never>(() => {}));
      const pending = call(state, 'confirmAction', { code }, { identity: { ...r.identity, block: hang }, tickets: r.tickets });
      await vi.advanceTimersByTimeAsync(4500);
      const out = await pending;
      expect(r.log).toEqual(['create']);
      expect(out.state.lockdown?.incident).toBe('INC0012001');
      expect(out.state.lockdown?.steps.filter((s) => !s.ok).map((s) => s.step)).toEqual(['block', 'sessions', 'refreshTokens', 'mfa']);
      expect(out.result.say).toMatch(/^Done: I raised urgent security incident I-N-C one two zero zero one\. These did not work: blocking your account.* Auth0 did not answer in time\./);
    } finally {
      vi.useRealTimers();
    }
  });
  it('still runs every step when the account is already locked', async () => {
    const { state, code } = await prepared(freshState());
    expect(state.account.locked).toBe(true);
    const r = recorder();
    const out = await call(state, 'confirmAction', { code }, r);
    expect(r.log).toHaveLength(5);
    expect(out.state.account.locked).toBe(true);
  });

  const FAILED_SAY: Record<string, RegExp> = {
    block: /did not work: blocking your account\./,
    endSessions: /did not work: signing you out everywhere\./,
    revokeRefreshTokens: /did not work: revoking saved sign-ins\./,
    lifecycle: /did not work: resetting your multi-factor sign-in\./,
    create: /did not work: raising the security incident\./,
  };
  it.each(Object.keys(FAILED_SAY))('keeps going after %s fails and names it', async (name) => {
    const { state, code } = await prepared();
    const r = recorder({ [name]: UNAVAILABLE });
    const out = await call(state, 'confirmAction', { code }, r);
    expect(r.log).toEqual(['block', 'endSessions', 'revokeRefreshTokens', 'lifecycle', 'create']);
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('lockdown_incomplete');
    expect(out.result.say).toMatch(FAILED_SAY[name]);
    expect(out.result.say).toMatch(name === 'create' ? /ServiceNow is having problems right now/ : /Auth0 is having problems right now/);
    expect(out.result.say).toMatch(/IT security will finish that by hand/);
    expect(out.state.lockdown?.steps.filter((s) => !s.ok)).toHaveLength(1);
    expect(out.state.account.locked).toBe(name !== 'block');
    expect(out.state.account.factors).toEqual(name === 'lifecycle' ? ['otp'] : []);
    expect(out.state.lockdown?.incident).toBe(name === 'create' ? null : 'INC0012001');
    expect(out.state.pending[0].status).toBe('done');
    expect(out.alerts).toHaveLength(1);
  });
  it('reports every failure in plain words when nothing works', async () => {
    const { state, code } = await prepared();
    const r = recorder({ block: { kind: 'unauthorized', status: 403 }, endSessions: UNAVAILABLE, revokeRefreshTokens: UNAVAILABLE, lifecycle: UNAVAILABLE, create: { kind: 'rejected', status: 400 } });
    const out = await call(state, 'confirmAction', { code }, r);
    expect(out.result.error).toBe('lockdown_failed');
    expect(out.result.say).toBe(
      'None of the lockdown steps went through: blocking your account, signing you out everywhere, revoking saved sign-ins, resetting your multi-factor sign-in and raising the security incident. Auth0 refused our credentials. Auth0 is having problems right now. ServiceNow rejected the request. The IT channel alert is simulated because no webhook is set up. IT security will finish those by hand.',
    );
    expect(out.state.account).toMatchObject({ locked: false, factors: ['otp'] });
    expect(out.state.tickets.filter((t) => t.raisedHere)).toEqual([]);
    expect(out.alerts[0].text).toMatch(/Failed: block account, end sessions, revoke refresh tokens, reset MFA, P1 incident\. Finish by hand\./);
  });
  it('skips the account calls when the account cannot be read, and still raises the incident', async () => {
    const { state, code } = await prepared();
    const r = recorder();
    const getUser = vi.fn(async () => failure({ kind: 'timeout' }));
    const out = await call(state, 'confirmAction', { code }, { identity: { ...r.identity, mode: 'live', getUser }, tickets: r.tickets });
    expect(r.log).toEqual(['create']);
    expect(out.result.say).toMatch(/^Done: I raised urgent security incident I-N-C one two zero zero one\. These did not work: blocking your account, signing you out everywhere, revoking saved sign-ins and resetting your multi-factor sign-in\. Auth0 did not answer in time\./);
    expect(out.state.account.locked).toBe(false);
  });
  it('says an incident may exist when ServiceNow times out', async () => {
    const { state, code } = await prepared();
    const out = await call(state, 'confirmAction', { code }, recorder({ create: { kind: 'timeout' } }));
    expect(out.result.say).toMatch(/raising the security incident\. ServiceNow did not answer in time, so the incident may still have been raised\./);
    expect(out.state.lockdown?.steps.at(-1)).toEqual({ step: 'incident', ok: false, reason: 'ServiceNow did not answer in time, so the incident may still have been raised.' });
  });
  it('finds the incident by correlation id when the create answer is lost', async () => {
    const { state, code } = await prepared();
    const f = fakeFetch((url, init) => {
      if (url.includes('sys_user')) return jsonResponse({ result: [{ sys_id: 'usr-1' }] });
      if (init.method === 'POST') throw new TypeError('socket hang up');
      return jsonResponse({ result: [{ number: 'INC0019999', sys_id: 'abc' }] });
    });
    const sn = new ServiceNowTickets({ instanceUrl: 'https://nimbus.service-now.example', user: 'u', password: 'p', callerEmail: 'e@x', closeCode: 'c' }, { fetch: f.fetch }, new Map());
    const out = await call(state, 'confirmAction', { code }, { tickets: { mode: 'live', create: (t) => sn.create(t) } });
    expect(out.status).toBe(200);
    expect(out.state.lockdown?.incident).toBe('INC0019999');
    expect(new URL(f.calls.at(-1)!.url).searchParams.get('sysparm_query')).toBe(`correlation_id=askit:NMB-7K2:${code}`);
  });
  it('never repeats a step on a second confirm, even after a partial failure', async () => {
    const { state, code } = await prepared();
    const first = recorder({ endSessions: UNAVAILABLE });
    const done = await call(state, 'confirmAction', { code }, first);
    const again = recorder();
    const second = await call(done.state, 'confirmAction', { code }, again);
    expect(again.log).toEqual([]);
    expect(second.status).toBe(200);
    expect(second.result.data).toMatchObject({ alreadyDone: true });
    expect(second.result.say).toMatch(/^That was already done, nothing changed\. Done: your account is blocked/);
    expect(second.alerts).toEqual([]);
    expect(second.state.lockdown).toEqual(done.state.lockdown);
    expect(second.state.tickets.filter((t) => t.number === 'INC0012001')).toHaveLength(1);
  });
  it('lets only one of two concurrent confirms run the steps', async () => {
    const { state, code } = await prepared();
    const claimed = beginTool('confirmAction', state, { code }, NOW, 'A')!;
    expect(beginTool('confirmAction', claimed, { code }, NOW, 'B')).toBeNull();
    const loser = recorder();
    const lost = await call(claimed, 'confirmAction', { code }, { ...loser, claim: 'B' });
    expect(lost.result.error).toBe('in_progress');
    expect(loser.log).toEqual([]);
    const winner = recorder();
    expect((await call(claimed, 'confirmAction', { code }, { ...winner, claim: 'A' })).status).toBe(200);
    expect(winner.log).toHaveLength(5);
  });
  it('does nothing after a cancel or once the confirmation expired', async () => {
    const { state, code } = await prepared();
    const cancelled = await call(state, 'cancelAction', { code });
    const r = recorder();
    expect((await call(cancelled.state, 'confirmAction', { code }, r)).result.error).toBe('action_cancelled');
    const late = await call(state, 'confirmAction', { code }, { ...r, now: NOW + 5 * MINUTE + 1 });
    expect(late.result.error).toBe('action_expired');
    expect(r.log).toEqual([]);
    expect(late.state.lockdown ?? null).toBeNull();
  });
  it('releases the claim when the effect never ran', async () => {
    const { state, code } = await prepared();
    const claimed = beginTool('confirmAction', state, { code }, NOW, 'A')!;
    const out = runTool('confirmAction', claimed, { code }, NOW, undefined, 'A');
    expect(out.result.error).toBe('try_again');
    expect(out.state.pending[0].status).toBe('pending');
  });
});

describe('wrapUpCall after a lockdown', () => {
  it('lists the lockdown among the account actions', async () => {
    const { state, code } = await prepared();
    const done = await call(state, 'confirmAction', { code }, recorder());
    const out = await call(done.state, 'wrapUpCall');
    expect(out.result.say).toMatch(/security lockdown/);
    expect(out.state.documents[0].markdown).toMatch(/security lockdown/);
  });
  it('never calls a lockdown done when its steps failed', async () => {
    const { state, code } = await prepared();
    const all = { block: UNAVAILABLE, endSessions: UNAVAILABLE, revokeRefreshTokens: UNAVAILABLE, lifecycle: UNAVAILABLE, create: UNAVAILABLE };
    const failedAll = await call(state, 'confirmAction', { code }, recorder(all));
    const none = await call(failedAll.state, 'wrapUpCall');
    expect(none.result.say).toMatch(/Security lockdown failed/);
    expect(none.state.documents[0].markdown).toMatch(/- security lockdown failed/);
    const partly = await call(state, 'confirmAction', { code }, recorder({ endSessions: UNAVAILABLE }));
    expect((await call(partly.state, 'wrapUpCall')).result.say).toMatch(/security lockdown, partly done/);
  });
});

describe('lockdown on sessions saved before it existed', () => {
  it('works when the state has no lockdown field', async () => {
    const s = unlocked() as Partial<SessionState>;
    delete s.lockdown;
    const { state, code } = await prepared(s as SessionState);
    expect((await call(state, 'confirmAction', { code }, recorder())).status).toBe(200);
  });
});
