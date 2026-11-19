import { describe, expect, it } from 'vitest';
import { describeQuery, groupIncidents, matchesQuery, parseQueueArgs, sortIncidents } from '@/lib/domain/queue-query';
import { seedBacklog } from '@/lib/domain/desk-seed';
import { DAY, MINUTE, zonedTime } from '@/lib/domain/time';
import type { DeskIncident } from '@/lib/integrations/types';
import { NOW } from './helpers';

const EMPTY = { priority: '', state: '', assignee: '', group: '', category: '', opened: '', keyword: '', sort: '' };
const parse = (args: Partial<typeof EMPTY>) => parseQueueArgs({ ...EMPTY, ...args }, NOW);
const query = (args: Partial<typeof EMPTY>) => {
  const r = parse(args);
  if (!r.ok) throw new Error(`invalid ${r.field}`);
  return r.query;
};
const TODAY = zonedTime('2026-11-18', 0);
// The first seven seed incidents; the rest only give the simulated engineers some work.
const BACKLOG: DeskIncident[] = seedBacklog(NOW).slice(0, 7).map(({ notes: _notes, ...i }) => i);
const pick = (args: Partial<typeof EMPTY>) => sortIncidents(BACKLOG.filter((i) => matchesQuery(i, query(args))), query(args).sort).map((i) => i.number.slice(-5));

describe('parseQueueArgs', () => {
  it('means the whole open queue, by priority, when nothing is given', () => {
    expect(query({})).toEqual({ sort: 'priority' });
  });
  it.each([
    ['today', { since: TODAY }],
    ['yesterday', { since: TODAY - DAY, before: TODAY }],
    ['last_24h', { since: NOW - DAY }],
    ['this_week', { since: TODAY - 2 * DAY }],
    ['last_7_days', { since: NOW - 7 * DAY }],
    ['this_month', { since: zonedTime('2026-11-01', 0) }],
  ])('turns opened=%s into India-time bounds', (opened, bounds) => {
    expect(query({ opened })).toEqual({ sort: 'priority', opened, ...bounds });
  });
  it.each([
    ['unassigned', { kind: 'none' }],
    ['Nobody', { kind: 'none' }],
    ['no one', { kind: 'none' }],
    ['assigned', { kind: 'any' }],
    ['someone', { kind: 'any' }],
    ['David Loo', { kind: 'name', name: 'David Loo' }],
    ["  D'Souza ", { kind: 'name', name: "D'Souza" }],
  ])('reads assignee %j', (assignee, expected) => {
    expect(query({ assignee }).assignee).toEqual(expected);
  });
  it('keeps only meaningful keywords', () => {
    expect(query({ keyword: 'the VPN issue tickets' }).words).toEqual(['vpn']);
    expect(query({ keyword: 'the issue' }).words).toBeUndefined();
    expect(query({ keyword: 'sap payroll export failing now' }).words).toEqual(['sap', 'payroll', 'export', 'failing']);
  });
  it.each([['assignee', 'x^ORactive=false'], ['group', 'net=work'], ['assignee', 'a'.repeat(61)]])('refuses an unsafe %s', (field, value) => {
    expect(parse({ [field]: value })).toEqual({ ok: false, field });
  });
  it('passes priority, state, group, category and sort through', () => {
    expect(query({ priority: 'urgent', state: 'on_hold', group: ' Network ', category: 'hardware', sort: 'newest' })).toEqual({ priority: 'urgent', state: 'on_hold', group: 'Network', category: 'hardware', sort: 'newest' });
  });
});

describe('describeQuery', () => {
  it.each([
    [{}, 'Open incidents', '7 open incidents'],
    [{ priority: 'critical', opened: 'today' }, 'Critical incidents opened today', '7 critical incidents opened today'],
    [{ priority: 'urgent', state: 'new', assignee: 'unassigned' }, 'Critical or high-priority new unassigned incidents', '7 critical or high-priority new unassigned incidents'],
    [{ assignee: 'David Loo', group: 'Hardware' }, 'Incidents assigned to David Loo in the Hardware group', '7 incidents assigned to David Loo in the Hardware group'],
    [{ assignee: 'assigned', category: 'network', keyword: 'vpn router' }, 'Incidents assigned to someone in the network category about “vpn router”', '7 incidents assigned to someone in the network category about “vpn router”'],
    [{ state: 'in_progress', opened: 'last_7_days', sort: 'newest' }, 'In-progress incidents opened in the last 7 days, newest first', '7 in-progress incidents opened in the last 7 days'],
    [{ priority: 'low', opened: 'yesterday' }, 'Low-priority incidents opened yesterday', '7 low-priority incidents opened yesterday'],
  ])('%j', (args, title, phrase) => {
    const d = describeQuery(query(args));
    expect(d.title).toBe(title);
    expect(d.phrase(7)).toBe(phrase);
  });
  it.each([
    ['resolved', 'Resolved incidents'],
    ['closed', 'Closed incidents'],
    ['canceled', 'Canceled incidents'],
  ])('names the %s state', (state, title) => {
    expect(describeQuery(query({ state })).title).toBe(title);
  });
  it('uses the singular for one', () => {
    expect(describeQuery(query({ priority: 'critical' })).phrase(1)).toBe('1 critical incident');
    expect(describeQuery(query({ state: 'on_hold' })).phrase(0)).toBe('0 on-hold incidents');
  });
});

describe('matchesQuery and sortIncidents', () => {
  it.each([
    [{}, ['13002', '13003', '13001', '13004', '13006', '13007', '13005']],
    [{ priority: 'critical', opened: 'today' }, ['13003', '13001']],
    [{ assignee: 'unassigned' }, ['13003', '13001', '13007', '13005']],
    [{ assignee: 'assigned' }, ['13002', '13004', '13006']],
    [{ assignee: 'david' }, ['13006']],
    [{ group: 'soft' }, ['13002', '13004']],
    [{ category: 'hardware' }, ['13006', '13005']],
    [{ keyword: 'backup' }, ['13007']],
    [{ opened: 'yesterday' }, ['13002', '13005']],
    [{ opened: 'this_week' }, ['13002', '13003', '13001', '13004', '13007', '13005']],
    [{ priority: 'low' }, ['13005']],
    [{ priority: 'urgent', state: 'in_progress' }, ['13002', '13003', '13004']],
    [{ state: 'on_hold' }, ['13006']],
    [{ sort: 'newest' }, ['13001', '13003', '13007', '13002', '13005', '13004', '13006']],
    [{ sort: 'oldest', priority: 'critical' }, ['13002', '13003', '13001']],
  ])('%j', (args, numbers) => {
    expect(pick(args)).toEqual(numbers);
  });
});

describe('closed states', () => {
  it('matches resolved, closed and canceled incidents only when asked', () => {
    const done = [{ ...BACKLOG[0], number: 'INC0019006', state: '6' }, { ...BACKLOG[1], number: 'INC0019007', state: '7' }, { ...BACKLOG[2], number: 'INC0019008', state: '8' }];
    const hit = (state: string) => done.filter((i) => matchesQuery(i, query({ state }))).map((i) => i.number);
    expect(hit('resolved')).toEqual(['INC0019006']);
    expect(hit('closed')).toEqual(['INC0019007']);
    expect(hit('canceled')).toEqual(['INC0019008']);
    expect(done.filter((i) => matchesQuery(i, query({})))).toEqual([]);
  });
});

describe('groupIncidents', () => {
  it('groups by priority and state in their natural order', () => {
    expect(groupIncidents(BACKLOG, 'priority', NOW)).toEqual([
      { label: 'Critical', count: 3 },
      { label: 'High', count: 1 },
      { label: 'Moderate', count: 2 },
      { label: 'Low', count: 1 },
    ]);
    expect(groupIncidents(BACKLOG, 'state', NOW)).toEqual([
      { label: 'New', count: 3 },
      { label: 'In Progress', count: 3 },
      { label: 'On Hold', count: 1 },
    ]);
  });
  it('groups by person, most first, with the empty bucket last among ties', () => {
    expect(groupIncidents(BACKLOG, 'assignee', NOW)).toEqual([
      { label: 'Unassigned', count: 4 },
      { label: 'Anita Rao', count: 1 },
      { label: 'David Loo', count: 1 },
      { label: 'Karthik Nair', count: 1 },
    ]);
    expect(groupIncidents(BACKLOG, 'group', NOW).at(-1)).toEqual({ label: 'No group', count: 1 });
    expect(groupIncidents(BACKLOG, 'category', NOW)[0]).toEqual({ label: 'software', count: 3 });
  });
  it('groups by the day opened, newest first', () => {
    expect(groupIncidents(BACKLOG, 'opened', NOW)).toEqual([
      { label: 'Today', count: 3 },
      { label: 'Yesterday', count: 2 },
      { label: 'Mon 16 Nov', count: 1 },
      { label: 'Sat 14 Nov', count: 1 },
    ]);
    expect(groupIncidents([{ ...BACKLOG[0], openedAt: null }], 'opened', NOW)).toEqual([{ label: 'Unknown', count: 1 }]);
  });
  it('folds the long tail into Other', () => {
    const many = Array.from({ length: 10 }, (_, n) => ({ ...BACKLOG[0], assignee: { id: String(n), name: `Person ${n}` } }));
    const groups = groupIncidents([...many, ...many.slice(0, 1)], 'assignee', NOW);
    expect(groups).toHaveLength(8);
    expect(groups[0]).toEqual({ label: 'Person 0', count: 2 });
    expect(groups.at(-1)).toEqual({ label: 'Other', count: 3 });
  });
  it('is empty for no incidents', () => {
    expect(groupIncidents([], 'group', NOW)).toEqual([]);
  });
});

it('keeps minute precision for opened bounds', () => {
  expect(query({ opened: 'last_24h' }).since! % MINUTE).toBe(NOW % MINUTE);
});
