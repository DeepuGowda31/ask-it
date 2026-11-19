import { describe, expect, it } from 'vitest';
import { ServiceNowDesk, queueWindowDays } from '@/lib/integrations/servicenow-desk';
import { fakeFetch, hangingFetch, headerOf, jsonResponse } from './fakes';
import { DAY, MINUTE } from '@/lib/domain/time';
import type { QueueQuery } from '@/lib/integrations/types';

const CFG = { instanceUrl: 'https://nimbus.service-now.example', user: 'askit.bot', password: 'pa55-SECRET', callerEmail: 'it@x.example', closeCode: 'Resolved – Permanent Fix Applied' };
const SYS = '0123456789abcdef0123456789abcdef';
const USER = 'fedcba9876543210fedcba9876543210';
const GROUP = 'aaaabbbbccccddddeeeeffff00001111';

const v = (value: string, display = value) => ({ value, display_value: display });
const ROW = {
  number: v('INC0010101'),
  sys_id: v(SYS),
  short_description: v('VPN down for sales'),
  priority: v('1', '1 - Critical'),
  state: v('2', 'In Progress'),
  hold_reason: v(''),
  assigned_to: v(USER, 'David Loo'),
  assignment_group: v(GROUP, 'Network'),
  caller_id: v('c1', 'Priya Sharma'),
  category: v('network', 'Network'),
  urgency: v('1', '1 - High'),
  impact: v('2', '2 - Medium'),
  opened_at: v('2026-11-18 04:00:00', '2026-11-18 09:30:00'),
};
const INCIDENT = {
  number: 'INC0010101',
  sysId: SYS,
  summary: 'VPN down for sales',
  priority: 1,
  priorityLabel: 'Critical',
  state: '2',
  stateLabel: 'In Progress',
  holdReason: null,
  assignee: { id: USER, name: 'David Loo' },
  group: { id: GROUP, name: 'Network' },
  caller: 'Priya Sharma',
  category: 'network',
  urgency: 1,
  impact: 2,
  openedAt: Date.UTC(2026, 10, 18, 4),
};

const NOW = Date.UTC(2026, 10, 18, 4, 0, 30);
function desk(handler: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(handler);
  return { desk: new ServiceNowDesk(CFG, { fetch: f.fetch }, 0, () => NOW), calls: f.calls };
}
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);
const FIELDS = 'number,sys_id,short_description,priority,state,hold_reason,assigned_to,assignment_group,caller_id,category,urgency,impact,opened_at';

describe('ServiceNow desk activity', () => {
  it('reads when incidents were opened and resolved in the last days', async () => {
    const { desk: d, calls } = desk((url) => (new URL(url).searchParams.get('sysparm_fields') === 'opened_at'
      ? jsonResponse({ result: [{ opened_at: '2026-11-18 03:00:00' }, { opened_at: 'nonsense' }] })
      : jsonResponse({ result: [{ resolved_at: '2026-11-17 10:00:00' }] })));
    expect(await d.activity(NOW - 7 * DAY)).toEqual({ ok: true, value: { opened: [Date.UTC(2026, 10, 18, 3)], resolved: [Date.UTC(2026, 10, 17, 10)] } });
    const queries = calls.map((c) => query(c.url));
    expect(queries[0]).toEqual({ sysparm_query: 'opened_at>=javascript:gs.minutesAgoStart(10080)', sysparm_fields: 'opened_at', sysparm_limit: '1000' });
    expect(queries[1]).toEqual({ sysparm_query: 'resolved_at>=javascript:gs.minutesAgoStart(10080)', sysparm_fields: 'resolved_at', sysparm_limit: '1000' });
  });
  it('fails when either read fails', async () => {
    const { desk: d } = desk((url) => (new URL(url).searchParams.get('sysparm_fields') === 'opened_at' ? jsonResponse({ result: [] }) : jsonResponse({ error: 'x' }, 503)));
    expect(await d.activity(NOW - DAY)).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  });
});

describe('ServiceNow desk queue', () => {
  it.each([
    [{}, ''],
    [{ priority: 'critical' }, '^priority=1'],
    [{ priority: 'high' }, '^priority=2'],
    [{ priority: 'moderate' }, '^priority=3'],
    [{ priority: 'low' }, '^priorityIN4,5'],
    [{ priority: 'urgent' }, '^priorityIN1,2'],
    [{ state: 'new' }, '^state=1'],
    [{ state: 'in_progress' }, '^state=2'],
    [{ state: 'on_hold' }, '^state=3'],
    [{ assignee: { kind: 'none' } }, '^assigned_toISEMPTY'],
    [{ assignee: { kind: 'any' } }, '^assigned_toISNOTEMPTY'],
    [{ assignee: { kind: 'name', name: 'David' } }, '^assigned_to.nameLIKEDavid'],
    [{ group: 'Network' }, '^assignment_group.nameLIKENetwork'],
    [{ category: 'hardware' }, '^category=hardware'],
    [{ words: ['vpn', 'sales'] }, '^short_descriptionLIKEvpn^short_descriptionLIKEsales'],
    [{ since: NOW - 90 * MINUTE }, '^opened_at>=javascript:gs.minutesAgoStart(90)'],
    [{ since: NOW - DAY - 30 * MINUTE + 1, before: NOW - 30 * MINUTE }, '^opened_at>=javascript:gs.minutesAgoStart(1469)^opened_at<javascript:gs.minutesAgoStart(30)'],
    [{ since: NOW + MINUTE }, '^opened_at>=javascript:gs.minutesAgoStart(0)'],
    [{ priority: 'critical', assignee: { kind: 'none' }, since: NOW - 60 * MINUTE }, '^priority=1^assigned_toISEMPTY^opened_at>=javascript:gs.minutesAgoStart(60)'],
  ] as const)('lists open incidents for %j, highest priority and oldest first', async (q, extra) => {
    const { desk: d, calls } = desk(() => jsonResponse({ result: [ROW] }));
    expect(await d.listOpen({ sort: 'priority', ...q } as QueueQuery, 5)).toEqual({ ok: true, value: [INCIDENT] });
    expect(calls[0].url.startsWith('https://nimbus.service-now.example/api/now/table/incident?')).toBe(true);
    expect(headerOf(calls[0].init, 'authorization')).toMatch(/^Basic /);
    expect(query(calls[0].url)).toEqual({
      sysparm_query: `active=true^stateIN1,2,3${extra}^ORDERBYpriority^ORDERBYopened_at`,
      sysparm_fields: FIELDS,
      sysparm_display_value: 'all',
      sysparm_limit: '5',
    });
  });
  it.each([
    ['resolved', 'state=6'],
    ['closed', 'state=7'],
    ['canceled', 'state=8'],
  ] as const)('lists %s incidents, which are not in the open set', async (state, base) => {
    const { desk: d, calls } = desk(() => jsonResponse({ result: [] }));
    await d.listOpen({ state, priority: 'high', sort: 'priority' }, 5);
    expect(query(calls[0].url).sysparm_query).toBe(`${base}^priority=2^ORDERBYpriority^ORDERBYopened_at`);
    const f = fakeFetch(() => jsonResponse({ result: [] }));
    await new ServiceNowDesk(CFG, { fetch: f.fetch }, 30, () => NOW).listOpen({ state, sort: 'newest' }, 5);
    expect(query(f.calls[0].url).sysparm_query).toBe(`${base}^opened_at>=javascript:gs.daysAgoStart(30)^ORDERBYDESCopened_at`);
  });
  it.each([
    ['newest', '^ORDERBYDESCopened_at'],
    ['oldest', '^ORDERBYopened_at'],
  ] as const)('sorts %s', async (sort, order) => {
    const { desk: d, calls } = desk(() => jsonResponse({ result: [] }));
    await d.listOpen({ sort }, 5);
    expect(query(calls[0].url).sysparm_query).toBe(`active=true^stateIN1,2,3${order}`);
  });
  it.each([
    [{ assignee: { kind: 'name', name: 'x^ORactive=false' } }],
    [{ group: 'a=b' }],
    [{ category: 'net\nwork' }],
    [{ words: ['ok', 'x^y'] }],
  ] as const)('never sends an unsafe filter %j', async (q) => {
    const { desk: d, calls } = desk(() => jsonResponse({ result: [] }));
    expect(await d.listOpen({ sort: 'priority', ...q } as QueueQuery, 5)).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(calls).toHaveLength(0);
  });
  it('gets one incident by number and never queries a bad number', async () => {
    const { desk: d, calls } = desk(() => jsonResponse({ result: [ROW] }));
    expect(await d.get('INC0010101')).toEqual({ ok: true, value: INCIDENT });
    expect(query(calls[0].url).sysparm_query).toBe('number=INC0010101');
    expect(await d.get('INC0010101^ORnumber!=x')).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(calls).toHaveLength(1);
  });
  it('searches open incidents by words, refusing operators', async () => {
    const { desk: d, calls } = desk(() => jsonResponse({ result: [] }));
    expect(await d.search(['concur', 'expense'])).toEqual({ ok: true, value: [] });
    expect(query(calls[0].url)).toMatchObject({ sysparm_query: 'active=true^stateIN1,2,3^short_descriptionLIKEconcur^short_descriptionLIKEexpense^ORDERBYpriority', sysparm_limit: '5' });
    expect(await d.search(['x^ORactive=false'])).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(await d.search([])).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(calls).toHaveLength(1);
  });
  it('limits the queue and search to recent incidents when a window is set', async () => {
    const f = fakeFetch(() => jsonResponse({ result: [ROW] }));
    const d = new ServiceNowDesk(CFG, { fetch: f.fetch }, 30);
    await d.listOpen({ priority: 'critical', sort: 'priority' }, 5);
    await d.search(['vpn']);
    await d.get('INC0010101');
    expect(query(f.calls[0].url).sysparm_query).toBe('active=true^stateIN1,2,3^opened_at>=javascript:gs.daysAgoStart(30)^priority=1^ORDERBYpriority^ORDERBYopened_at');
    expect(query(f.calls[1].url).sysparm_query).toBe('active=true^stateIN1,2,3^opened_at>=javascript:gs.daysAgoStart(30)^short_descriptionLIKEvpn^ORDERBYpriority');
    expect(query(f.calls[2].url).sysparm_query).toBe('number=INC0010101');
  });
  it.each([
    [undefined, 30],
    ['', 30],
    ['90', 90],
    [' 7 ', 7],
    ['0', 0],
    ['-5', 30],
    ['ten', 30],
    ['2.5', 30],
  ])('reads the queue window %j as %i days', (value, days) => {
    expect(queueWindowDays({ SERVICENOW_QUEUE_DAYS: value })).toBe(days);
  });
  it('reads the latest two work notes', async () => {
    const { desk: d, calls } = desk(() => jsonResponse({ result: [{ value: 'Rebooted the edge router', sys_created_on: '2026-11-18 05:00:00', sys_created_by: 'david.loo' }] }));
    expect(await d.workNotes(SYS)).toEqual({ ok: true, value: [{ at: Date.UTC(2026, 10, 18, 5), author: 'david.loo', text: 'Rebooted the edge router' }] });
    expect(calls[0].url.startsWith('https://nimbus.service-now.example/api/now/table/sys_journal_field?')).toBe(true);
    expect(query(calls[0].url)).toMatchObject({ sysparm_query: `element_id=${SYS}^element=work_notes^ORDERBYDESCsys_created_on`, sysparm_limit: '2' });
    expect(await d.workNotes('not-a-sys-id')).toEqual({ ok: false, error: { kind: 'rejected' } });
  });
});

describe('ServiceNow desk people and groups', () => {
  it.each([
    ['exact', 'active=true^name=David'],
    ['starts', 'active=true^nameSTARTSWITHDavid'],
    ['like', 'active=true^nameLIKEDavid'],
  ] as const)('finds users by %s name', async (match, q) => {
    const { desk: d, calls } = desk(() => jsonResponse({ result: [{ sys_id: USER, name: 'David Loo' }] }));
    expect(await d.findUsers('David', match)).toEqual({ ok: true, value: [{ id: USER, name: 'David Loo' }] });
    expect(calls[0].url.startsWith('https://nimbus.service-now.example/api/now/table/sys_user?')).toBe(true);
    expect(query(calls[0].url)).toMatchObject({ sysparm_query: q, sysparm_fields: 'sys_id,name', sysparm_limit: '6' });
  });
  it('finds groups and lists their active members', async () => {
    const member = { user: v(USER, 'David Loo') };
    const { desk: d, calls } = desk((url) => (url.includes('grmember') ? jsonResponse({ result: [member, { user: v('', '') }] }) : jsonResponse({ result: [{ sys_id: GROUP, name: 'Network' }] })));
    expect(await d.findGroups('network')).toEqual({ ok: true, value: [{ id: GROUP, name: 'Network' }] });
    expect(query(calls[0].url)).toMatchObject({ sysparm_query: 'active=true^nameLIKEnetwork' });
    expect(await d.groupMembers(GROUP)).toEqual({ ok: true, value: [{ id: USER, name: 'David Loo' }] });
    expect(query(calls[1].url)).toMatchObject({ sysparm_query: `group=${GROUP}^user.active=true^ORDERBYuser.name`, sysparm_fields: 'user', sysparm_display_value: 'all', sysparm_limit: '50' });
  });
  it('refuses query operators and bad ids without calling', async () => {
    const { desk: d, calls } = desk(() => jsonResponse({ result: [] }));
    expect(await d.findUsers('David^ORactive=false', 'exact')).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(await d.findGroups('net\nwork')).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(await d.groupMembers('x^y')).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(calls).toHaveLength(0);
  });
});

describe('ServiceNow desk update', () => {
  it('patches raw values and reads the record back with display values', async () => {
    const { desk: d, calls } = desk(() => jsonResponse({ result: ROW }));
    expect(await d.update(SYS, { assigned_to: USER, assignment_group: GROUP, work_notes: 'Taking this' })).toEqual({ ok: true, value: INCIDENT });
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].url.startsWith(`https://nimbus.service-now.example/api/now/table/incident/${SYS}?`)).toBe(true);
    expect(query(calls[0].url)).toEqual({ sysparm_display_value: 'all', sysparm_fields: FIELDS, sysparm_input_display_value: 'false' });
    expect(calls[0].body).toEqual({ assigned_to: USER, assignment_group: GROUP, work_notes: 'Taking this' });
  });
  it('adds the configured close code when resolving', async () => {
    const { desk: d, calls } = desk(() => jsonResponse({ result: ROW }));
    await d.update(SYS, { state: '6', close_notes: 'Router replaced' });
    expect(calls[0].body).toEqual({ state: '6', close_notes: 'Router replaced', close_code: 'Resolved – Permanent Fix Applied' });
  });
  it('never patches a bad sys_id and reports failures', async () => {
    const { desk: d, calls } = desk(() => jsonResponse({ error: { message: 'Operation Failed', detail: 'ACL' } }, 403));
    expect(await d.update('sim-1', { work_notes: 'x' })).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(calls).toHaveLength(0);
    expect(await d.update(SYS, { work_notes: 'x' })).toEqual({ ok: false, error: { kind: 'rejected', status: 403 } });
    const bad = desk(() => jsonResponse({ result: { nope: 1 } }));
    expect(await bad.desk.update(SYS, { work_notes: 'x' })).toEqual({ ok: false, error: { kind: 'bad_response' } });
  });
});

describe('ServiceNow desk roster', () => {
  const NEHA = '11111111111111111111111111111111';
  const KARAN = '22222222222222222222222222222222';
  const ITIL = '33333333333333333333333333333333';
  const ADMIN = '44444444444444444444444444444444';
  const TEAMS = ['Network', 'Finance Systems', 'Payroll'];
  const member = (id: string, name: string, team: string, userName = name.toLowerCase().replace(' ', '.')) => ({ user: v(id, name), group: v(`g-${team}`, team), 'user.user_name': v(userName) });
  const MEMBERS = [
    member(KARAN, 'Karan Malhotra', 'Finance Systems'),
    member(KARAN, 'Karan Malhotra', 'Network'),
    member(NEHA, 'Neha Joshi', 'Finance Systems'),
    member(ITIL, 'Itil Helper', 'Network', 'itil'),
    member(ADMIN, 'System Administrator', 'Payroll', 'sysadmin'),
    member(USER, 'David Loo', 'Hardware'),
    member('not-a-sys-id', 'Odd Row', 'Network'),
    { user: v('', ''), group: v('g', 'Network') },
    'junk',
  ];
  const OPEN = [
    { number: v('INC0010201'), short_description: v('Vendor payment file rejected'), priority: v('2', '2 - High'), assigned_to: v(KARAN, 'Karan Malhotra') },
    { number: v('INC0010202'), short_description: v('Invoice approvals stuck'), priority: v('3', '3 - Moderate'), assigned_to: v(KARAN, 'Karan Malhotra') },
    { number: v('INC0010203'), short_description: v('Not ours'), priority: v('3', '3 - Moderate'), assigned_to: v(USER, 'David Loo') },
    { number: v(''), short_description: v('No number'), priority: v('1', '1 - Critical'), assigned_to: v(NEHA, 'Neha Joshi') },
  ];
  const answer = (members: unknown = MEMBERS, open: unknown = OPEN) => (url: string) => jsonResponse({ result: url.includes('sys_user_grmember') ? members : open });
  function roster(handler: Parameters<typeof fakeFetch>[0], days = 30) {
    const f = fakeFetch(handler);
    return { desk: new ServiceNowDesk(CFG, { fetch: f.fetch }, days, () => NOW), calls: f.calls };
  }

  it('reads the members of the named teams and their open incidents in two calls', async () => {
    const { desk: d, calls } = roster(answer());
    expect(await d.roster(TEAMS)).toEqual({
      ok: true,
      value: [
        {
          id: KARAN,
          name: 'Karan Malhotra',
          teams: ['Network', 'Finance Systems'],
          open: [
            { number: 'INC0010201', summary: 'Vendor payment file rejected', priority: 2, priorityLabel: 'High' },
            { number: 'INC0010202', summary: 'Invoice approvals stuck', priority: 3, priorityLabel: 'Moderate' },
          ],
        },
        { id: NEHA, name: 'Neha Joshi', teams: ['Finance Systems'], open: [] },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].url.startsWith('https://nimbus.service-now.example/api/now/table/sys_user_grmember?')).toBe(true);
    expect(query(calls[0].url)).toEqual({
      sysparm_query: 'group.nameINNetwork,Finance Systems,Payroll^group.active=true^user.active=true^ORDERBYuser.name',
      sysparm_fields: 'user,group,user.user_name',
      sysparm_display_value: 'all',
      sysparm_limit: '500',
    });
    expect(calls[1].url.startsWith('https://nimbus.service-now.example/api/now/table/incident?')).toBe(true);
    expect(query(calls[1].url)).toEqual({
      sysparm_query: `active=true^stateIN1,2,3^opened_at>=javascript:gs.daysAgoStart(30)^assigned_toIN${KARAN},${NEHA}^ORDERBYpriority`,
      sysparm_fields: 'number,short_description,priority,assigned_to',
      sysparm_display_value: 'all',
      sysparm_limit: '500',
    });
  });
  it('counts every open incident when the window is off', async () => {
    const { desk: d, calls } = roster(answer(), 0);
    await d.roster(TEAMS);
    expect(query(calls[1].url).sysparm_query).toBe(`active=true^stateIN1,2,3^assigned_toIN${KARAN},${NEHA}^ORDERBYpriority`);
  });
  it('leaves out the itil and admin accounts by user name or by name', async () => {
    const rows = [member(ITIL, 'Someone', 'Network', 'itil'), member(ADMIN, 'Admin Person', 'Network', 'admin'), member(NEHA, 'ITIL User', 'Network'), member(KARAN, 'System Administrator', 'Network')];
    const { desk: d, calls } = roster(answer(rows));
    expect(await d.roster(TEAMS)).toEqual({ ok: true, value: [] });
    expect(calls).toHaveLength(1);
  });
  it('skips the incident call when the teams have nobody', async () => {
    const { desk: d, calls } = roster(answer([]));
    expect(await d.roster(TEAMS)).toEqual({ ok: true, value: [] });
    expect(calls).toHaveLength(1);
  });
  it('refuses team names that are not plain words without calling', async () => {
    const { desk: d, calls } = roster(answer());
    for (const teams of [[], ['Network^ORactive=false'], ['Net,work'], ['Network', ''], ['x'.repeat(41)], ['Pay\nroll']]) expect(await d.roster(teams)).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(calls).toHaveLength(0);
  });
  it.each([
    ['refused credentials', () => jsonResponse({ error: 'denied' }, 403), { kind: 'unauthorized', status: 403 }],
    ['a malformed list', () => jsonResponse({ result: { nope: 1 } }), { kind: 'bad_response' }],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 }), { kind: 'bad_response' }],
  ])('reports %s on the member call', async (_label, handler, error) => {
    const { desk: d, calls } = roster(handler);
    expect(await d.roster(TEAMS)).toEqual({ ok: false, error });
    expect(calls).toHaveLength(1);
  });
  it('reports a failed incident call instead of calling everyone free', async () => {
    const { desk: d } = roster((url) => (url.includes('sys_user_grmember') ? jsonResponse({ result: MEMBERS }) : jsonResponse({ error: 'busy' }, 503)));
    expect(await d.roster(TEAMS)).toEqual({ ok: false, error: { kind: 'unavailable', status: 503 } });
  });
  it('gives up within the effect deadline', async () => {
    const d = new ServiceNowDesk(CFG, { fetch: hangingFetch(), deadline: Date.now() + 30 }, 30);
    expect(await d.roster(TEAMS)).toEqual({ ok: false, error: { kind: 'timeout' } });
  });
});
