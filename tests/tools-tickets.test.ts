import { describe, expect, it, vi } from 'vitest';
import { failure, success } from '@/lib/integrations/http';
import type { NewTicket, RemoteTicket } from '@/lib/integrations/types';
import { DAY, MINUTE } from '@/lib/domain/time';
import { NOW, call, codeOf, confirmed, freshState } from './helpers';

async function exhaustedVpn() {
  let out = await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: 'VPN drops every few minutes' });
  for (let i = 0; i < 5; i++) out = await call(out.state, 'reportStep', { outcome: 'not_fixed', note: i === 0 ? 'dropped again after 2 minutes' : '' });
  return out.state;
}

async function preparedVpnTicket() {
  const prep = await call(await exhaustedVpn(), 'prepareTicket', { summary: 'VPN keeps dropping', urgency: 'high', details: 'Started after macOS update' });
  return { state: prep.state, code: codeOf(prep.result), prep };
}

describe('prepareTicket', () => {
  it('attaches the troubleshooting log, device and verification, and keeps instructions out of the spoken text', async () => {
    const { state, prep } = await preparedVpnTicket();
    expect(prep.status).toBe(200);
    expect(prep.result.say).toMatch(/5 steps we tried/);
    expect(prep.result.next).toMatch(/clear yes.*confirmAction/);
    const payload = state.pending[0].payload;
    expect(payload).toMatchObject({ kind: 'ticket', ticket: { shortDescription: 'VPN keeps dropping', urgency: 1, impact: 3, category: 'network' } });
    const description = payload.kind === 'ticket' ? payload.ticket.description : '';
    expect(description).toMatch(/NB-2231, MacBook Pro on macOS 15/);
    expect(description).toMatch(/Identity: not verified/);
    expect(description).toMatch(/Issue: VPN drops every few minutes/);
    expect(description).toMatch(/Details: Started after macOS update/);
    expect(description).toMatch(/5 of 5 steps tried/);
    expect(description).toMatch(/1\. Click the GlobalProtect globe.*Result: not fixed\. Note: dropped again after 2 minutes/);
  });
  it('mentions verification in the ticket when Priya is verified', async () => {
    let s = (await call(freshState(), 'verifyIdentity', {}, { code: '421987' })).state;
    s = (await call(s, 'checkIdentity', { code: '421987' })).state;
    const prep = await call(s, 'prepareTicket', { summary: 'Laptop fan loud', urgency: 'low', details: '' });
    const p = prep.state.pending[0].payload;
    expect(p.kind === 'ticket' && p.ticket.description).toMatch(/Identity: verified by email code/);
    expect(p.kind === 'ticket' && p.ticket.description).toMatch(/No guided troubleshooting/);
  });
  it('warns when the fix is unfinished or an outage already covers it', async () => {
    let s = (await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: '' })).state;
    s = (await call(s, 'reportStep', { outcome: 'not_fixed', note: '' })).state;
    const early = await call(s, 'prepareTicket', { summary: 'VPN broken', urgency: 'medium', details: '' });
    expect(early.result.data).toMatchObject({ warnings: [expect.stringMatching(/step 2 of 5/)] });
    const concur = await call(freshState(), 'prepareTicket', { summary: 'SAP Concur expense submission fails', urgency: 'medium', details: '' });
    expect(concur.result.data).toMatchObject({ warnings: [expect.stringMatching(/I-N-C one one nine five zero/)] });
    expect(concur.result.next).toMatch(/followOutage/);
  });
  it.each([
    ['software-request', 'Install Adobe Acrobat Pro', 'software'],
    ['hardware-request', 'Replacement laptop charger', 'hardware'],
    ['access-request', 'Access to the Finance shared drive', 'inquiry'],
  ])('raises a %s as a ticket with its category and no unfinished-fix warning', async (articleId, summary, category) => {
    let s = (await call(freshState(), 'startTroubleshooting', { articleId, issue: summary })).state;
    s = (await call(s, 'reportStep', { outcome: 'done', note: 'Approved by her manager' })).state;
    const prep = await call(s, 'prepareTicket', { summary, urgency: 'low', details: 'Needed for vendor contracts' });
    expect(prep.result.data).toMatchObject({ warnings: [] });
    expect(prep.state.pending[0].payload).toMatchObject({ kind: 'ticket', ticket: { shortDescription: summary, category } });
  });
});

describe('confirming a ticket', () => {
  it('creates it once with a correlation id and queues the IT alert', async () => {
    const create = vi.fn(async (_t: NewTicket) => success({ number: 'INC0012001', sysId: 'sys-1' }));
    const { state, code } = await preparedVpnTicket();
    const done = await call(state, 'confirmAction', { code }, { tickets: { create }, notifyMode: 'live' });
    expect(done.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].correlationId).toBe(`askit:NMB-7K2:${code}`);
    expect(done.result.say).toMatch(/I-N-C one two zero zero one/);
    expect(done.result.say).toMatch(/alerting the IT channel/);
    expect(done.state.tickets[0]).toMatchObject({ number: 'INC0012001', sysId: 'sys-1', state: 'New', urgency: 1, raisedHere: true });
    expect(done.state.metrics.ticketsRaised).toBe(1);
    expect(done.state.troubleshooting).toMatchObject({ status: 'ticketed', ticket: 'INC0012001' });
    expect(done.state.notifications.at(-1)).toMatchObject({ kind: 'ticketRaised', status: 'queued', ok: false, channel: null });
    expect(done.alerts).toEqual([{ id: done.state.notifications.at(-1)!.id, text: expect.stringMatching(/INC0012001.*VPN keeps dropping/), card: expect.objectContaining({ status: 'ticket_raised' }) }]);
  });
  it('says honestly that the alert is simulated without a webhook', async () => {
    const { state, code } = await preparedVpnTicket();
    const done = await call(state, 'confirmAction', { code });
    expect(done.result.say).toMatch(/alert is simulated/);
  });
  it('keeps the code alive after a definite failure, and a retry raises it once', async () => {
    const { state, code } = await preparedVpnTicket();
    const failed = await call(state, 'confirmAction', { code }, { tickets: { mode: 'live', create: async () => failure({ kind: 'rejected', status: 403 }) } });
    expect(failed.status).toBe(422);
    expect(failed.result.error).toBe('ticket_not_synced');
    expect(failed.result.say).toMatch(/couldn't create the ticket in ServiceNow: ServiceNow rejected the request/);
    expect(failed.result.say).toMatch(/try again/i);
    expect(failed.result.say).not.toMatch(/can't see/);
    expect(failed.result.next).toMatch(/same code/);
    expect(failed.state.pending[0]).toMatchObject({ code, status: 'pending', tries: 1, expiresAt: state.pending[0].expiresAt });
    expect(failed.state.tickets[0]).toMatchObject({ number: expect.stringMatching(/^LOCAL-/), syncFailed: true, state: 'Not submitted' });
    expect(failed.state.metrics.ticketsRaised).toBe(0);
    expect(failed.alerts).toEqual([]);

    const find = vi.fn(async () => success(null));
    const create = vi.fn(async () => success({ number: 'INC0012001', sysId: 'sys-1' }));
    const retry = await call(failed.state, 'confirmAction', { code }, { tickets: { mode: 'live', find, create } });
    expect(retry.status).toBe(200);
    expect(find).toHaveBeenCalledWith(`askit:NMB-7K2:${code}`);
    expect(create).toHaveBeenCalledTimes(1);
    expect(retry.state.tickets.filter((t) => t.raisedHere).map((t) => t.number)).toEqual(['INC0012001']);
    expect(retry.state.metrics.ticketsRaised).toBe(1);
  });
  it('is honest when the outcome is unknown, and a retry finds the ticket instead of duplicating it', async () => {
    const { state, code } = await preparedVpnTicket();
    const lost = await call(state, 'confirmAction', { code }, { tickets: { mode: 'live', create: async () => failure({ kind: 'timeout' }) } });
    expect(lost.result.error).toBe('ticket_unconfirmed');
    expect(lost.result.say).toMatch(/not sure it went through/i);
    expect(lost.result.say).not.toMatch(/can't see|wasn't raised|not raised/i);
    expect(lost.state.pending[0]).toMatchObject({ status: 'pending', tries: 1 });
    const create = vi.fn();
    const retry = await call(lost.state, 'confirmAction', { code }, { tickets: { mode: 'live', find: async () => success({ number: 'INC0010777', sysId: 'late' }), create } });
    expect(create).not.toHaveBeenCalled();
    expect(retry.status).toBe(200);
    expect(retry.state.tickets.filter((t) => t.raisedHere).map((t) => t.number)).toEqual(['INC0010777']);
  });
});

describe('listMyTickets', () => {
  it('never reads brackets from a ticket title aloud', async () => {
    const remote = [{ number: 'INC0010001', sysId: 'a'.repeat(32), summary: '[review test] Adapter check (old)', state: 'Resolved', urgency: 1 as const, createdAt: NOW, updatedAt: NOW }];
    const out = await call(freshState(), 'listMyTickets', { status: 'all' }, { tickets: { mode: 'live', listMine: async () => success(remote) } });
    expect(out.result.say).toMatch(/I-N-C one zero zero zero one, review test Adapter check old, resolved/);
  });
  const REMOTE: RemoteTicket[] = [
    { number: 'INC0010042', sysId: 'abc', summary: 'Monitor flickers', state: 'In Progress', urgency: 2, createdAt: NOW - 60 * MINUTE, updatedAt: NOW - 30 * MINUTE },
    { number: 'INC0010001', sysId: 'def', summary: 'Old request', state: 'Closed', urgency: 3, createdAt: NOW - 9 * 1440 * MINUTE, updatedAt: null },
  ];
  it('refreshes the mirror from ServiceNow', async () => {
    const out = await call(freshState(), 'listMyTickets', { status: 'open' }, { tickets: { mode: 'live', listMine: async () => success(REMOTE) } });
    expect(out.state.tickets[0]).toMatchObject({ number: 'INC0010042', source: 'live', sysId: 'abc' });
    expect(out.result.data).toMatchObject({ stale: false, tickets: [expect.objectContaining({ number: 'INC0010042' }), expect.objectContaining({ number: 'INC0011994' })] });
    expect(out.result.say).toMatch(/I-N-C one zero zero four two/);
    expect(out.result.say).not.toMatch(/Old request/);
  });
  it('lists everything with status "all" and defaults to open', async () => {
    const all = await call(freshState(), 'listMyTickets', { status: 'all' });
    expect((all.result.data as { tickets: unknown[] }).tickets).toHaveLength(2);
    const open = await call(freshState(), 'listMyTickets', { status: '' });
    expect((open.result.data as { tickets: unknown[] }).tickets).toHaveLength(1);
  });
  it('returns the last mirror and says it may be stale when ServiceNow fails', async () => {
    const out = await call(freshState(), 'listMyTickets', { status: 'open' }, { tickets: { listMine: async () => failure({ kind: 'timeout' }) } });
    expect(out.status).toBe(200);
    expect(out.result.data).toMatchObject({ stale: true, tickets: [expect.objectContaining({ number: 'INC0011994' })] });
    expect(out.result.say).toMatch(/may be out of date/);
  });
});

describe('addTicketNote', () => {
  it.each(['I N C 11994', 'ticket 11994', 'INC0011994', 'one one nine nine four'])('finds "%s", reads the note back and adds it on her yes', async (ticket) => {
    const addNote = vi.fn(async () => success(null));
    const prep = await call(freshState(), 'addTicketNote', { ticket, note: 'Still waiting for the licence' }, { tickets: { addNote } });
    expect(prep.result.say).toBe('Shall I add this note to I-N-C one one nine nine four: Still waiting for the licence?');
    expect(prep.result.data).toMatchObject({ status: 'awaiting_confirmation' });
    expect(prep.state.pending[0].payload).toEqual({ kind: 'note', number: 'INC0011994', sysId: 'sim-INC0011994', text: 'Still waiting for the licence', shared: false });
    expect(addNote).not.toHaveBeenCalled();
    expect(prep.state.metrics.minutesSaved).toBe(0);
    const out = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) }, { tickets: { addNote } });
    expect(out.status).toBe(200);
    expect(addNote).toHaveBeenCalledWith({ number: 'INC0011994', sysId: 'sim-INC0011994' }, 'Still waiting for the licence');
    expect(out.result.say).toBe('Added your note to I-N-C one one nine nine four. IT will see it on the ticket.');
    expect(out.state.tickets[0].updatedAt).toBe(NOW);
    expect(out.state.metrics).toMatchObject({ minutesSaved: 3, duplicatesAvoided: 0 });
  });
  it('adds the note once, however often she says yes', async () => {
    const addNote = vi.fn(async () => success(null));
    const first = await confirmed(freshState(), 'addTicketNote', { ticket: '11994', note: 'x' }, { tickets: { addNote } });
    const code = first.state.pending[0].code;
    const second = await call(first.state, 'confirmAction', { code }, { tickets: { addNote } });
    expect(second.result.data).toMatchObject({ alreadyDone: true });
    expect(addNote).toHaveBeenCalledTimes(1);
    expect(second.state.metrics.minutesSaved).toBe(3);
  });
  it('adds nothing after a no, or once the yes expired', async () => {
    const addNote = vi.fn(async () => success(null));
    const prep = await call(freshState(), 'addTicketNote', { ticket: '11994', note: 'x' });
    const code = codeOf(prep.result);
    expect((await call(prep.state, 'confirmAction', { code }, { now: NOW + 5 * MINUTE + 1, tickets: { addNote } })).result.error).toBe('action_expired');
    const no = await call(prep.state, 'cancelAction', { code });
    expect(no.result.say).toMatch(/Nothing was changed/);
    expect((await call(no.state, 'confirmAction', { code }, { tickets: { addNote } })).result.error).toBe('action_cancelled');
    expect(addNote).not.toHaveBeenCalled();
  });
  it('refuses an unknown ticket without preparing anything', async () => {
    const addNote = vi.fn();
    const out = await call(freshState(), 'addTicketNote', { ticket: 'ticket 99999', note: 'x' }, { tickets: { addNote } });
    expect(out.result.error).toBe('unknown_ticket');
    expect(out.result.say).toMatch(/I-N-C one one nine nine four/);
    expect(out.state.pending).toEqual([]);
    expect(addNote).not.toHaveBeenCalled();
  });
  it('says honestly when the note did not reach ServiceNow, and claims nothing', async () => {
    const prep = await call(freshState(), 'addTicketNote', { ticket: '11994', note: 'x' });
    const code = codeOf(prep.result);
    const out = await call(prep.state, 'confirmAction', { code }, { tickets: { addNote: async () => failure({ kind: 'unauthorized', status: 401 }) } });
    expect(out.result.error).toBe('note_not_synced');
    expect(out.result.say).toMatch(/^I couldn't add the note in ServiceNow: ServiceNow refused our credentials.*Shall I try again\?$/);
    expect(out.state.pending[0].status).toBe('pending');
    expect(out.state.tickets[0].updatedAt).toBe(NOW - DAY);
    expect(out.state.metrics.minutesSaved).toBe(0);
    const retry = await call(out.state, 'confirmAction', { code });
    expect(retry.result.say).toMatch(/^Added your note/);
  });
  it('gives up when ServiceNow has no such ticket', async () => {
    const prep = await call(freshState(), 'addTicketNote', { ticket: '11994', note: 'x' });
    const out = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) }, { tickets: { addNote: async () => failure({ kind: 'not_found', status: 404 }) } });
    expect(out.result.error).toBe('unknown_ticket');
    expect(out.result.say).toBe('ServiceNow has no ticket I-N-C one one nine nine four.');
    expect(out.state.pending[0].status).toBe('cancelled');
  });
  it('cannot add notes to a local-only ticket', async () => {
    const s = freshState();
    s.tickets.unshift({ number: 'LOCAL-7', sysId: null, summary: 'x', state: 'Not submitted', urgency: 2, source: 'live', createdAt: NOW, updatedAt: NOW, syncFailed: true });
    const out = await call(s, 'addTicketNote', { ticket: 'local reference seven', note: 'x' });
    expect(out.result.error).toBe('not_synced');
    expect(out.state.pending).toEqual([]);
  });
});

describe('prepareEscalation', () => {
  it('escalates a spoken ticket number after confirmation and queues the alert', async () => {
    const escalate = vi.fn(async () => success(null));
    const prep = await call(freshState(), 'prepareEscalation', { ticket: 'I N C 11994', reason: 'Client demo tomorrow' });
    expect(prep.result.say).toMatch(/escalate I-N-C one one nine nine four/i);
    const out = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) }, { tickets: { escalate } });
    expect(escalate).toHaveBeenCalledWith({ number: 'INC0011994', sysId: 'sim-INC0011994' }, 'Client demo tomorrow');
    expect(out.state.tickets[0]).toMatchObject({ urgency: 1, escalated: true });
    expect(out.state.notifications.at(-1)).toMatchObject({ kind: 'ticketEscalated', status: 'queued' });
    expect(out.result.say).toMatch(/simulated/);
  });
  it('refuses unknown, resolved or already escalated tickets', async () => {
    expect((await call(freshState(), 'prepareEscalation', { ticket: 'ticket 12345', reason: 'x' })).result.error).toBe('unknown_ticket');
    expect((await call(freshState(), 'prepareEscalation', { ticket: '11987', reason: 'x' })).result.error).toBe('ticket_closed');
    const s = freshState();
    s.tickets[0].escalated = true;
    expect((await call(s, 'prepareEscalation', { ticket: '11994', reason: 'x' })).result.error).toBe('already_escalated');
  });
  it('does not mark it escalated when ServiceNow fails, so a retry works', async () => {
    const prep = await call(freshState(), 'prepareEscalation', { ticket: '11994', reason: 'Blocked' });
    const code = codeOf(prep.result);
    const out = await call(prep.state, 'confirmAction', { code }, { tickets: { escalate: async () => failure({ kind: 'timeout' }) } });
    expect(out.result.error).toBe('escalation_not_synced');
    expect(out.result.say).toMatch(/couldn't escalate it in ServiceNow/);
    expect(out.state.tickets[0]).toMatchObject({ urgency: 3, syncFailed: true });
    expect(out.state.tickets[0].escalated).toBeUndefined();
    expect(out.state.pending[0]).toMatchObject({ status: 'pending' });
    expect(out.alerts).toEqual([]);
    const retry = await call(out.state, 'confirmAction', { code });
    expect(retry.status).toBe(200);
    expect(retry.state.tickets[0]).toMatchObject({ escalated: true, urgency: 1 });
    expect(retry.state.tickets[0].syncFailed).toBeUndefined();
  });
});

describe('free text read back to the caller', () => {
  const ODD = `the one (from Tuesday) [urgent] {again} ${'very '.repeat(390)}broken 😀`;
  const cases: [string, Record<string, string>][] = [
    ['checkServiceStatus', { service: ODD }],
    ['addTicketNote', { ticket: ODD, note: 'still broken' }],
    ['prepareEscalation', { ticket: ODD, reason: 'blocking payroll' }],
    ['confirmFix', { ticket: ODD, outcome: 'fixed', note: '' }],
    ['prepareTicket', { summary: 'Outlook crashes (error 0x80) [since update]', urgency: 'low', details: '' }],
  ];
  it.each(cases)('%s never reads back brackets or a monologue', async (name, args) => {
    const out = await call(freshState(), name, args);
    expect(out.result.say.length).toBeLessThan(400);
    expect(out.result.say).not.toMatch(/very very very very very very very very very very very very very very very very/);
  });
});
