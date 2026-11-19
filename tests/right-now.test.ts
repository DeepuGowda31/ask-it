import { describe, expect, it } from 'vitest';
import { buildSessionView } from '@/lib/domain/view';
import { MINUTE } from '@/lib/domain/time';
import { rightNow, ticketCatalog } from '@/lib/client/right-now';
import { markDelivery } from '@/lib/domain/actions';
import { failure } from '@/lib/integrations/http';
import { beginTool } from '@/lib/domain/tools';
import { recordDiagnostics } from '@/lib/domain/tools/diagnostics';
import { NOW, call, codeOf, freshState } from './helpers';

const MODES = { tickets: 'simulated', identity: 'simulated', notify: 'simulated', status: 'live' } as const;
const view = (s: ReturnType<typeof freshState>, now = NOW) => buildSessionView(s, now, 1, MODES);

describe('rightNow', () => {
  it('is empty before anything happens', () => {
    expect(rightNow(view(freshState()), NOW)).toBeNull();
  });

  it('shows the current guided-fix step with progress', async () => {
    let s = (await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: 'drops' })).state;
    s = (await call(s, 'reportStep', { outcome: 'not_fixed', note: '' })).state;
    const r = rightNow(view(s), NOW);
    expect(r).toMatchObject({ kind: 'fix', step: 2, done: 1, title: expect.stringMatching(/^VPN/), text: expect.any(String), check: expect.any(String) });
    expect(r?.kind === 'fix' && r.total).toBeGreaterThan(2);
  });

  it('puts the email code ahead of the guided fix', async () => {
    let s = (await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: '' })).state;
    s = (await call(s, 'verifyIdentity', {}, { code: '421987' })).state;
    expect(rightNow(view(s), NOW)).toEqual({ kind: 'verify', email: 'priya.sharma@nimbuslabs.example', attemptsLeft: 3, simulatedCode: '421987' });
  });

  it('puts a waiting yes ahead of everything, until it expires', async () => {
    let s = (await call(freshState(), 'verifyIdentity', {}, { code: '421987' })).state;
    const prep = await call(s, 'prepareTicket', { summary: 'Dock broken', urgency: 'low', details: '' });
    s = prep.state;
    expect(rightNow(view(s), NOW)).toMatchObject({ kind: 'confirm', summary: 'Raise a low-urgency ticket: Dock broken', warnings: [] });
    expect(codeOf(prep.result)).toBeTruthy();
    expect(rightNow(view(s, NOW + 30 * MINUTE), NOW + 30 * MINUTE)?.kind).not.toBe('confirm');
  });

  it('reports a fix that worked', async () => {
    let s = (await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: '' })).state;
    s = (await call(s, 'reportStep', { outcome: 'fixed', note: '' })).state;
    expect(rightNow(view(s), NOW)).toMatchObject({ kind: 'outcome', tone: 'ok', title: 'Fixed on the call' });
  });

  it('reports the ticket a failed fix became', async () => {
    let s = (await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: '' })).state;
    s = { ...s, troubleshooting: { ...s.troubleshooting!, status: 'ticketed', ticket: 'INC0012001' } };
    expect(rightNow(view(s), NOW)).toMatchObject({ kind: 'outcome', tone: 'warn', title: 'Ticket INC0012001 raised' });
  });
});

describe('rightNow after a lockdown', () => {
  async function lockedDown(o: Parameters<typeof call>[3] = {}) {
    const prep = await call(freshState(), 'prepareSecurityLockdown', { what: 'laptop left in an Uber', when: '' });
    return { prep, done: await call(prep.state, 'confirmAction', { code: codeOf(prep.result) }, o) };
  }

  it('shows the usual confirm card while waiting for the yes', async () => {
    const { prep } = await lockedDown();
    expect(rightNow(view(prep.state), NOW)).toMatchObject({ kind: 'confirm', summary: 'Lock down your account: laptop left in an Uber' });
  });

  it('shows a checklist and the incident number once it ran', async () => {
    const { done } = await lockedDown();
    expect(rightNow(view(done.state), NOW)).toEqual({
      kind: 'lockdown',
      incident: 'INC0012001',
      failed: 0,
      steps: [
        { label: 'Block account', status: 'ok' },
        { label: 'Sign out everywhere', status: 'ok' },
        { label: 'Revoke saved sign-ins', status: 'ok' },
        { label: 'Reset MFA', status: 'ok' },
        { label: 'Raise P1 incident', status: 'ok' },
        { label: 'Alert IT security', status: 'pending' },
      ],
    });
  });

  it('marks failed steps and follows the IT channel delivery', async () => {
    const { done } = await lockedDown({ identity: { endSessions: async () => failure({ kind: 'timeout' }) }, tickets: { create: async () => failure({ kind: 'unavailable', status: 503 }) } });
    const sent = markDelivery(done.state, done.alerts[0].id, { ok: false, error: 'Slack could not be reached.' });
    const r = rightNow(view(sent), NOW);
    expect(r).toMatchObject({ kind: 'lockdown', incident: null, failed: 3 });
    expect(r?.kind === 'lockdown' && r.steps.map((s) => s.status)).toEqual(['ok', 'failed', 'ok', 'ok', 'failed', 'failed']);
    const delivered = markDelivery(done.state, done.alerts[0].id, { ok: true, channel: 'slack' });
    expect(rightNow(view(delivered), NOW)).toMatchObject({ failed: 2 });
  });

  it('gives way to a newer guided fix and to an email code', async () => {
    const { done } = await lockedDown();
    const fix = (await call(done.state, 'startTroubleshooting', { articleId: 'vpn', issue: '' }, { now: NOW + 1 })).state;
    expect(rightNow(view(fix), NOW + 1)?.kind).toBe('fix');
    const code = (await call(done.state, 'verifyIdentity', {}, { code: '421987' })).state;
    expect(rightNow(view(code), NOW)?.kind).toBe('verify');
  });
});

describe('ticketCatalog', () => {
  it('knows employee tickets, the read-out queue, the open incident and outages', () => {
    const v = view(freshState());
    const desk = { queue: [{ number: 'INC0010011', summary: 'Payroll export failing', stateLabel: 'In Progress' }], current: { number: 'INC0010003', summary: 'Sales floor VPN down', stateLabel: 'New' } };
    const c = ticketCatalog(v, desk);
    expect(c.get('INC0011994')).toEqual({ summary: v.tickets[0].summary, status: v.tickets[0].state });
    expect(c.get('INC0010011')).toEqual({ summary: 'Payroll export failing', status: 'In Progress' });
    expect(c.get('INC0010003')).toEqual({ summary: 'Sales floor VPN down', status: 'New' });
    expect(c.get('INC0011950')).toEqual({ summary: v.outages[0].title, status: 'Outage' });
  });
});

describe('rightNow during a laptop check', () => {
  const requested = (s = freshState(), now = NOW) => beginTool('runDiagnostics', s, { focus: 'calls' }, now, 'claim-1')!;
  const done = (s: ReturnType<typeof requested>, now = NOW + 2000) =>
    recordDiagnostics(s, s.diagnostics!.id, { lossUpPct: 14, rttMs: 45, sites: [{ site: 'slack', ok: true, ms: 100 }], outputs: 2, camera: 'denied' }, now).state;
  const PENDING = ['Internet', 'Call connection', 'Microphone', 'Speakers', 'Camera', 'Clock', 'Battery'].map((label) => ({ label, status: 'pending' }));

  it('shows every check as pending while the browser runs them', () => {
    expect(rightNow(view(requested()), NOW)).toEqual({ kind: 'diagnostics', status: 'running', rows: PENDING, top: null });
  });

  it('shows each check and the top finding once the results are in', () => {
    const r = rightNow(view(done(requested())), NOW);
    expect(r).toEqual({
      kind: 'diagnostics',
      status: 'done',
      rows: [
        { label: 'Internet', status: 'ok' },
        { label: 'Call connection', status: 'bad' },
        { label: 'Microphone', status: 'unavailable' },
        { label: 'Speakers', status: 'ok' },
        { label: 'Camera', status: 'warn' },
        { label: 'Clock', status: 'unavailable' },
        { label: 'Battery', status: 'unavailable' },
      ],
      top: { severity: 'bad', say: expect.stringMatching(/^You're losing 14 percent/) },
    });
  });

  it('marks every check unavailable when the browser never answered', () => {
    const s = requested();
    const timedOut = { ...s, diagnostics: { ...s.diagnostics!, status: 'timeout' as const } };
    const r = rightNow(view(timedOut), NOW);
    expect(r).toMatchObject({ kind: 'diagnostics', status: 'timeout', top: null });
    expect(r?.kind === 'diagnostics' && r.rows.every((row) => row.status === 'unavailable')).toBe(true);
  });

  it('runs ahead of a guided fix and a lockdown, but behind a waiting yes and an email code', async () => {
    const fix = (await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: '' })).state;
    expect(rightNow(view(requested(fix, NOW + 1)), NOW + 1)?.kind).toBe('diagnostics');
    const prep = await call(freshState(), 'prepareSecurityLockdown', { what: 'laptop left in an Uber', when: '' });
    const locked = (await call(prep.state, 'confirmAction', { code: codeOf(prep.result) })).state;
    expect(rightNow(view(requested(locked, NOW + 1)), NOW + 1)?.kind).toBe('diagnostics');
    const waiting = (await call(requested(), 'prepareTicket', { summary: 'Dock broken', urgency: 'low', details: '' })).state;
    expect(rightNow(view(waiting), NOW)?.kind).toBe('confirm');
    const code = (await call(requested(), 'verifyIdentity', {}, { code: '421987' })).state;
    expect(rightNow(view(code), NOW)?.kind).toBe('verify');
  });

  it('gives way to a guided fix started after it', async () => {
    const checked = done(requested());
    const fix = (await call(checked, 'startTroubleshooting', { articleId: 'wifi', issue: '' }, { now: NOW + 3000 })).state;
    expect(rightNow(view(fix, NOW + 3000), NOW + 3000)?.kind).toBe('fix');
    const older = (await call(freshState(), 'startTroubleshooting', { articleId: 'wifi', issue: '' }, { now: NOW - 3000 })).state;
    expect(rightNow(view(done(requested(older))), NOW)?.kind).toBe('diagnostics');
  });
});
