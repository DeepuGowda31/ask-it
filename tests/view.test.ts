import { describe, expect, it } from 'vitest';
import { buildSessionView, displayEvent } from '@/lib/domain/view';
import { DAY, MINUTE } from '@/lib/domain/time';
import { NOW, call, codeOf, confirmed, freshState } from './helpers';

const LIVE = { tickets: 'simulated', identity: 'simulated', notify: 'simulated', status: 'live' } as const;

describe('session view', () => {
  it('shows the seed for both screens without internal ids', () => {
    const v = buildSessionView(freshState(), NOW, 1, LIVE);
    expect(v.version).toBe(1);
    expect(v.employee.name).toBe('Priya Sharma');
    expect(v.account).toEqual({ email: 'priya.sharma@nimbuslabs.example', locked: true, lastPasswordReset: expect.any(Number), factors: ['otp'], factorsKnown: true, source: 'simulated', checkedAt: null });
    expect(v.tickets.map((t) => t.number)).toEqual(['INC0011994', 'INC0011987']);
    expect(v.tickets[0]).not.toHaveProperty('sysId');
    expect(v.tickets.map((t) => t.open)).toEqual([true, false]);
    expect(v.outages[0]).toMatchObject({ incident: 'INC0011950', affected: 14 });
    expect(v.kpis).toEqual({ resolvedByAgent: 0, ticketsRaised: 0, duplicatesAvoided: 0, accountActions: 0, ticketsUpdatedByVoice: 0, minutesSaved: 0, toolCalls: 0, deflectionRate: null });
    expect(v.integrations).toEqual(LIVE);
    expect(v.pending).toBeNull();
    expect(v.troubleshooting).toBeNull();
  });
  it('shows the simulated inbox only while a code is pending', async () => {
    const sent = (await call(freshState(), 'verifyIdentity', {}, { code: '421987' })).state;
    expect(buildSessionView(sent, NOW, 2, LIVE).verification).toEqual({ status: 'pending', sentAt: NOW, approvedAt: null, expiresAt: null, attemptsLeft: 3, simulatedInbox: { code: '421987', sentAt: NOW } });
    expect(buildSessionView(sent, NOW + 6 * MINUTE, 2, LIVE).verification).toMatchObject({ status: 'expired', simulatedInbox: null });
    const ok = (await call(sent, 'checkIdentity', { code: '421987' })).state;
    expect(buildSessionView(ok, NOW, 3, LIVE).verification).toMatchObject({ status: 'approved', expiresAt: NOW + 10 * MINUTE, simulatedInbox: null });
    expect(buildSessionView(ok, NOW + 11 * MINUTE, 3, LIVE).verification.status).toBe('expired');
  });
  it('turns the guided fix into a checklist', async () => {
    let s = (await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: 'drops' })).state;
    s = (await call(s, 'reportStep', { outcome: 'not_fixed', note: '' })).state;
    s = (await call(s, 'reportStep', { outcome: 'skipped', note: '' })).state;
    const t = buildSessionView(s, NOW, 4, LIVE).troubleshooting!;
    expect(t).toMatchObject({ articleId: 'vpn', status: 'active', issue: 'drops' });
    expect(t.steps.map((x) => x.state)).toEqual(['failed', 'skipped', 'current', 'todo', 'todo']);
    expect(t.steps[0]).toMatchObject({ number: 1, text: expect.stringMatching(/GlobalProtect/), check: expect.stringMatching(/\?$/) });
  });
  it('computes deflection and shows the waiting confirmation', async () => {
    let s = (await confirmed(freshState(), 'followOutage', { incident: '' })).state;
    s = (await confirmed(s, 'markResolved', { summary: 'Printer fixed' })).state;
    const prep = await call(s, 'prepareTicket', { summary: 'Dock broken', urgency: 'low', details: '' });
    s = (await call(prep.state, 'confirmAction', { code: codeOf(prep.result) })).state;
    const prep2 = await call(s, 'prepareTicket', { summary: 'Mouse broken', urgency: 'low', details: '' });
    const v = buildSessionView(prep2.state, NOW, 5, LIVE);
    expect(v.kpis).toMatchObject({ resolvedByAgent: 1, duplicatesAvoided: 1, ticketsRaised: 1, deflectionRate: 2 / 3 });
    expect(v.pending).toMatchObject({ kind: 'ticket', summary: 'Raise a low-urgency ticket: Mouse broken', warnings: [] });
    expect(v.events[0]).toMatchObject({ tool: 'prepareTicket', action: { status: 'pending' } });
    expect(v.notifications.map((n) => n.kind)).toContain('ticketRaised');
  });
});

describe('employee view and the IT desk', () => {
  it('keeps IT desk confirmations off the employee screen', async () => {
    let s = (await call(freshState(), 'openIncident', { ticket: '13001' })).state;
    s = (await call(s, 'prepareIncidentUpdate', { ticket: '', assignedTo: 'David Dan', assignmentGroup: '', state: '', holdReason: '', urgency: '', impact: '', category: '', workNote: '', comment: '', resolutionNotes: '' })).state;
    const v = buildSessionView(s, NOW, 1, LIVE);
    expect(v.pending).toBeNull();
    expect(v.events[0]).toMatchObject({ tool: 'prepareIncidentUpdate', persona: 'itdesk' });
  });
});

describe('top issues', () => {
  const issues = (s: ReturnType<typeof freshState>, now = NOW) => buildSessionView(s, now, 1, LIVE).topIssues;

  it('classifies the seeded tickets by guide, newest first', () => {
    expect(issues(freshState())).toEqual([
      { topic: 'Install or request software', count: 1, status: 'ticket', at: NOW - DAY },
      { topic: 'Outlook not syncing email or calendar', count: 1, status: 'closed', at: NOW - 5 * DAY },
    ]);
  });
  it('counts a guided fix and its ticket once, with the latest outcome', async () => {
    let s = (await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: 'drops' })).state;
    expect(issues(s)[0]).toEqual({ topic: expect.stringMatching(/^VPN/), count: 1, status: 'open', at: NOW });
    s = (await call(s, 'reportStep', { outcome: 'fixed', note: '' })).state;
    s = (await confirmed(s, 'markResolved', { summary: 'Reconnected the tunnel' })).state;
    expect(issues(s).filter((i) => i.topic.startsWith('VPN'))).toEqual([{ topic: expect.stringMatching(/^VPN/), count: 1, status: 'fixed', at: NOW }]);
  });
  it('ranks repeated topics first', async () => {
    let s = (await confirmed(freshState(), 'markResolved', { summary: 'Printer queue cleared' }, { now: NOW - 2 * DAY })).state;
    const prep = await call(s, 'prepareTicket', { summary: 'Printer paper jam on floor 3', urgency: 'low', details: '' });
    s = (await call(prep.state, 'confirmAction', { code: codeOf(prep.result) })).state;
    expect(issues(s)[0]).toEqual({ topic: "Can't print to an office printer", count: 2, status: 'ticket', at: NOW });
  });
  it('shows followed outages and done account actions', async () => {
    let s = (await confirmed(freshState(), 'followOutage', { incident: '' })).state;
    s = (await call(s, 'verifyIdentity', {})).state;
    s = (await call(s, 'checkIdentity', { code: '421987' })).state;
    const prep = await call(s, 'prepareAccountAction', { action: 'unlock' });
    s = (await call(prep.state, 'confirmAction', { code: codeOf(prep.result) })).state;
    const topics = issues(s);
    expect(topics).toContainEqual({ topic: 'SAP Concur', count: 1, status: 'outage', at: NOW - 95 * MINUTE });
    expect(topics).toContainEqual({ topic: 'Password expired or account locked out', count: 1, status: 'fixed', at: NOW });
  });
  it('keeps at most five topics', () => {
    const s = freshState();
    const words = ['VPN drops', 'Wi-Fi down', 'Printer jam', 'Laptop slow', 'Zoom audio', 'Disk full'];
    s.tickets = words.map((summary, i) => ({ number: `INC00${i}`, sysId: null, summary, state: 'New', urgency: 3, source: 'simulated', createdAt: NOW - i, updatedAt: NOW - i }));
    expect(issues(s).map((i) => i.topic)).toHaveLength(5);
  });
});

describe('displayEvent', () => {
  const base = { ok: true, title: 'Raise ticket' };
  it('follows the action status', () => {
    expect(displayEvent({ ...base, action: null }, NOW)).toEqual({ status: 'ok', title: 'Raise ticket' });
    expect(displayEvent({ ...base, ok: false, action: null }, NOW).status).toBe('failed');
    expect(displayEvent({ ...base, action: { status: 'pending', expiresAt: NOW + 1 } }, NOW)).toEqual({ status: 'pending', title: 'Waiting for yes: Raise ticket' });
    expect(displayEvent({ ...base, action: { status: 'committing', expiresAt: NOW + 1 } }, NOW).status).toBe('pending');
    expect(displayEvent({ ...base, action: { status: 'pending', expiresAt: NOW - 1 } }, NOW).status).toBe('expired');
    expect(displayEvent({ ...base, action: { status: 'done', expiresAt: NOW - 1 } }, NOW).status).toBe('confirmed');
    expect(displayEvent({ ...base, action: { status: 'cancelled', expiresAt: NOW } }, NOW).status).toBe('cancelled');
  });
  it('keeps a discard neutral', () => {
    expect(displayEvent({ ok: true, title: 'Discarded: Raise ticket', tool: 'cancelAction', action: null }, NOW)).toEqual({ status: 'neutral', title: 'Discarded: Raise ticket' });
    expect(displayEvent({ ok: false, title: 'Cancel: no such code', tool: 'cancelAction', action: null }, NOW).status).toBe('failed');
  });
});
