import { describe, expect, it } from 'vitest';
import { displayTicketNumbers, listTurnId, statusTone, ticketList } from '@/lib/client/ticket-lines';
import { spokenTicket } from '@/lib/domain/tickets';

const CATALOG = new Map([
  ['INC0010013', { summary: 'GlobalProtect VPN not connecting', status: 'New' }],
  ['INC0010012', { summary: 'VPN disconnecting resolved by toggling Wi-Fi', status: 'Resolved' }],
  ['INC0010001', { summary: '[review test] ASK IT adapter check', status: 'Resolved' }],
]);

describe('displayTicketNumbers', () => {
  it.each([
    ['Saved. I-N-C one zero zero one zero is now new.', 'Saved. INC0010010 is now new.'],
    ['Ticket I N C 10013 is open', 'Ticket INC0010013 is open'],
    ['See INC0010013 and INC 0010012.', 'See INC0010013 and INC0010012.'],
    ['No numbers here, since one of them is fine', 'No numbers here, since one of them is fine'],
    ['Nimbus Labs Inc. is great', 'Nimbus Labs Inc. is great'],
  ])('%s', (input, expected) => {
    expect(displayTicketNumbers(input)).toBe(expected);
  });

  it('reverses what the tools speak', () => {
    expect(displayTicketNumbers(`It is ${spokenTicket('INC0012001')}.`)).toBe('It is INC0012001.');
  });

  it('leaves numbers too long for a ticket alone', () => {
    expect(displayTicketNumbers('INC123456789 stays')).toBe('INC123456789 stays');
  });
});

describe('ticketList', () => {
  it('turns the screenshot sentence into one line per ticket', () => {
    const text =
      'You have three tickets: I-N-C one zero zero one three for the GlobalProtect VPN not connecting, I-N-C one zero zero one two which is resolved regarding the VPN disconnecting issue, and I-N-C one zero zero zero one for an adapter check, which is also resolved. Is there anything else you need?';
    expect(ticketList(text, CATALOG)).toEqual({
      intro: 'You have three tickets:',
      items: [
        { number: 'INC0010013', summary: 'GlobalProtect VPN not connecting', status: 'New' },
        { number: 'INC0010012', summary: 'VPN disconnecting resolved by toggling Wi-Fi', status: 'Resolved' },
        { number: 'INC0010001', summary: '[review test] ASK IT adapter check', status: 'Resolved' },
      ],
      outro: 'Is there anything else you need?',
    });
  });

  it('falls back to the spoken words for tickets it does not know', () => {
    const text =
      'Here are the top two critical incidents. First, I-N-C one zero zero one one, Payroll export failing in SAP, in progress. Second, I-N-C one zero zero zero two, SAP Concur outage, in progress, unassigned. Which one do you want to open?';
    expect(ticketList(text, new Map())).toEqual({
      intro: 'Here are the top two critical incidents:',
      items: [
        { number: 'INC0010011', summary: 'Payroll export failing in SAP, in progress', status: null },
        { number: 'INC0010002', summary: 'SAP Concur outage, in progress, unassigned', status: null },
      ],
      outro: 'Which one do you want to open?',
    });
  });

  it('treats a single ticket after a colon as a list', () => {
    const text = 'You have 1 open ticket: I-N-C one zero zero one three, GlobalProtect VPN not connecting, new.';
    expect(ticketList(text, CATALOG)).toEqual({
      intro: 'You have 1 open ticket:',
      items: [{ number: 'INC0010013', summary: 'GlobalProtect VPN not connecting', status: 'New' }],
      outro: '',
    });
  });

  it('leaves a sentence about one ticket alone', () => {
    expect(ticketList('Saved. I-N-C one zero zero one zero is now new.', CATALOG)).toBeNull();
    expect(ticketList('Opened INC0010013, the VPN one.', CATALOG)).toBeNull();
  });

  it('returns null without ticket numbers', () => {
    expect(ticketList('Please restart GlobalProtect.', CATALOG)).toBeNull();
    expect(ticketList('', CATALOG)).toBeNull();
  });

  it('lists a repeated ticket once', () => {
    const text = 'Two: INC0010013, VPN; INC0010012, Wi-Fi; and INC0010013 again.';
    expect(ticketList(text, CATALOG)?.items.map((i) => i.number)).toEqual(['INC0010013', 'INC0010012']);
  });

  it('has no intro when the list starts the message', () => {
    const r = ticketList('INC0010013 is new and INC0010012 is resolved.', CATALOG);
    expect(r?.intro).toBe('');
    expect(r?.items).toHaveLength(2);
  });
});

describe('statusTone', () => {
  it.each([
    ['New', 'info'],
    ['In Progress', 'info'],
    ['On Hold', 'warn'],
    ['Outage', 'bad'],
    ['Resolved', undefined],
    ['Closed', undefined],
    ['Canceled', undefined],
    [null, undefined],
  ] as const)('%s', (status, tone) => {
    expect(statusTone(status)).toBe(tone);
  });
});

describe('listTurnId', () => {
  const T = 1_795_000_000_000;
  const msg = (id: string, role: 'agent' | 'user', createdAt?: number) => ({ id, role, text: '', createdAt, streaming: false, interrupted: false });
  const turns = [msg('a1', 'agent', T), msg('u1', 'user', T + 5_000), msg('a2', 'agent', T + 9_000), msg('u2', 'user', T + 20_000), msg('a3', 'agent', T + 24_000)];
  it('puts the list under the first ASK IT turn after it was made, allowing a little clock drift', () => {
    expect(listTurnId(turns, T + 8_000, T)).toBe('a2');
    expect(listTurnId(turns, T + 10_000, T)).toBe('a2');
    expect(listTurnId(turns, T + 20_500, T)).toBe('a3');
  });
  it('waits for the answer when no ASK IT turn came after the list yet', () => {
    expect(listTurnId(turns, T + 30_000, T)).toBeNull();
  });
  it('ignores a list from before this call', () => {
    expect(listTurnId(turns, T - 60_000, T)).toBeNull();
  });
  it('uses the newest ASK IT turn when turns carry no times', () => {
    expect(listTurnId([msg('a1', 'agent'), msg('u1', 'user'), msg('a2', 'agent')], T, T)).toBe('a2');
  });
});
