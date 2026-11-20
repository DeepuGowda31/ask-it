import type { Activity, DeskIncident } from '@/lib/integrations/types';
import { groupIncidents } from './queue-query';
import { DAY, isoDate, zonedTime } from './time';

const PRIORITIES = ['Critical', 'High', 'Moderate', 'Low'] as const;
const STATES = [['1', 'New'], ['2', 'In Progress'], ['3', 'On Hold']] as const;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS = 7;

export interface Dashboard {
  total: number;
  more: boolean;
  critical: number;
  unassigned: number;
  inProgress: number;
  onHold: number;
  openedToday: number;
  resolvedToday: number;
  resolvedWeek: number;
  // Mean of resolved minus opened over the week's resolutions that know both; null when there are none.
  avgResolve: { ms: number; count: number } | null;
  oldest: { number: string; openedAt: number } | null;
  byState: { label: string; count: number }[];
  byPriority: { label: string; count: number }[];
  byTeam: { label: string; count: number }[];
  days: { label: string; opened: number; resolved: number }[];
}

// Start of the India-time day `back` days before today.
const dayStart = (now: number, back = 0) => zonedTime(isoDate(zonedTime(isoDate(now), 0) - back * DAY + DAY / 2), 0);

function dayLabel(start: number, now: number): string {
  if (isoDate(start) === isoDate(now)) return 'Today';
  const [y, m, d] = isoDate(start).split('-').map(Number);
  return `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d}`;
}

// Where the seven daily bars start.
export const weekStart = (now: number) => dayStart(now, DAYS - 1);

function averageResolve(resolved: Activity['resolved']): Dashboard['avgResolve'] {
  const spans = resolved.flatMap((r) => (r.openedAt !== null && r.openedAt <= r.at ? [r.at - r.openedAt] : []));
  return spans.length ? { ms: Math.round(spans.reduce((a, b) => a + b, 0) / spans.length), count: spans.length } : null;
}

function oldestOf(open: DeskIncident[]): Dashboard['oldest'] {
  const known = open.filter((i): i is DeskIncident & { openedAt: number } => i.openedAt !== null);
  const first = known.reduce<(typeof known)[number] | null>((a, i) => (!a || i.openedAt < a.openedAt ? i : a), null);
  return first ? { number: first.number, openedAt: first.openedAt } : null;
}

// The desk at a glance; every number comes from the open incidents and the last week's activity.
export function buildDashboard(open: DeskIncident[], more: boolean, activity: Activity, now: number): Dashboard {
  const starts = Array.from({ length: DAYS }, (_, i) => dayStart(now, DAYS - 1 - i));
  const sameDay = (t: number, day: number) => isoDate(t) === isoDate(day);
  const week = activity.resolved.filter((r) => r.at >= weekStart(now) && r.at <= now);
  const inState = (code: string) => open.filter((i) => i.state === code).length;
  return {
    total: open.length,
    more,
    critical: open.filter((i) => i.priority === 1).length,
    unassigned: open.filter((i) => !i.assignee).length,
    inProgress: inState('2'),
    onHold: inState('3'),
    openedToday: activity.opened.filter((t) => sameDay(t, now)).length,
    resolvedToday: week.filter((r) => sameDay(r.at, now)).length,
    resolvedWeek: week.length,
    avgResolve: averageResolve(week),
    oldest: oldestOf(open),
    byState: STATES.map(([code, label]) => ({ label, count: inState(code) })),
    byPriority: PRIORITIES.map((label, n) => ({ label, count: open.filter((i) => Math.min(i.priority, 4) === n + 1).length })),
    byTeam: groupIncidents(open, 'group', now),
    days: starts.map((start) => ({ label: dayLabel(start, now), opened: activity.opened.filter((t) => sameDay(t, start)).length, resolved: week.filter((r) => sameDay(r.at, start)).length })),
  };
}
