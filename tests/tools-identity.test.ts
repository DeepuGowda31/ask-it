import { describe, expect, it, vi } from 'vitest';
import { failure, success } from '@/lib/integrations/http';
import type { SessionState } from '@/lib/domain/types';
import { MINUTE } from '@/lib/domain/time';
import { beginTool, computeEffect, runTool } from '@/lib/domain/tools';
import { NOW, call, codeOf, freshState, makeDeps } from './helpers';

const SAY_SENT = "I've emailed a six-digit code to your work address; read it to me when it arrives.";

async function sent(state = freshState()) {
  return (await call(state, 'verifyIdentity', {}, { code: '421987' })).state;
}

async function verified(state = freshState()) {
  return (await call(await sent(state), 'checkIdentity', { code: '421987' })).state;
}

const visible = (out: { result: unknown; state: SessionState }) => JSON.stringify([out.result, out.state.events]);

describe('verifyIdentity', () => {
  it('emails a code and keeps the simulated code out of everything the agent sees', async () => {
    const out = await call(freshState(), 'verifyIdentity', {}, { code: '421987' });
    expect(out.status).toBe(200);
    expect(out.result.say).toBe(SAY_SENT);
    expect(out.state.verification).toMatchObject({ status: 'pending', sentAt: NOW, attempts: 0, simulatedCode: '421987' });
    expect(visible(out)).not.toMatch(/421987/);
  });
  it('pads simulated codes to six digits', async () => {
    const out = await call(freshState(), 'verifyIdentity', {}, { code: '42' });
    expect(out.state.verification.simulatedCode).toBe('000042');
  });
  it('says what failed when the email cannot be sent', async () => {
    const out = await call(freshState(), 'verifyIdentity', {}, { identity: { mode: 'live', sendCode: async () => failure({ kind: 'unavailable', status: 503 }) } });
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('identity_unavailable');
    expect(out.result.say).toMatch(/Auth0 is having problems right now/);
    expect(out.state.verification.status).toBe('none');
  });
  it('does not send another code while still verified', async () => {
    const sendCode = vi.fn(async () => success(null));
    const out = await call(await verified(), 'verifyIdentity', {}, { identity: { sendCode } });
    expect(sendCode).not.toHaveBeenCalled();
    expect(out.result.say).toMatch(/already verified/i);
  });
});

describe('checkIdentity', () => {
  it.each(['421987', 'four two one 9 8 7', '421-987', '421 987', 'Four, two, one, nine, eight, seven'])('accepts the spoken code "%s"', async (code) => {
    const out = await call(await sent(), 'checkIdentity', { code });
    expect(out.status).toBe(200);
    expect(out.result.data).toMatchObject({ status: 'verified' });
    expect(out.state.verification).toMatchObject({ status: 'approved', approvedAt: NOW, expiresAt: NOW + 10 * MINUTE, simulatedCode: null });
    expect(visible(out)).not.toMatch(/421987|421-987|421 987/);
  });
  it('passes the normalised code to the live check', async () => {
    const verifyCode = vi.fn(async () => success(true));
    await call(await sent(), 'checkIdentity', { code: 'four two one 9 8 7' }, { identity: { verifyCode } });
    expect(verifyCode).toHaveBeenCalledWith('421987');
  });
  it('needs a code to have been sent', async () => {
    const out = await call(freshState(), 'checkIdentity', { code: '421987' });
    expect(out.result.error).toBe('not_started');
  });
  it('rejects malformed codes without using an attempt or calling out', async () => {
    const verifyCode = vi.fn(async () => success(true));
    const out = await call(await sent(), 'checkIdentity', { code: '4219' }, { identity: { verifyCode } });
    expect(out.result.error).toBe('invalid_code');
    expect(out.state.verification.attempts).toBe(0);
    expect(verifyCode).not.toHaveBeenCalled();
  });
  it('allows three wrong attempts, then requires a new code', async () => {
    let s = await sent();
    let out = await call(s, 'checkIdentity', { code: '111111' });
    expect(out.result).toMatchObject({ ok: false, error: 'wrong_code' });
    expect(out.result.say).toMatch(/2 tries left/);
    out = await call(out.state, 'checkIdentity', { code: '222222' });
    expect(out.result.say).toMatch(/1 try left/);
    out = await call(out.state, 'checkIdentity', { code: '333333' });
    expect(out.result.error).toBe('too_many_attempts');
    expect(out.state.verification).toMatchObject({ status: 'failed', attempts: 3, simulatedCode: null });
    s = out.state;
    const verifyCode = vi.fn(async () => success(true));
    const locked = await call(s, 'checkIdentity', { code: '421987' }, { identity: { verifyCode } });
    expect(locked.result.error).toBe('too_many_attempts');
    expect(verifyCode).not.toHaveBeenCalled();
    const fresh = await call(s, 'verifyIdentity', {}, { code: '555555' });
    expect(fresh.state.verification).toMatchObject({ status: 'pending', attempts: 0 });
  });
  it('expires a code five minutes after sending', async () => {
    const verifyCode = vi.fn(async () => success(true));
    const out = await call(await sent(), 'checkIdentity', { code: '421987' }, { now: NOW + 5 * MINUTE + 1, identity: { verifyCode } });
    expect(out.result.error).toBe('code_expired');
    expect(out.state.verification.status).toBe('expired');
    expect(verifyCode).not.toHaveBeenCalled();
  });
  it('never runs more than three checks per code, even in parallel', async () => {
    const verifyCode = vi.fn(async (code: string) => success(code === '421987'));
    let s = await sent();
    const codes = ['111111', '222222', '333333', '444444', '555555', '421987'];
    const claims: string[] = [];
    codes.forEach((code, i) => {
      const next = beginTool('checkIdentity', s, { code }, NOW, `c${i}`);
      if (next) {
        s = next;
        claims.push(`c${i}`);
      }
    });
    expect(claims).toEqual(['c0', 'c1', 'c2']);
    expect(s.verification.attempts).toBe(3);
    const effects = await Promise.all(codes.map((code, i) => computeEffect('checkIdentity', s, { code }, NOW, makeDeps(s, NOW, { identity: { verifyCode } }), `c${i}`)));
    expect(verifyCode).toHaveBeenCalledTimes(3);
    for (const [i, code] of codes.entries()) s = runTool('checkIdentity', s, { code }, NOW, effects[i], `c${i}`).state;
    expect(s.verification).toMatchObject({ status: 'failed', attempts: 3 });
  });
  it('reports Auth0 failures without leaking anything, and refunds the attempt', async () => {
    const out = await call(await sent(), 'checkIdentity', { code: '421987' }, { identity: { verifyCode: async () => failure({ kind: 'network' }) } });
    expect(out.result.error).toBe('identity_unavailable');
    expect(out.result.say).toMatch(/Auth0 could not be reached/);
    expect(out.state.verification.attempts).toBe(0);
  });
});

describe('getAccountStatus', () => {
  it('reads the account and mirrors it', async () => {
    const out = await call(freshState(), 'getAccountStatus', {});
    expect(out.result.say).toMatch(/locked/i);
    expect(out.result.data).toMatchObject({ locked: true, daysSincePasswordReset: 83, mfa: ['otp'] });
    expect(out.state.account.checkedAt).toBe(NOW);
  });
  it('says MFA is unknown rather than missing when the tenant hides it', async () => {
    const s = freshState();
    s.account.factorsKnown = false;
    s.account.factors = [];
    const out = await call(s, 'getAccountStatus', {});
    expect(out.result.say).toMatch(/couldn't read your multi-factor methods/);
    expect(out.result.say).not.toMatch(/No multi-factor/);
    expect(out.result.data).toMatchObject({ mfa: null });
  });
  it('reports a missing user', async () => {
    const out = await call(freshState(), 'getAccountStatus', {}, { identity: { mode: 'live', getUser: async () => failure({ kind: 'not_found' }) } });
    expect(out.result.error).toBe('user_not_found');
    expect(out.result.say).toMatch(/couldn't find your account/i);
  });
});

describe('account actions', () => {
  it('refuse without verification and make no calls', async () => {
    const getUser = vi.fn();
    const out = await call(freshState(), 'prepareAccountAction', { action: 'unlock' }, { identity: { getUser } });
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('verification_required');
    expect(getUser).not.toHaveBeenCalled();
    expect(out.state.pending).toHaveLength(0);
  });
  it('refuse once the verification has expired', async () => {
    const out = await call(await verified(), 'prepareAccountAction', { action: 'resetPassword' }, { now: NOW + 10 * MINUTE + 1 });
    expect(out.result.error).toBe('verification_expired');
  });
  it('unlock end to end: verify, prepare, confirm', async () => {
    const lifecycle = vi.fn(async () => success(null));
    const prep = await call(await verified(), 'prepareAccountAction', { action: 'unlock' });
    expect(prep.result.data).toMatchObject({ status: 'awaiting_confirmation' });
    expect(prep.result.next).toMatch(/confirmAction/);
    const done = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) }, { identity: { lifecycle } });
    expect(done.status).toBe(200);
    expect(lifecycle).toHaveBeenCalledWith({ userId: 'auth0|sim-deepak', email: 'deepak.gowda@nimbuslabs.example' }, 'unlock');
    expect(done.state.account.locked).toBe(false);
    expect(done.state.metrics.accountActions).toBe(1);
    expect(done.result.say).toMatch(/unlocked/);
  });
  it('unlock when not locked is a business error with no unlock call', async () => {
    const lifecycle = vi.fn();
    const s = await verified();
    s.account.locked = false;
    const out = await call(s, 'prepareAccountAction', { action: 'unlock' }, { identity: { lifecycle } });
    expect(out.result.error).toBe('not_locked');
    expect(lifecycle).not.toHaveBeenCalled();
  });
  it('report a missing Auth0 user', async () => {
    const out = await call(await verified(), 'prepareAccountAction', { action: 'unlock' }, { identity: { mode: 'live', getUser: async () => failure({ kind: 'not_found' }) } });
    expect(out.result.error).toBe('user_not_found');
  });
  it('keep the action pending when Auth0 fails, so it can be retried', async () => {
    const prep = await call(await verified(), 'prepareAccountAction', { action: 'resetMfa' });
    const code = codeOf(prep.result);
    const out = await call(prep.state, 'confirmAction', { code }, { identity: { lifecycle: async () => failure({ kind: 'unavailable', status: 502 }) } });
    expect(out.status).toBe(422);
    expect(out.result.say).toMatch(/Auth0 is having problems right now.*Nothing changed/);
    expect(out.state.pending[0]).toMatchObject({ status: 'pending' });
    expect(out.state.pending[0].claim).toBeUndefined();
    expect(out.state.metrics.accountActions).toBe(0);
    const retry = await call(out.state, 'confirmAction', { code });
    expect(retry.status).toBe(200);
    expect(retry.state.account.factors).toEqual([]);
  });
  it('send a reset email for resetPassword', async () => {
    const prep = await call(await verified(), 'prepareAccountAction', { action: 'resetPassword' });
    expect(JSON.stringify([prep.result, prep.state.pending, prep.state.events])).not.toMatch(/@/);
    const out = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) });
    expect(out.result.say).not.toMatch(/@/);
    expect(out.result.say).toMatch(/reset link/i);
    expect(out.state.metrics.accountActions).toBe(1);
  });
  it('re-check verification at confirm time', async () => {
    const prep = await call(await verified(), 'prepareAccountAction', { action: 'unlock' }, { now: NOW + 8 * MINUTE });
    const lifecycle = vi.fn();
    const out = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) }, { now: NOW + 10 * MINUTE + 1, identity: { lifecycle } });
    expect(out.result.error).toBe('verification_expired');
    expect(lifecycle).not.toHaveBeenCalled();
  });
});
