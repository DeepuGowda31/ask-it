import type { Activity, DeskIncident } from '@/lib/integrations/types';
import { groupIncidents } from './queue-query';
import { DAY, isoDate, zonedTime } from './time';

const PRIORITIES = ['Critical', 'High', 'Moderate', 'Low'] as const;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS = 7;

export interface Dashboard {
  total: number;
  more: boolean;
  critical: number;
  unassigned: number;
  openedToday: number;
  resolvedWeek: number;
  byPriority: { label: string; count: number }[];
  byTeam: { label: string; count: number }[];
  days: { label: string; opened: number }[];
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

// The desk at a glance; every number comes from the open incidents and the last week's activity.
export function buildDashboard(open: DeskIncident[], more: boolean, activity: Activity, now: number): Dashboard {
  const starts = Array.from({ length: DAYS }, (_, i) => dayStart(now, DAYS - 1 - i));
  return {
    total: open.length,
    more,
    critical: open.filter((i) => i.priority === 1).length,
    unassigned: open.filter((i) => !i.assignee).length,
    openedToday: activity.opened.filter((t) => isoDate(t) === isoDate(now)).length,
    resolvedWeek: activity.resolved.filter((t) => t >= weekStart(now) && t <= now).length,
    byPriority: PRIORITIES.map((label, n) => ({ label, count: open.filter((i) => Math.min(i.priority, 4) === n + 1).length })),
    byTeam: groupIncidents(open, 'group', now),
    days: starts.map((start) => ({ label: dayLabel(start, now), opened: activity.opened.filter((t) => isoDate(t) === isoDate(start)).length })),
  };
}
