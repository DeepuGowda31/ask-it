import { describe, expect, it } from 'vitest';
import { buildDashboard } from '@/lib/domain/dashboard';
import { seedBacklog } from '@/lib/domain/desk-seed';
import { DAY, MINUTE, zonedTime } from '@/lib/domain/time';
import type { DeskIncident } from '@/lib/integrations/types';
import { NOW } from './helpers';

const OPEN: DeskIncident[] = seedBacklog(NOW).slice(0, 7).map(({ notes: _notes, ...i }) => i);
const TODAY = zonedTime('2026-11-18', 0);
const HOUR = 60 * MINUTE;

describe('buildDashboard', () => {
  it('counts the headline numbers from the open incidents', () => {
    const d = buildDashboard(OPEN, false, { opened: [NOW - MINUTE, zonedTime('2026-11-18', 0), NOW - DAY], resolved: [] }, NOW);
    expect(d).toMatchObject({ total: 7, more: false, critical: 3, unassigned: 4, openedToday: 2, resolvedWeek: 0 });
    expect(d.openedToday).toBe(d.days.at(-1)?.opened);
  });
  it('always shows the four priorities, zeros included, in order', () => {
    const d = buildDashboard(OPEN.filter((i) => i.priority === 1), false, { opened: [], resolved: [] }, NOW);
    expect(d.byPriority).toEqual([
      { label: 'Critical', count: 3 },
      { label: 'High', count: 0 },
      { label: 'Moderate', count: 0 },
      { label: 'Low', count: 0 },
    ]);
  });
  it('folds planning priority into low', () => {
    const planning = { ...OPEN[0], priority: 5, priorityLabel: 'Planning' };
    expect(buildDashboard([planning], false, { opened: [], resolved: [] }, NOW).byPriority.at(-1)).toEqual({ label: 'Low', count: 1 });
  });
  it('ranks teams by open incidents', () => {
    expect(buildDashboard(OPEN, false, { opened: [], resolved: [] }, NOW).byTeam[0]).toEqual({ label: 'Software', count: 2 });
  });
  it('buckets new and resolved incidents into the last seven India-time days, oldest first', () => {
    const opened = [NOW, TODAY, TODAY - 1, TODAY - DAY, TODAY - 6 * DAY, TODAY - 6 * DAY - 1];
    const resolved = [NOW - MINUTE, TODAY - 2 * DAY + MINUTE, TODAY - 7 * DAY].map((at) => ({ at, openedAt: null }));
    const d = buildDashboard(OPEN, false, { opened, resolved }, NOW);
    expect(d.days.map((x) => x.label)).toEqual(['Thu 12', 'Fri 13', 'Sat 14', 'Sun 15', 'Mon 16', 'Tue 17', 'Today']);
    expect(d.days.map((x) => x.opened)).toEqual([1, 0, 0, 0, 0, 2, 2]);
    expect(d.days.map((x) => x.resolved)).toEqual([0, 0, 0, 0, 1, 0, 1]);
    expect(d.resolvedWeek).toBe(2);
    expect(d.resolvedToday).toBe(1);
  });
  it('counts open incidents by state, with on hold as its own number', () => {
    const d = buildDashboard(OPEN, false, { opened: [], resolved: [] }, NOW);
    expect(d.byState).toEqual([
      { label: 'New', count: 3 },
      { label: 'In Progress', count: 3 },
      { label: 'On Hold', count: 1 },
    ]);
    expect(d).toMatchObject({ inProgress: 3, onHold: 1 });
  });
  it('names the oldest open incident', () => {
    expect(buildDashboard(OPEN, false, { opened: [], resolved: [] }, NOW).oldest).toEqual({ number: 'INC0013006', openedAt: NOW - 4 * DAY });
    expect(buildDashboard([{ ...OPEN[0], openedAt: null }], false, { opened: [], resolved: [] }, NOW).oldest).toBeNull();
  });
  it('averages the time to resolve over the incidents resolved in the last seven days that know when they were opened', () => {
    const resolved = [
      { at: NOW - MINUTE, openedAt: NOW - MINUTE - 2 * HOUR },
      { at: TODAY - 3 * DAY, openedAt: TODAY - 4 * DAY },
      { at: TODAY - 2 * DAY, openedAt: null },
      { at: TODAY - 8 * DAY, openedAt: TODAY - 9 * DAY },
    ];
    expect(buildDashboard(OPEN, false, { opened: [], resolved }, NOW).avgResolve).toEqual({ ms: 13 * HOUR, count: 2 });
    expect(buildDashboard(OPEN, false, { opened: [], resolved: [] }, NOW).avgResolve).toBeNull();
  });
  it('is all zeros for an empty desk', () => {
    const d = buildDashboard([], false, { opened: [], resolved: [] }, NOW);
    expect(d).toMatchObject({ total: 0, critical: 0, unassigned: 0, inProgress: 0, onHold: 0, openedToday: 0, resolvedToday: 0, resolvedWeek: 0, byTeam: [], oldest: null, avgResolve: null });
    expect(d.days.every((x) => x.opened === 0 && x.resolved === 0)).toBe(true);
  });
  it('passes the more flag through when the open list was capped', () => {
    expect(buildDashboard(OPEN, true, { opened: [], resolved: [] }, NOW).more).toBe(true);
  });
});
