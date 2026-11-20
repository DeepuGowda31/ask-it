import { describe, expect, it, vi } from 'vitest';
import { failure, success } from '@/lib/integrations/http';
import type { Resource } from '@/lib/integrations/types';
import { DESK_USERS } from '@/lib/domain/desk-seed';
import { buildItDeskView } from '@/lib/domain/itdesk-view';
import { TEAMS } from '@/lib/domain/tools/itdesk';
import type { SessionState } from '@/lib/domain/types';
import { NOW, call, freshState } from './helpers';

type Person = { name: string; teams: string[]; openTickets: number; tickets: string[] };
const people = (data: unknown) => (data as { people: Person[] }).people;
const names = (data: unknown) => people(data).map((p) => p.name);

const list = (args: { team?: string; status?: string }, state = freshState(), o: Parameters<typeof call>[3] = {}) => call(state, 'listResources', { team: '', status: '', ...args }, o);
const show = (name: string, state = freshState(), o: Parameters<typeof call>[3] = {}) => call(state, 'showResource', { name }, o);
const opened = async (ticket: string, state = freshState()) => (await call(state, 'openIncident', { ticket })).state;
// The same incident with nobody on it yet: only then is assigning it offered.
const unowned = async (ticket: string) => {
  const s = await opened(ticket);
  s.itdesk.current = { ...s.itdesk.current!, assignee: null };
  return s;
};

// Gives a simulated engineer another open incident.
function busy(state: SessionState, name: string, n: number) {
  const assignee = DESK_USERS.find((u) => u.name === name)!;
  const base = state.itdesk.backlog[0];
  state.itdesk.backlog.push({ ...base, number: `INC00199${String(n).padStart(2, '0')}`, sysId: `sim-inc-199${n}`, summary: `Extra work ${n}`, state: '2', stateLabel: 'In Progress', assignee });
}

describe('simulated roster', () => {
  it('mirrors the live teams, with the seeded engineers busy', async () => {
    const out = await list({ team: 'all' });
    expect(out.status).toBe(200);
    expect(people(out.result.data)).toHaveLength(20);
    expect(people(out.result.data).filter((p) => p.openTickets > 0).map((p) => p.name).sort()).toEqual(['Arjun Rao', 'David Loo', 'Karan Malhotra', 'Lakshmi Narayan', 'Meera Krishnan', 'Rahul Menon', 'Vikram Shetty']);
    expect(people(out.result.data).find((p) => p.name === 'David Loo')).toEqual({ name: 'David Loo', teams: ['Service Desk', 'Network', 'Hardware', 'Software'], openTickets: 1, tickets: ['INC0013006'] });
    expect(names(out.result.data)).not.toContain('Karthik Nair');
  });
});

describe('listResources', () => {
  it('names who is free in a team and asks who should take the open incident', async () => {
    const owned = await list({ team: 'Finance Systems', status: 'available' }, await opened('13012'));
    expect(owned.result.say).toBe('3 people in Finance Systems are free: Neha Joshi, Priyanka Das and Suresh Babu.');
    expect(owned.result.next).toBeUndefined();
    const out = await list({ team: 'Finance Systems', status: 'available' }, await unowned('13012'));
    expect(out.result.say).toBe('3 people in Finance Systems are free: Neha Joshi, Priyanka Das and Suresh Babu. Who should take it?');
    expect(names(out.result.data)).toEqual(['Neha Joshi', 'Priyanka Das', 'Suresh Babu']);
    expect(out.result.next).toMatch(/prepareIncidentUpdate with assignedTo/);
    expect(out.result.next).not.toMatch(/assignmentGroup/);
    expect(out.state.itdesk.board).toEqual({
      kind: 'people',
      title: 'Finance Systems',
      status: 'available',
      available: 3,
      busy: 1,
      people: [
        { name: 'Neha Joshi', teams: ['Finance Systems'], open: [] },
        { name: 'Priyanka Das', teams: ['Finance Systems'], open: [] },
        { name: 'Suresh Babu', teams: ['Finance Systems'], open: [] },
      ],
      at: NOW,
    });
  });
  it('asks only for the roster of the seven fixed teams, whatever was said', async () => {
    const roster = vi.fn(async () => success([] as Resource[]));
    await list({ team: 'payroll' }, freshState(), { desk: { roster } });
    expect(roster).toHaveBeenCalledWith(TEAMS);
    expect(TEAMS).toEqual(['Service Desk', 'Network', 'Hardware', 'Software', 'Database', 'Finance Systems', 'Payroll']);
  });
  it('uses the open incident’s group when it is one of the teams', async () => {
    const out = await list({ status: 'available' }, await opened('13007'));
    expect(out.result.say).toBe('3 people in Database are free: Beth Anglin, Divya Prakash and Fred Luddy. Who should take it?');
  });
  it('falls back to the category, and says to move the incident into that team', async () => {
    const out = await list({ status: 'available' }, await opened('13005'));
    expect(out.result.say).toBe('5 people in Hardware are free: Beth Anglin, Bow Ruggeri, David Dan, Don Goodliffe and Fred Luddy. Who should take it?');
    expect(out.result.next).toMatch(/assignmentGroup Hardware/);
  });
  it.each([
    ['inquiry', 'Service Desk'],
    ['network', 'Network'],
    ['software', 'Software'],
  ])('maps the category %s to %s', async (category, team) => {
    const s = await opened('13001');
    s.itdesk.current = { ...s.itdesk.current!, category };
    expect((await list({}, s)).state.itdesk.board).toMatchObject({ title: team });
  });
  it('covers every team when nothing is open or the incident has neither', async () => {
    expect((await list({ status: 'available' })).result.say).toMatch(/^13 people across the IT teams are free: Aditya Kulkarni, Ananya Iyer, Beth Anglin, Bow Ruggeri, David Dan, and 8 more are on your screen\.$/);
    const out = await list({ status: 'available' }, await opened('13001'));
    expect(out.state.itdesk.board).toMatchObject({ title: 'All teams', available: 13, busy: 7 });
    expect(out.result.say).toMatch(/Who should take it\?$/);
  });
  it.each([
    ['the network team', 'Network'],
    ['NETWORK', 'Network'],
    ['finance', 'Finance Systems'],
    ['service', 'Service Desk'],
    ['data', 'Database'],
    ['Payroll group', 'Payroll'],
  ])('understands %j as %s', async (team, title) => {
    expect((await list({ team })).state.itdesk.board).toMatchObject({ kind: 'people', title });
  });
  it('lists who is busy with how many tickets', async () => {
    const out = await list({ team: 'Network', status: 'busy' });
    expect(out.result.say).toBe('2 people in Network are busy: Arjun Rao with 1 open ticket and David Loo with 1 open ticket.');
    expect(people(out.result.data)).toEqual([
      { name: 'Arjun Rao', teams: ['Network'], openTickets: 1, tickets: ['INC0013009'] },
      { name: 'David Loo', teams: ['Service Desk', 'Network', 'Hardware', 'Software'], openTickets: 1, tickets: ['INC0013006'] },
    ]);
    expect(out.state.itdesk.board).toMatchObject({ status: 'busy', available: 3, busy: 2 });
  });
  it('says plainly when nobody is busy', async () => {
    const roster = vi.fn(async () => success([{ id: 'u1', name: 'Neha Joshi', teams: ['Finance Systems'], open: [] }]));
    expect((await list({ team: 'Finance Systems', status: 'busy' }, freshState(), { desk: { roster } })).result.say).toBe('Nobody in Finance Systems has an open ticket right now.');
  });
  it('sums up a whole team', async () => {
    const out = await list({ team: 'Network', status: 'all' });
    expect(out.result.say).toBe("Network has 5 people: 3 available and 2 busy. They're on your screen.");
    expect(names(out.result.data)).toEqual(['Arjun Rao', 'Bow Ruggeri', 'David Dan', 'David Loo', 'Fred Luddy']);
    expect((await list({ team: 'all' })).result.say).toBe("The IT teams have 20 people: 13 available and 7 busy. They're on your screen.");
  });
  it('suggests the least busy person when everyone is busy, and shows the whole team', async () => {
    const s = await unowned('13014');
    busy(s, 'Aditya Kulkarni', 1);
    busy(s, 'Aditya Kulkarni', 2);
    busy(s, 'Imran Sheikh', 3);
    busy(s, 'Nisha Pillai', 4);
    busy(s, 'Nisha Pillai', 5);
    const out = await list({ team: 'Payroll', status: 'available' }, s);
    expect(out.status).toBe(200);
    expect(out.result.say).toBe('Nobody in Payroll is free; the least busy is Imran Sheikh with 1 open ticket. Who should take it?');
    expect(out.state.itdesk.board).toMatchObject({ kind: 'people', status: 'all', available: 0, busy: 4 });
    expect(names(out.result.data)).toEqual(['Aditya Kulkarni', 'Imran Sheikh', 'Lakshmi Narayan', 'Nisha Pillai']);
  });
  it('says so when a team has nobody active', async () => {
    const roster = vi.fn(async () => success([{ id: 'u1', name: 'Neha Joshi', teams: ['Finance Systems'], open: [] }]));
    const out = await list({ team: 'Payroll', status: 'available' }, freshState(), { desk: { roster } });
    expect(out.result.say).toBe("I can't find anyone active in the Payroll team in ServiceNow.");
    expect(out.state.itdesk.board).toMatchObject({ kind: 'people', title: 'Payroll', people: [], available: 0, busy: 0 });
    const none = await list({ team: 'all' }, freshState(), { desk: { roster: vi.fn(async () => success([] as Resource[])) } });
    expect(none.result.say).toBe("I can't find anyone active in the IT teams in ServiceNow.");
  });
  it('names the teams when it does not know one, without calling ServiceNow', async () => {
    const roster = vi.fn(async () => success([] as Resource[]));
    const out = await list({ team: 'Marketing' }, freshState(), { desk: { roster } });
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('unknown_team');
    expect(out.result.say).toBe("I don't know a team called Marketing. The teams are Service Desk, Network, Hardware, Software, Database, Finance Systems and Payroll.");
    expect((await list({ team: 'so' }, freshState(), { desk: { roster } })).result.error).toBe('unknown_team');
    expect(roster).not.toHaveBeenCalled();
  });
  it.each(['Network^ORactive=false', 'Payroll^assigned_to=x', 'net=work'])('refuses query operators in the team %j', async (team) => {
    const roster = vi.fn(async () => success([] as Resource[]));
    const out = await list({ team }, freshState(), { desk: { roster } });
    expect(out.result.error).toBe('invalid_team');
    expect(roster).not.toHaveBeenCalled();
  });
  it('rejects a status it does not know', async () => {
    expect((await list({ status: 'sleeping' })).result.error).toBe('invalid_arguments');
  });
  it('is honest when ServiceNow fails and keeps the last board', async () => {
    const before = (await list({ team: 'Network' })).state;
    const roster = vi.fn(async () => failure<Resource[]>({ kind: 'timeout' }));
    const out = await list({ team: 'Payroll', status: 'available' }, before, { desk: { roster } });
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('desk_unavailable');
    expect(out.result.say).toBe("I couldn't read the IT teams: ServiceNow did not answer in time.");
    expect(out.state.itdesk.board).toEqual(before.itdesk.board);
    const denied = await list({}, freshState(), { desk: { roster: vi.fn(async () => failure<Resource[]>({ kind: 'unauthorized', status: 403 })) } });
    expect(denied.result.say).toBe("I couldn't read the IT teams: ServiceNow refused our credentials.");
  });
  it('shows names and tickets on the board, never ids', async () => {
    const s = (await list({ team: 'Finance Systems' })).state;
    const v = buildItDeskView(s, NOW);
    expect(v.board).toMatchObject({ kind: 'people', people: expect.arrayContaining([{ name: 'Karan Malhotra', teams: ['Finance Systems'], open: [expect.objectContaining({ number: 'INC0013012', priorityLabel: 'Moderate' }), expect.objectContaining({ number: 'INC0013013' })] }]) });
    expect(JSON.stringify(v)).not.toMatch(/sysId|sim-|"id"/);
  });
  it('hands over to the assign flow, which keeps its group rule', async () => {
    let s = await opened('13005');
    s = (await list({ status: 'available' }, s)).state;
    const out = await call(s, 'prepareIncidentUpdate', { ticket: '', assignedTo: 'Don Goodliffe', assignmentGroup: 'Hardware', state: '', holdReason: '', urgency: '', impact: '', category: '', workNote: '', comment: '', resolutionNotes: '' });
    expect(out.status).toBe(200);
    expect(out.result.say).toBe('Ready to update I-N-C one three zero zero five: assign it to Don Goodliffe and move it to the Hardware group.');
  });
});

describe('showResource', () => {
  it('describes a busy engineer with their tickets', async () => {
    const out = await show("Karan's");
    expect(out.status).toBe(200);
    expect(out.result.say).toBe('Karan Malhotra is in Finance Systems and has 2 open tickets: I-N-C one three zero one two, Vendor payment file rejected by the bank, moderate priority; I-N-C one three zero one three, Invoice approvals stuck in the workflow, low priority.');
    expect(out.state.itdesk.board).toEqual({
      kind: 'person',
      person: {
        name: 'Karan Malhotra',
        teams: ['Finance Systems'],
        open: [
          { number: 'INC0013012', summary: 'Vendor payment file rejected by the bank', priority: 3, priorityLabel: 'Moderate' },
          { number: 'INC0013013', summary: 'Invoice approvals stuck in the workflow', priority: 4, priorityLabel: 'Low' },
        ],
      },
      at: NOW,
    });
  });
  it('describes a free engineer and offers the open incident', async () => {
    expect((await show('Neha Joshi')).result.say).toBe('Neha Joshi is in Finance Systems and is free right now.');
    expect((await show('arjun', await opened('13012'))).result.say).not.toMatch(/Should I assign/);
    const out = await show('arjun', await unowned('13012'));
    expect(out.result.say).toBe('Arjun Rao is in Network and has 1 open ticket: I-N-C one three zero zero nine, Branch office Wi-Fi dropping every hour, moderate priority. Should I assign it to Arjun?');
    expect(out.result.next).toMatch(/prepareIncidentUpdate with assignedTo set to Arjun Rao and assignmentGroup Network\./);
    expect((await show('Karan', await opened('13012'))).result.say).not.toMatch(/Should I assign/);
  });
  it('lists every team of someone in several', async () => {
    expect((await show('Beth')).result.say).toBe('Beth Anglin is in Service Desk, Hardware, Software and Database and is free right now.');
  });
  it('reads at most three tickets', async () => {
    const s = freshState();
    for (const n of [1, 2, 3]) busy(s, 'Neha Joshi', n);
    expect((await show('Neha', s)).result.say).toMatch(/has 3 open tickets: .*\.$/);
    busy(s, 'Neha Joshi', 4);
    expect((await show('Neha', s)).result.say).toMatch(/has 4 open tickets: (I-N-C [^;]+; ){2}I-N-C [^;]+, and 1 more is on your screen\.$/);
  });
  it('asks which one when a name matches several people', async () => {
    const out = await show('David');
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('ambiguous_person');
    expect(out.result.say).toBe('Which David: David Dan or David Loo?');
    expect(out.state.itdesk.board).toBeNull();
    expect((await show('David Loo')).state.itdesk.board).toMatchObject({ kind: 'person', person: { name: 'David Loo' } });
  });
  it('says when it cannot find someone in the teams', async () => {
    const out = await show('Karthik');
    expect(out.result.error).toBe('unknown_person');
    expect(out.result.say).toBe("I can't find Karthik in the IT teams.");
  });
  it.each(['Neha^active=false', 'Neha=Joshi'])('refuses query operators in the name %j', async (name) => {
    const roster = vi.fn(async () => success([] as Resource[]));
    expect((await show(name, freshState(), { desk: { roster } })).result.error).toBe('invalid_name');
    expect(roster).not.toHaveBeenCalled();
  });
  it('is honest when ServiceNow fails', async () => {
    const out = await show('Neha', freshState(), { desk: { roster: vi.fn(async () => failure<Resource[]>({ kind: 'bad_response' })) } });
    expect(out.result.say).toBe("I couldn't read the IT teams: ServiceNow sent an unexpected response.");
  });
});
