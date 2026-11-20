import { describe, expect, it, vi } from 'vitest';
import { beginTool } from '@/lib/domain/tools';
import { mergeTickets } from '@/lib/domain/followup';
import { failure, success } from '@/lib/integrations/http';
import type { RemoteTicket } from '@/lib/integrations/types';
import type { SessionState } from '@/lib/domain/types';
import { MINUTE } from '@/lib/domain/time';
import { NOW, call, codeOf, freshState } from './helpers';

const FIGMA = { number: 'INC0011994', sysId: 'sim-INC0011994' };
const listed = (s: SessionState, state: string, updatedAt = NOW - MINUTE): RemoteTicket[] =>
  s.tickets.filter((t) => t.sysId).map((t) => ({ number: t.number, sysId: t.sysId!, summary: t.summary, state: t.number === FIGMA.number ? state : t.state, urgency: t.urgency, createdAt: t.createdAt, updatedAt: t.number === FIGMA.number ? updatedAt : t.updatedAt }));

// IT resolved the Figma request outside ASK IT and the page is ringing about it.
function ringing(): SessionState {
  const s = freshState();
  mergeTickets(s, listed(s, 'Resolved'), 'simulated', NOW);
  expect(s.followUp).toMatchObject({ number: FIGMA.number, status: 'ringing' });
  return s;
}

const fix = (state: SessionState, args: { ticket?: string; outcome: string; note?: string }, o: Parameters<typeof call>[3] = {}) =>
  call(state, 'confirmFix', { ticket: '', note: '', ...args }, o);

describe('confirmFix', () => {
  it('closes the ticket when she says it works, with her answer as the confirmation', async () => {
    const close = vi.fn(async () => success(null));
    const out = await fix(ringing(), { outcome: 'fixed', note: 'Figma opens fine now' }, { tickets: { close } });
    expect(out.status).toBe(200);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(FIGMA, 'Caller confirmed the fix by voice: Figma opens fine now');
    expect(out.state.tickets.find((t) => t.number === FIGMA.number)).toMatchObject({ state: 'Closed', updatedAt: NOW });
    expect(out.state.followUp).toBeNull();
    expect(out.result.say).toMatch(/closed I-N-C one one nine nine four/);
    expect(out.result.next).toBeUndefined();
    expect(out.state.events.at(-1)).toMatchObject({ tool: 'confirmFix', ok: true, title: 'Closed INC0011994 · caller confirmed the fix' });
  });
  it('writes the plain work note when she gave no words', async () => {
    const close = vi.fn(async () => success(null));
    await fix(ringing(), { ticket: 'I N C 11994', outcome: 'fixed' }, { tickets: { close } });
    expect(close).toHaveBeenCalledWith(FIGMA, 'Caller confirmed the fix by voice');
  });
  it('reopens at high urgency with her words and updates the Slack card when it still fails', async () => {
    const reopen = vi.fn(async () => success(null));
    const out = await fix(ringing(), { outcome: 'not_fixed', note: 'still says no licence' }, { tickets: { reopen }, notifyMode: 'live' });
    expect(out.status).toBe(200);
    expect(reopen).toHaveBeenCalledWith(FIGMA, 'Caller says the fix did not work: still says no licence');
    expect(out.state.tickets.find((t) => t.number === FIGMA.number)).toMatchObject({ state: 'In Progress', urgency: 1 });
    expect(out.state.followUp).toBeNull();
    expect(out.state.followUpLog?.rung).not.toContain(FIGMA.number);
    expect(out.alerts).toHaveLength(1);
    expect(out.alerts[0].card).toMatchObject({ key: FIGMA.number, ticket: FIGMA.number, status: 'reopened', title: 'Figma licence request', person: 'Deepak Gowda', detail: 'Reopened at high urgency, caller says the fix did not work: still says no licence' });
    expect(out.result.say).toMatch(/reopened I-N-C one one nine nine four at high urgency/);
    expect(out.result.say).toMatch(/alerting the IT channel/);
  });
  it('rings again when IT resolves a reopened ticket a second time', async () => {
    const out = await fix(ringing(), { outcome: 'not_fixed', note: '' });
    const s = out.state;
    mergeTickets(s, listed(s, 'Resolved', NOW + MINUTE), 'simulated', NOW + 2 * MINUTE);
    expect(s.followUp).toMatchObject({ number: FIGMA.number, status: 'ringing', resolvedAt: NOW + MINUTE });
  });
  it('commits once when repeated, and says so', async () => {
    const close = vi.fn(async () => success(null));
    const first = await fix(ringing(), { outcome: 'fixed' }, { tickets: { close } });
    const again = await fix(first.state, { ticket: '11994', outcome: 'fixed' }, { tickets: { close } });
    expect(close).toHaveBeenCalledTimes(1);
    expect(again.status).toBe(200);
    expect(again.result.data).toMatchObject({ alreadyDone: true });
    expect(again.result.say).toMatch(/already/);
  });
  it('says it is already recorded when retried for the ticket this call is about', async () => {
    const close = vi.fn(async () => success(null));
    const first = await fix(ringing(), { outcome: 'fixed' }, { tickets: { close } });
    const again = await fix(first.state, { outcome: 'fixed' }, { tickets: { close } });
    expect(close).toHaveBeenCalledTimes(1);
    expect(again.status).toBe(200);
    expect(again.result.data).toMatchObject({ number: FIGMA.number, alreadyDone: true });
  });
  it('lets only one of two parallel calls commit', async () => {
    const s = ringing();
    const claimed = beginTool('confirmFix', s, { ticket: '', outcome: 'fixed', note: '' }, NOW, 'claim-a')!;
    expect(claimed).not.toBeNull();
    expect(beginTool('confirmFix', claimed, { ticket: '', outcome: 'fixed', note: '' }, NOW, 'claim-b')).toBeNull();
    const close = vi.fn(async () => success(null));
    const second = await fix(claimed, { outcome: 'fixed' }, { tickets: { close }, claim: 'claim-b' });
    expect(second.result.error).toBe('in_progress');
    expect(close).not.toHaveBeenCalled();
  });
  it('refuses unknown and local tickets without calling ServiceNow', async () => {
    const close = vi.fn();
    const unknown = await fix(ringing(), { ticket: 'ticket 99999', outcome: 'fixed' }, { tickets: { close } });
    expect(unknown.result.error).toBe('unknown_ticket');
    const none = await fix(freshState(), { outcome: 'fixed' }, { tickets: { close } });
    expect(none.result.error).toBe('unknown_ticket');
    expect(none.result.say).toMatch(/Which ticket/);
    const s = ringing();
    s.tickets.unshift({ number: 'LOCAL-7', sysId: null, summary: 'x', state: 'Resolved', urgency: 2, source: 'simulated', createdAt: NOW, updatedAt: NOW, syncFailed: true });
    expect((await fix(s, { ticket: 'local reference seven', outcome: 'not_fixed' }, { tickets: { close } })).result.error).toBe('not_synced');
    expect(close).not.toHaveBeenCalled();
  });
  it('is honest when ServiceNow will not close it, and keeps the ticket resolved for a retry', async () => {
    const s = ringing();
    const out = await fix(s, { outcome: 'fixed' }, { tickets: { close: async () => failure({ kind: 'unavailable', status: 503 }) } });
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('close_not_synced');
    expect(out.result.say).toMatch(/couldn't close it in ServiceNow: ServiceNow is having problems right now/);
    expect(out.state.tickets.find((t) => t.number === FIGMA.number)?.state).toBe('Resolved');
    expect(out.state.fixChecks ?? []).toEqual([]);
    expect(out.state.followUp).toEqual(s.followUp);
    const retry = await fix(out.state, { outcome: 'fixed' });
    expect(retry.status).toBe(200);
  });
  it('is honest when ServiceNow will not reopen it or does not answer', async () => {
    const rejected = await fix(ringing(), { outcome: 'not_fixed', note: 'x' }, { tickets: { reopen: async () => failure({ kind: 'rejected' }) } });
    expect(rejected.result.error).toBe('reopen_not_synced');
    expect(rejected.result.say).toMatch(/couldn't reopen it in ServiceNow: ServiceNow rejected the request/);
    expect(rejected.alerts).toEqual([]);
    expect(rejected.state.tickets.find((t) => t.number === FIGMA.number)).toMatchObject({ state: 'Resolved', urgency: 3 });
    const slow = await fix(ringing(), { outcome: 'not_fixed', note: 'x' }, { tickets: { reopen: async () => failure({ kind: 'timeout' }) } });
    expect(slow.result.say).toMatch(/not sure/);
    expect(slow.result.next).toMatch(/confirmFix again/);
  });
  it('handles a ticket IT already closed or reopened before she answered', async () => {
    const close = vi.fn();
    const closed = ringing();
    closed.tickets.find((t) => t.number === FIGMA.number)!.state = 'Closed';
    const fine = await fix(closed, { ticket: '11994', outcome: 'fixed' }, { tickets: { close } });
    expect(fine.status).toBe(200);
    expect(fine.result.say).toMatch(/already closed/);
    const broken = await fix(closed, { ticket: '11994', outcome: 'not_fixed', note: 'x' }, { tickets: { close } });
    expect(broken.result.error).toBe('ticket_closed');
    expect(broken.result.next).toMatch(/prepareTicket/);
    const open = await fix(freshState(), { ticket: '11994', outcome: 'fixed' }, { tickets: { close } });
    expect(open.result.error).toBe('ticket_open');
    expect(open.result.say).toMatch(/in progress/);
    expect(close).not.toHaveBeenCalled();
  });
});

describe('what makes a page ring', () => {
  it('listMyTickets during a call notices a resolution too', async () => {
    const s = freshState();
    const out = await call(s, 'listMyTickets', { status: 'all' }, { tickets: { listMine: async () => success(listed(s, 'Resolved')) } });
    expect(out.state.followUp).toMatchObject({ number: FIGMA.number, status: 'ringing' });
  });
  it('the IT desk resolving her ticket by voice rings at once', async () => {
    const s = freshState();
    const row = { ...s.itdesk.backlog[0], number: FIGMA.number, sysId: FIGMA.sysId, summary: 'Figma licence request', state: '2', stateLabel: 'In Progress', caller: 'Deepak Gowda' };
    s.itdesk.backlog.push(row);
    const prep = await call(s, 'prepareIncidentUpdate', { ticket: 'INC0011994', assignedTo: '', assignmentGroup: '', state: 'resolved', holdReason: '', urgency: '', impact: '', category: '', workNote: '', comment: '', resolutionNotes: 'Licence assigned' });
    expect(prep.status).toBe(200);
    const done = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) });
    expect(done.status).toBe(200);
    expect(done.state.tickets.find((t) => t.number === FIGMA.number)?.state).toBe('Resolved');
    expect(done.state.followUp).toMatchObject({ number: FIGMA.number, summary: 'Figma licence request', status: 'ringing', resolvedAt: NOW });
  });
  it('the IT desk resolving someone else\'s incident does not ring', async () => {
    const s = freshState();
    const prep = await call(s, 'prepareIncidentUpdate', { ticket: 'INC0013001', assignedTo: '', assignmentGroup: '', state: 'resolved', holdReason: '', urgency: '', impact: '', category: '', workNote: '', comment: '', resolutionNotes: 'Tunnel restarted' });
    const done = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) });
    expect(done.status).toBe(200);
    expect(done.state.followUp).toBeNull();
    expect(done.state.tickets.map((t) => t.number)).not.toContain('INC0013001');
  });
});
