import { describe, expect, it } from 'vitest';
import { callOpener } from '@/lib/domain/opener';
import { mergeRemote, ticketPhrase } from '@/lib/domain/tickets';
import { DAY, MINUTE } from '@/lib/domain/time';
import type { SessionState, TicketRecord } from '@/lib/domain/types';
import { NOW, confirmed, freshState } from './helpers';

const ticket = (o: Partial<TicketRecord>): TicketRecord => ({ number: 'INC0012001', sysId: 's1', summary: 'VPN keeps disconnecting when working from home', state: 'Resolved', urgency: 3, source: 'live', createdAt: NOW - 3 * DAY, updatedAt: NOW - DAY, ...o });

// No outage, no tickets: a plain session.
function quiet(): SessionState {
  const s = freshState();
  s.outages = [];
  s.tickets = [];
  return s;
}

const spoken = (say: string) => expect(say).not.toMatch(/[;:]|\s-\s|[–—]|INC\d|I-N-C/);

describe('call opener', () => {
  it('asks what it can help with when nothing is going on', () => {
    expect(callOpener(quiet(), NOW)).toEqual({ kind: 'default', say: 'What can I help you with today?' });
  });
  it('never brings up open tickets or an outage that has nothing to do with the employee', () => {
    const s = freshState();
    expect(s.outages[0].followed).toBe(false);
    expect(callOpener(s, NOW).kind).toBe('default');
  });
  it('names an outage the employee follows, and the ticket can wait', async () => {
    const s = (await confirmed(freshState(), 'followOutage', { incident: '' })).state;
    s.tickets.push(ticket({ updatedAt: NOW - 2 * MINUTE }));
    const o = callOpener(s, NOW);
    expect(o).toEqual({ kind: 'outage', incident: 'INC0011950', say: "IT is still working on the SAP Concur outage. Is that why you're calling, or is it something else?" });
    spoken(o.say);
  });
  it('names an outage that matches something the employee reported', () => {
    const s = quiet();
    s.outages = [{ id: 'OUT-1', service: 'vpn', title: 'GlobalProtect gateway down', incident: 'INC0010002', affected: null, since: NOW - 30 * MINUTE, followed: false }];
    s.tickets = [ticket({ summary: 'VPN drops every hour', state: 'In Progress' })];
    expect(callOpener(s, NOW).say).toBe("IT is still working on the VPN outage. Is that why you're calling, or is it something else?");
    s.tickets = [ticket({ summary: 'VPN drops every hour', state: 'Closed', updatedAt: NOW - 10 * DAY })];
    expect(callOpener(s, NOW).kind).toBe('default');
  });
  it('uses the title of an outage that names no service', () => {
    const s = quiet();
    s.outages = [{ id: 'OUT-1', service: '', title: 'Badge readers offline', incident: 'INC0010002', affected: null, since: null, followed: true }];
    expect(callOpener(s, NOW).say).toBe("IT is still working on the outage, Badge readers offline. Is that why you're calling, or is it something else?");
  });
  it('asks whether a ticket IT resolved in the last 3 days works now, by its name', () => {
    const s = quiet();
    s.tickets = [ticket({})];
    const o = callOpener(s, NOW);
    expect(o).toEqual({ kind: 'resolved', ticket: 'INC0012001', say: 'Your VPN ticket was resolved yesterday. Is it working now, or is this about something else?' });
    spoken(o.say);
    s.tickets = [ticket({ updatedAt: NOW - 30 * MINUTE })];
    expect(callOpener(s, NOW).say).toMatch(/^Your VPN ticket was resolved earlier today\./);
    s.tickets = [ticket({ updatedAt: NOW - 2 * DAY - 60 * MINUTE })];
    expect(callOpener(s, NOW).say).toMatch(/^Your VPN ticket was resolved on Monday\./);
    // ServiceNow's resolution time wins over a later update, such as a seed reset touching the row.
    s.tickets = [ticket({ updatedAt: NOW - MINUTE, resolvedAt: NOW - 2 * DAY - 60 * MINUTE })];
    expect(callOpener(s, NOW).say).toMatch(/^Your VPN ticket was resolved on Monday\./);
    s.tickets = [ticket({ updatedAt: NOW - MINUTE, resolvedAt: NOW - 4 * DAY })];
    expect(callOpener(s, NOW).kind).toBe('default');
  });
  it('picks the most recent resolution and falls back to title words', () => {
    const s = quiet();
    s.tickets = [ticket({ number: 'INC0012002', summary: 'Laptop fan loud (all day)', updatedAt: NOW - 5 * MINUTE }), ticket({ updatedAt: NOW - DAY })];
    expect(callOpener(s, NOW)).toMatchObject({ ticket: 'INC0012002', say: 'Your ticket about laptop fan loud all day was resolved earlier today. Is it working now, or is this about something else?' });
  });
  it('skips resolutions older than 3 days, ones already confirmed, closed ones and fixes ASK IT made on a call', () => {
    const s = quiet();
    s.tickets = [ticket({ updatedAt: NOW - 3 * DAY - MINUTE })];
    expect(callOpener(s, NOW).kind).toBe('default');
    s.tickets = [ticket({ state: 'Closed' })];
    expect(callOpener(s, NOW).kind).toBe('default');
    s.tickets = [ticket({ summary: 'VPN fixed by reconnecting', raisedHere: true, fixedOnCall: true })];
    expect(callOpener(s, NOW).kind).toBe('default');
    s.tickets = [ticket({})];
    s.fixChecks = [{ number: 'INC0012001', outcome: 'fixed', status: 'done', at: NOW - MINUTE }];
    expect(callOpener(s, NOW).kind).toBe('default');
    s.fixChecks = [];
    s.tickets = [ticket({ sysId: null, syncFailed: true })];
    expect(callOpener(s, NOW).kind).toBe('default');
  });
  it('mentions an open ticket only when ServiceNow showed IT changing it since the last call', () => {
    const s = quiet();
    s.tickets = [ticket({ number: 'INC0011994', summary: 'Figma licence request', state: 'In Progress', changedAt: NOW - 2 * 60 * MINUTE })];
    const o = callOpener(s, NOW);
    expect(o).toEqual({ kind: 'changed', ticket: 'INC0011994', say: 'IT has started work on your Figma ticket. Is this about that, or something else?' });
    spoken(o.say);
    s.tickets[0].state = 'On Hold';
    expect(callOpener(s, NOW).say).toBe('Your Figma ticket is on hold for now. Is this about that, or something else?');
    s.tickets[0].state = 'New';
    expect(callOpener(s, NOW).say).toBe('Your Figma ticket is open again. Is this about that, or something else?');
    s.call = { active: false, startedAt: NOW - 60 * MINUTE };
    expect(callOpener(s, NOW).kind).toBe('default');
    s.call = { active: false };
    s.tickets[0].changedAt = NOW - 4 * DAY;
    expect(callOpener(s, NOW).kind).toBe('default');
    delete s.tickets[0].changedAt;
    expect(callOpener(s, NOW).kind).toBe('default');
  });
  it('keeps the priority order: outage, then resolution, then change', () => {
    const s = quiet();
    s.tickets = [ticket({ number: 'INC0011994', summary: 'Figma licence request', state: 'In Progress', changedAt: NOW - MINUTE }), ticket({})];
    expect(callOpener(s, NOW).kind).toBe('resolved');
    s.outages = [{ id: 'OUT-1', service: 'concur', title: 'Concur down', incident: 'INC0011950', affected: 3, since: null, followed: true }];
    expect(callOpener(s, NOW).kind).toBe('outage');
  });
});

describe('ticket names said aloud', () => {
  it('uses the service a title names, else its own words', () => {
    expect(ticketPhrase('VPN keeps disconnecting when working from home')).toBe('your VPN ticket');
    expect(ticketPhrase('Outlook calendar not syncing')).toBe('your Outlook ticket');
    expect(ticketPhrase('Office wifi slow')).toBe('your Wi-Fi ticket');
    expect(ticketPhrase('Resolved by ASK IT: printer jams')).toBe('your printer ticket');
    expect(ticketPhrase('Figma licence request')).toBe('your Figma ticket');
    expect(ticketPhrase('Dock (USB-C) [left port] not charging after the latest macOS update was installed')).toBe('your ticket about dock USB-C left port not charging');
    expect(ticketPhrase('SSO for HR')).toBe('your ticket about SSO for HR');
  });
});

describe('ticket changes seen in ServiceNow', () => {
  const remote = (state: string) => [{ number: 'INC0011994', sysId: 'sim-INC0011994', summary: 'Figma licence request', state, urgency: 3 as const, createdAt: NOW - 2 * DAY, updatedAt: NOW }];
  it('stamps when a known ticket changes state, and nothing else', () => {
    const s = freshState();
    mergeRemote(s, remote('In Progress'), 'simulated', NOW);
    expect(s.tickets.find((t) => t.number === 'INC0011994')!.changedAt).toBeUndefined();
    mergeRemote(s, remote('On Hold'), 'simulated', NOW + MINUTE);
    expect(s.tickets.find((t) => t.number === 'INC0011994')!.changedAt).toBe(NOW + MINUTE);
    mergeRemote(s, remote('On Hold'), 'simulated', NOW + 2 * MINUTE);
    expect(s.tickets.find((t) => t.number === 'INC0011994')!.changedAt).toBe(NOW + MINUTE);
  });
  it('flags a fix made on a call by its correlation id, or an older one by its legacy title, and nothing else', () => {
    const s = freshState();
    const row = { sysId: 's', state: 'Resolved', urgency: 3 as const, createdAt: NOW, updatedAt: NOW };
    mergeRemote(s, [
      { ...row, number: 'INC0012001', summary: 'Password reset', correlationId: 'askit:CSK-M39:fix8090' },
      { ...row, number: 'INC0012002', summary: 'Resolved by ASK IT: VPN fixed', correlationId: 'askit:CSK-M39:8090' },
      { ...row, number: 'INC0012003', summary: 'Install Python', correlationId: 'askit:CSK-M39:2685' },
      { ...row, number: 'INC0012004', summary: 'VPN keeps disconnecting', correlationId: 'askit:seed:s15' },
    ], 'live', NOW);
    const flag = (n: string) => s.tickets.find((t) => t.number === n)!.fixedOnCall;
    expect([flag('INC0012001'), flag('INC0012002'), flag('INC0012003'), flag('INC0012004')]).toEqual([true, true, undefined, undefined]);
  });
  it('does not stamp a ticket seen for the first time', () => {
    const s = freshState();
    mergeRemote(s, [{ ...remote('In Progress')[0], number: 'INC0019999' }], 'simulated', NOW);
    expect(s.tickets.find((t) => t.number === 'INC0019999')!.changedAt).toBeUndefined();
  });
});
