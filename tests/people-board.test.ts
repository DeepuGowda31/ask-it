import { describe, expect, it, vi } from 'vitest';
import { followAssignment } from '@/lib/domain/people-board';
import { TEAMS, readBoard, refreshBoard } from '@/lib/domain/tools/itdesk';
import { failure, success } from '@/lib/integrations/http';
import type { DeskIncident } from '@/lib/integrations/types';
import type { SessionState } from '@/lib/domain/types';
import { call, codeOf, freshState } from './helpers';

type Board = NonNullable<SessionState['itdesk']['board']>;

const NOW = 1_795_000_000_000;
const ticket = (number: string) => ({ number, summary: `Issue ${number}`, priority: 3, priorityLabel: '3 - Moderate' });
const incident = (over: Partial<DeskIncident>): DeskIncident => ({
  number: 'INC0010049',
  sysId: 'a'.repeat(32),
  summary: 'Install Python version 13.1',
  priority: 3,
  priorityLabel: '3 - Moderate',
  state: '2',
  stateLabel: 'In Progress',
  holdReason: null,
  assignee: null,
  group: null,
  caller: null,
  category: null,
  urgency: 2,
  impact: 2,
  openedAt: NOW,
  ...over,
});
const people = (): Board => ({
  kind: 'people',
  title: 'Software',
  status: 'all',
  available: 2,
  busy: 1,
  at: NOW,
  people: [
    { name: 'Beth Anglin', teams: ['Software'], open: [] },
    { name: 'Fred Luddy', teams: ['Software'], open: [] },
    { name: 'Meera Krishnan', teams: ['Software'], open: [ticket('INC0010033')] },
  ],
});
const cards = (b: Board) => (b.kind === 'people' ? b.people.map((p) => [p.name, p.open.map((t) => t.number)]) : []);
const counts = (b: Board) => (b.kind === 'people' ? [b.available, b.busy] : []);

describe('followAssignment', () => {
  it('makes a free engineer busy as soon as an incident is assigned to them', () => {
    const b = followAssignment(people(), incident({ assignee: { id: 'b'.repeat(32), name: 'Beth Anglin' } }));
    expect(cards(b)).toEqual([['Beth Anglin', ['INC0010049']], ['Fred Luddy', []], ['Meera Krishnan', ['INC0010033']]]);
    expect(counts(b)).toEqual([1, 2]);
    expect(b.at).toBe(NOW);
  });
  it('frees the previous assignee when the incident moves to someone else', () => {
    const b = followAssignment(people(), incident({ number: 'INC0010033', assignee: { id: 'c'.repeat(32), name: 'Fred Luddy' } }));
    expect(cards(b)).toEqual([['Beth Anglin', []], ['Fred Luddy', ['INC0010033']], ['Meera Krishnan', []]]);
    expect(counts(b)).toEqual([2, 1]);
  });
  it('drops a resolved, closed or unassigned incident from every card', () => {
    for (const change of [{ state: '6', assignee: { id: 'd'.repeat(32), name: 'Meera Krishnan' } }, { state: '7' }, { assignee: null }]) {
      const b = followAssignment(people(), incident({ number: 'INC0010033', ...change }));
      expect(cards(b)).toEqual([['Beth Anglin', []], ['Fred Luddy', []], ['Meera Krishnan', []]]);
      expect(counts(b)).toEqual([3, 0]);
    }
  });
  it('does not add a ticket twice and updates its details in place', () => {
    const b = followAssignment(people(), incident({ number: 'INC0010033', priority: 1, priorityLabel: '1 - Critical', assignee: { id: 'd'.repeat(32), name: 'Meera Krishnan' } }));
    expect(b.kind === 'people' && b.people[2].open).toEqual([{ number: 'INC0010033', summary: 'Install Python version 13.1', priority: 1, priorityLabel: '1 - Critical' }]);
    expect(counts(b)).toEqual([2, 1]);
  });
  it('leaves the board alone for someone who is not on it', () => {
    const before = people();
    expect(followAssignment(before, incident({ assignee: { id: 'e'.repeat(32), name: 'Arjun Rao' } }))).toEqual(before);
  });
  it('follows a single person card too', () => {
    const b = followAssignment({ kind: 'person', person: { name: 'Fred Luddy', teams: ['Software'], open: [] }, at: NOW }, incident({ assignee: { id: 'c'.repeat(32), name: 'Fred Luddy' } }));
    expect(b.kind === 'person' && b.person.open.map((t) => t.number)).toEqual(['INC0010049']);
  });
  it('returns other boards unchanged', () => {
    const dash: Board = { kind: 'impact', at: NOW };
    expect(followAssignment(dash, incident({ assignee: { id: 'b'.repeat(32), name: 'Beth Anglin' } }))).toBe(dash);
  });
});

describe('people on screen after an assignment by voice', () => {
  const UPDATE = { ticket: '', assignedTo: '', assignmentGroup: '', state: '', holdReason: '', urgency: '', impact: '', category: '', workNote: '', comment: '', resolutionNotes: '' };
  it('shows the engineer as busy as soon as the yes is saved, without asking ServiceNow again', async () => {
    let s = (await call(freshState(), 'openIncident', { ticket: '13001' })).state;
    s = (await call(s, 'listResources', { team: 'all', status: 'available' })).state;
    const before = s.itdesk.board;
    if (before?.kind !== 'people') throw new Error('no people board');
    const name = before.people[0].name;
    const prep = await call(s, 'prepareIncidentUpdate', { ...UPDATE, assignedTo: name });
    const done = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) });
    const after = done.state.itdesk.board;
    if (after?.kind !== 'people') throw new Error('no people board');
    expect(after.people.find((p) => p.name === name)?.open.map((t) => t.number)).toEqual(['INC0013001']);
    expect([after.available, after.busy]).toEqual([before.available - 1, before.busy + 1]);
  });
});

describe('offering to assign', () => {
  const opened = async (ticket: string) => (await call(freshState(), 'openIncident', { ticket })).state;
  it('asks who should take the open incident only while nobody owns it', async () => {
    const free = await call(await opened('13001'), 'listResources', { team: 'all', status: 'available' });
    expect(free.result.say).toMatch(/Who should take it\?$/);
    expect(free.result.next).toMatch(/prepareIncidentUpdate/);
    const owned = await call(await opened('13002'), 'listResources', { team: 'all', status: 'available' });
    expect(owned.result.say).not.toMatch(/Who should take it/);
    expect(owned.result.next).toBeUndefined();
  });
  it('offers one engineer for the open incident only while nobody owns it', async () => {
    const free = await call(await opened('13001'), 'showResource', { name: 'David Loo' });
    expect(free.result.say).toMatch(/Should I assign it to David\?$/);
    const owned = await call(await opened('13002'), 'showResource', { name: 'David Loo' });
    expect(owned.result.say).not.toMatch(/Should I assign/);
    expect(owned.result.next).toBeUndefined();
  });
});

describe('people boards follow ServiceNow', () => {
  const person = (name: string, teams: string[], open: string[]) => ({ id: name.toLowerCase().replace(' ', '.'), name, teams, open: open.map(ticket) });
  const roster = [person('Neha Joshi', ['Finance Systems'], ['INC0010049']), person('Priyanka Das', ['Finance Systems'], []), person('Karan Malhotra', ['Finance Systems'], ['INC0010002']), person('Arjun Rao', ['Network'], [])];
  const desk = (board: Board) => ({ ...freshState().itdesk, board });
  const free: Board = { kind: 'people', title: 'Finance Systems', status: 'available', available: 2, busy: 1, at: NOW, people: [{ name: 'Neha Joshi', teams: ['Finance Systems'], open: [] }, { name: 'Priyanka Das', teams: ['Finance Systems'], open: [] }] };

  it('reads the roster again for a people or person board', async () => {
    const read = vi.fn(async () => success(roster));
    expect(await readBoard({ roster: read } as never, free, NOW)).toEqual({ roster: success(roster) });
    expect(read).toHaveBeenCalledWith(TEAMS);
  });
  it('drops someone who picked up work in ServiceNow from the free list and recounts', () => {
    const out = refreshBoard(desk(free), { roster: success(roster) }, NOW + 1000);
    expect(out?.board).toEqual({ ...free, available: 1, busy: 2, people: [{ name: 'Priyanka Das', teams: ['Finance Systems'], open: [] }] });
  });
  it('keeps the whole team for an all board and every team for All teams', () => {
    const all = refreshBoard(desk({ ...free, title: 'All teams', status: 'all' }), { roster: success(roster) }, NOW);
    expect(all?.board?.kind === 'people' && all.board.people.map((p) => p.name)).toEqual(['Neha Joshi', 'Priyanka Das', 'Karan Malhotra', 'Arjun Rao']);
    expect(all?.board?.kind === 'people' && [all.board.available, all.board.busy]).toEqual([2, 2]);
  });
  it('updates one person, and keeps the screen when they are gone or the read failed', () => {
    const one: Board = { kind: 'person', person: { name: 'Neha Joshi', teams: ['Finance Systems'], open: [] }, at: NOW };
    expect(refreshBoard(desk(one), { roster: success(roster) }, NOW)?.board).toEqual({ ...one, person: { name: 'Neha Joshi', teams: ['Finance Systems'], open: [ticket('INC0010049')] } });
    expect(refreshBoard(desk({ ...one, person: { ...one.person, name: 'Someone Else' } }), { roster: success(roster) }, NOW)).toBeNull();
    expect(refreshBoard(desk(free), { roster: failure({ kind: 'network' }) }, NOW)).toBeNull();
  });
});
