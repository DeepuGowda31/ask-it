import { describe, expect, it } from 'vitest';
import { SNOOZE_MS, answerFollowUp, applyTicketList, isRinging, mergeTickets, snoozeFollowUp } from '@/lib/domain/followup';
import { MINUTE } from '@/lib/domain/time';
import type { SessionState, TicketRecord } from '@/lib/domain/types';
import type { RemoteTicket } from '@/lib/integrations/types';
import { NOW, freshState } from './helpers';

const remoteOf = (t: TicketRecord, change: Partial<RemoteTicket> = {}): RemoteTicket => ({ number: t.number, sysId: t.sysId!, summary: t.summary, state: t.state, urgency: t.urgency, createdAt: t.createdAt, updatedAt: t.updatedAt, ...change });

// Deepak's live tickets: a VPN incident and a monitor request, both open, plus an old resolved one.
function liveState(): SessionState {
  const s = freshState(NOW, { tickets: 'live' });
  s.tickets = [
    { number: 'INC0010013', sysId: 'sn-13', summary: 'GlobalProtect VPN not connecting', state: 'In Progress', urgency: 2, source: 'live', createdAt: NOW - 60 * MINUTE, updatedAt: NOW - 50 * MINUTE },
    { number: 'INC0010011', sysId: 'sn-11', summary: 'Second monitor flickers', state: 'New', urgency: 3, source: 'live', createdAt: NOW - 120 * MINUTE, updatedAt: NOW - 100 * MINUTE },
    { number: 'INC0010002', sysId: 'sn-02', summary: 'Outlook search broken', state: 'Resolved', urgency: 3, source: 'live', createdAt: NOW - 3000 * MINUTE, updatedAt: NOW - 2000 * MINUTE },
  ];
  return s;
}

const list = (s: SessionState, changes: Record<string, Partial<RemoteTicket>> = {}) => s.tickets.map((t) => remoteOf(t, changes[t.number]));
const merged = (s: SessionState, changes: Record<string, Partial<RemoteTicket>>, now = NOW) => {
  const next = structuredClone(s);
  mergeTickets(next, list(s, changes), 'live', now);
  return next;
};

describe('follow-up detection', () => {
  it('rings when a ticket ASK IT last saw open is now resolved', () => {
    const s = merged(liveState(), { INC0010013: { state: 'Resolved', updatedAt: NOW - MINUTE } });
    expect(s.followUp).toEqual({ number: 'INC0010013', summary: 'GlobalProtect VPN not connecting', resolvedAt: NOW - MINUTE, status: 'ringing' });
    expect(s.tickets.find((t) => t.number === 'INC0010013')?.state).toBe('Resolved');
  });
  it('does not ring for tickets that were already resolved, closed, or new to the mirror', () => {
    const s = liveState();
    const next = structuredClone(s);
    mergeTickets(next, [...list(s, { INC0010011: { state: 'Closed' } }), { number: 'INC0010020', sysId: 'sn-20', summary: 'Old thing', state: 'Resolved', urgency: 3, createdAt: NOW - 9000 * MINUTE, updatedAt: NOW - MINUTE }], 'live', NOW);
    expect(next.followUp ?? null).toBeNull();
    expect(next.tickets).toHaveLength(4);
  });
  it('rings when IT resolves a ticket ASK IT once resolved and the caller reopened', () => {
    const s = liveState();
    Object.assign(s.tickets[0], { summary: 'VPN fixed by reinstalling the profile', fixedOnCall: true });
    expect(merged(s, { INC0010013: { state: 'Resolved' } }).followUp).toMatchObject({ number: 'INC0010013', status: 'ringing' });
  });
  it('does not ring for a ticket resolved and reopened between two looks', () => {
    expect(merged(liveState(), { INC0010013: { state: 'In Progress', updatedAt: NOW } }).followUp ?? null).toBeNull();
  });
  it('rings for the most recent of two resolutions and queues the other', () => {
    const s = merged(liveState(), { INC0010013: { state: 'Resolved', updatedAt: NOW - 5 * MINUTE }, INC0010011: { state: 'Resolved', updatedAt: NOW - MINUTE } });
    expect(s.followUp).toMatchObject({ number: 'INC0010011', status: 'ringing' });
    expect(s.followUpLog?.queue.map((f) => f.number)).toEqual(['INC0010013']);
  });
  it('moves to the queued one once the current follow-up was answered and the call is over', () => {
    let s = merged(liveState(), { INC0010013: { state: 'Resolved', updatedAt: NOW - 5 * MINUTE }, INC0010011: { state: 'Resolved', updatedAt: NOW - MINUTE } });
    expect(answerFollowUp(s, 'INC0010011')).toBe(true);
    s.call = { active: true, persona: 'employee', startedAt: NOW };
    s = merged(s, {});
    expect(s.followUp).toMatchObject({ number: 'INC0010011', status: 'answered' });
    s.call = { active: false, endedAt: NOW + MINUTE };
    s = merged(s, {}, NOW + 2 * MINUTE);
    expect(s.followUp).toMatchObject({ number: 'INC0010013', status: 'ringing' });
    expect(s.followUpLog?.queue).toEqual([]);
  });
  it('never rings twice for the same resolution', () => {
    let s = merged(liveState(), { INC0010013: { state: 'Resolved' } });
    answerFollowUp(s, 'INC0010013');
    s = merged(s, { INC0010013: { state: 'In Progress' } });
    s = merged(s, { INC0010013: { state: 'Resolved' } });
    expect(s.followUp).toMatchObject({ number: 'INC0010013', status: 'answered' });
    expect(s.followUpLog?.queue).toEqual([]);
  });
  it('stops ringing when IT reopens or closes the ticket before she answers', () => {
    let s = merged(liveState(), { INC0010013: { state: 'Resolved' } });
    s = merged(s, { INC0010013: { state: 'In Progress' } });
    expect(s.followUp).toBeNull();
    let t = merged(liveState(), { INC0010013: { state: 'Resolved', updatedAt: NOW - 5 * MINUTE }, INC0010011: { state: 'Resolved', updatedAt: NOW - MINUTE } });
    t = merged(t, { INC0010011: { state: 'Closed' } });
    expect(t.followUp).toMatchObject({ number: 'INC0010013', status: 'ringing' });
  });
  it('leaves the state untouched when nothing changed, so no write happens', () => {
    const s = liveState();
    expect(applyTicketList(s, list(s), 'live', NOW)).toBe(s);
    const next = applyTicketList(s, list(s, { INC0010013: { state: 'Resolved' } }), 'live', NOW);
    expect(next).not.toBe(s);
    expect(s.followUp).toBeNull();
    expect(next.followUp?.number).toBe('INC0010013');
  });
  it('works on sessions saved before follow-ups existed', () => {
    const s = liveState() as Partial<SessionState>;
    delete s.followUp;
    delete s.followUpLog;
    expect(merged(s as SessionState, { INC0010013: { state: 'Resolved' } }).followUp?.number).toBe('INC0010013');
  });
});

describe('ringing and snoozing', () => {
  const ringing = () => merged(liveState(), { INC0010013: { state: 'Resolved' } });
  it('rings until snoozed, then again after ten minutes', () => {
    const s = ringing();
    expect(isRinging(s.followUp, NOW)).toBe(true);
    const snoozed = snoozeFollowUp(s, 'INC0010013', NOW)!;
    expect(snoozed.followUp).toMatchObject({ status: 'snoozed', snoozedUntil: NOW + SNOOZE_MS });
    expect(SNOOZE_MS).toBe(10 * MINUTE);
    expect(isRinging(snoozed.followUp, NOW + SNOOZE_MS - 1)).toBe(false);
    expect(isRinging(snoozed.followUp, NOW + SNOOZE_MS)).toBe(true);
    expect(snoozeFollowUp(snoozed, 'INC0010013', NOW + SNOOZE_MS)!.followUp?.snoozedUntil).toBe(NOW + 2 * SNOOZE_MS);
  });
  it('only snoozes the ticket that is ringing', () => {
    expect(snoozeFollowUp(ringing(), 'INC0010011', NOW)).toBeNull();
    expect(snoozeFollowUp(liveState(), 'INC0010013', NOW)).toBeNull();
    const s = ringing();
    answerFollowUp(s, 'INC0010013');
    expect(snoozeFollowUp(s, 'INC0010013', NOW)).toBeNull();
  });
  it('never rings for an answered follow-up or none', () => {
    const s = ringing();
    expect(answerFollowUp(s, 'INC0010011')).toBe(false);
    expect(answerFollowUp(s, 'INC0010013')).toBe(true);
    expect(isRinging(s.followUp, NOW)).toBe(false);
    expect(answerFollowUp(s, 'INC0010013')).toBe(false);
    expect(isRinging(null, NOW)).toBe(false);
    expect(isRinging(undefined, NOW)).toBe(false);
  });
});

describe('the live list is the source of truth', () => {
  it('drops tickets ServiceNow no longer returns, but keeps records never saved there', () => {
    const s = liveState();
    s.tickets.push({ number: 'LOCAL-1', sysId: null, summary: 'Password reset', state: 'Resolved', urgency: 3, source: 'live', createdAt: NOW - MINUTE, updatedAt: NOW - MINUTE });
    const next = applyTicketList(s, list(s).filter((t) => t.number !== 'INC0010011' && t.number !== 'LOCAL-1'), 'live', NOW);
    expect(next.tickets.map((t) => t.number).sort()).toEqual(['INC0010002', 'INC0010013', 'LOCAL-1']);
  });
  it('keeps everything when the list comes from the simulated desk', () => {
    const s = liveState();
    expect(applyTicketList(s, list(s).slice(0, 1), 'simulated', NOW).tickets).toHaveLength(3);
  });
});
