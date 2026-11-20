import type { DeskIncident, Opened, PriorityFilter, QueueQuery, QueueSort, StateFilter } from '@/lib/integrations/types';
import { DAY, isoDate, zonedTime } from './time';
import type { Args } from './tools/shared';
import type { GroupBy } from './types';

const PRIORITIES: readonly PriorityFilter[] = ['critical', 'high', 'moderate', 'low', 'urgent'];
const STATE_FILTERS: readonly StateFilter[] = ['new', 'in_progress', 'on_hold', 'resolved', 'closed', 'canceled'];
const OPENED: readonly Opened[] = ['today', 'yesterday', 'last_24h', 'this_week', 'last_7_days', 'this_month'];
export const SORTS: readonly QueueSort[] = ['priority', 'newest', 'oldest'];
export const GROUP_BY: readonly GroupBy[] = ['priority', 'state', 'assignee', 'group', 'category', 'opened'];
export const CATEGORIES = ['inquiry', 'software', 'hardware', 'network', 'database'];

// The filter params listQueue and countIncidents share; every one is optional.
export const QUERY_PARAMS = {
  priority: { description: 'critical, high, moderate, low, or urgent (critical or high); empty string for any', enum: PRIORITIES, allowEmpty: true },
  state: { description: 'new, in_progress, on_hold, resolved, closed or canceled; empty string for any open state (new, in progress or on hold)', enum: STATE_FILTERS, allowEmpty: true },
  assignee: { description: 'A person\'s name, "unassigned", or "assigned" for anyone; empty string for any', allowEmpty: true },
  group: { description: 'Assignment group name or part of it, e.g. "network"; empty string for any', allowEmpty: true },
  category: { description: `${CATEGORIES.join(', ')}; empty string for any`, enum: CATEGORIES, allowEmpty: true },
  opened: { description: 'When it was opened: today, yesterday, last_24h, this_week, last_7_days or this_month; empty string for any time', enum: OPENED, allowEmpty: true },
  keyword: { description: 'Words from the title, e.g. "vpn"; empty string for none', allowEmpty: true },
};

const NONE = /^(unassigned|nobody|no one|none|noone)$/;
const ANYONE = /^(assigned|anyone|someone|somebody)$/;
const NAME = /^[\p{L}][\p{L} .'-]{0,59}$/u;
const STOP = new Set('the a an and or of on in for with about to is it that this one ones issue issues problem problems ticket tickets incident incidents'.split(' '));
const MAX_WORDS = 4;

export function openedRange(opened: Opened, now: number): { since: number; before?: number } {
  const today = zonedTime(isoDate(now), 0);
  const yesterday = zonedTime(isoDate(today - 1), 0);
  const weekday = new Date(`${isoDate(now)}T00:00:00Z`).getUTCDay();
  switch (opened) {
    case 'today':
      return { since: today };
    case 'yesterday':
      return { since: yesterday, before: today };
    case 'last_24h':
      return { since: now - DAY };
    case 'this_week':
      return { since: zonedTime(isoDate(today - ((weekday + 6) % 7) * DAY), 0) };
    case 'last_7_days':
      return { since: now - 7 * DAY };
    case 'this_month':
      return { since: zonedTime(`${isoDate(now).slice(0, 8)}01`, 0) };
  }
}

// Validated tool args to a query; free-text fields that could break a ServiceNow query are refused.
export function parseQueueArgs(args: Args, now: number): { ok: true; query: QueueQuery } | { ok: false; field: string } {
  const q: QueueQuery = { sort: (args.sort as QueueSort) || 'priority' };
  if (args.priority) q.priority = args.priority as PriorityFilter;
  if (args.state) q.state = args.state as StateFilter;
  const who = args.assignee?.trim() ?? '';
  if (who) {
    const lower = who.toLowerCase();
    if (NONE.test(lower)) q.assignee = { kind: 'none' };
    else if (ANYONE.test(lower)) q.assignee = { kind: 'any' };
    else if (NAME.test(who)) q.assignee = { kind: 'name', name: who };
    else return { ok: false, field: 'assignee' };
  }
  const group = args.group?.trim() ?? '';
  if (group) {
    if (!NAME.test(group)) return { ok: false, field: 'group' };
    q.group = group;
  }
  if (args.category) q.category = args.category;
  if (args.opened) Object.assign(q, { opened: args.opened as Opened }, openedRange(args.opened as Opened, now));
  const words = (args.keyword ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).slice(0, MAX_WORDS);
  if (words.length) q.words = words;
  return { ok: true, query: q };
}

const PRIORITY_WORD: Record<PriorityFilter, string> = { critical: 'critical', high: 'high-priority', moderate: 'moderate-priority', low: 'low-priority', urgent: 'critical or high-priority' };
const STATE_WORD: Record<StateFilter, string> = { new: 'new', in_progress: 'in-progress', on_hold: 'on-hold', resolved: 'resolved', closed: 'closed', canceled: 'canceled' };
const OPENED_WORD: Record<Opened, string> = {
  today: 'opened today',
  yesterday: 'opened yesterday',
  last_24h: 'opened in the last 24 hours',
  this_week: 'opened this week',
  last_7_days: 'opened in the last 7 days',
  this_month: 'opened this month',
};
const SORT_WORD: Record<QueueSort, string> = { priority: '', newest: ', newest first', oldest: ', oldest first' };

// "Critical unassigned incidents opened today" for the screen, "2 critical ... incidents" for speech.
export function describeQuery(q: QueueQuery): { title: string; noun: (n: number) => string; phrase: (n: number) => string } {
  const adjectives = [q.priority && PRIORITY_WORD[q.priority], q.state && STATE_WORD[q.state], q.assignee?.kind === 'none' && 'unassigned'].filter(Boolean);
  const tail = [
    q.assignee?.kind === 'any' && 'assigned to someone',
    q.assignee?.kind === 'name' && `assigned to ${q.assignee.name}`,
    q.group && `in the ${q.group} group`,
    q.category && `in the ${q.category} category`,
    q.words && `about “${q.words.join(' ')}”`,
    q.opened && OPENED_WORD[q.opened],
  ].filter(Boolean);
  const lead = adjectives.length || tail.length ? adjectives.join(' ') : 'open';
  const noun = (n: number) => `${lead ? `${lead} ` : ''}${n === 1 ? 'incident' : 'incidents'}${tail.length ? ` ${tail.join(' ')}` : ''}`;
  const title = noun(2) + SORT_WORD[q.sort];
  return { title: title.charAt(0).toUpperCase() + title.slice(1), noun, phrase: (n) => `${n} ${noun(n)}` };
}

const PRIORITY_LEVELS: Record<PriorityFilter, number[]> = { critical: [1], high: [2], moderate: [3], low: [4, 5], urgent: [1, 2] };
const STATE_CODE: Record<StateFilter, string> = { new: '1', in_progress: '2', on_hold: '3', resolved: '6', closed: '7', canceled: '8' };
const OPEN_STATES = ['1', '2', '3'];
const has = (value: string | undefined | null, part: string) => Boolean(value?.toLowerCase().includes(part.toLowerCase()));

// The same rules the ServiceNow query applies, for the simulated desk.
export function matchesQuery(i: DeskIncident, q: QueueQuery): boolean {
  if (q.priority && !PRIORITY_LEVELS[q.priority].includes(i.priority)) return false;
  if (q.state ? i.state !== STATE_CODE[q.state] : !OPEN_STATES.includes(i.state)) return false;
  if (q.assignee?.kind === 'none' && i.assignee) return false;
  if (q.assignee?.kind === 'any' && !i.assignee) return false;
  if (q.assignee?.kind === 'name' && !has(i.assignee?.name, q.assignee.name)) return false;
  if (q.group && !has(i.group?.name, q.group)) return false;
  if (q.category && i.category !== q.category) return false;
  if (q.since !== undefined && (i.openedAt === null || i.openedAt < q.since)) return false;
  if (q.before !== undefined && (i.openedAt === null || i.openedAt >= q.before)) return false;
  return !q.words || q.words.every((w) => has(i.summary, w));
}

export function sortIncidents<T extends DeskIncident>(list: T[], sort: QueueSort): T[] {
  const opened = (i: DeskIncident) => i.openedAt ?? 0;
  const by: Record<QueueSort, (a: DeskIncident, b: DeskIncident) => number> = {
    priority: (a, b) => a.priority - b.priority || opened(a) - opened(b),
    newest: (a, b) => opened(b) - opened(a),
    oldest: (a, b) => opened(a) - opened(b),
  };
  return [...list].sort(by[sort]);
}

const MAX_GROUPS = 8;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(openedAt: number | null, now: number): { label: string; order: number } {
  if (openedAt === null) return { label: 'Unknown', order: Number.MAX_SAFE_INTEGER };
  const day = isoDate(openedAt);
  const ageDays = Math.round((zonedTime(isoDate(now), 0) - zonedTime(day, 0)) / DAY);
  if (ageDays === 0) return { label: 'Today', order: 0 };
  if (ageDays === 1) return { label: 'Yesterday', order: 1 };
  const [y, m, d] = day.split('-').map(Number);
  return { label: `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTH[m - 1]}`, order: ageDays };
}

// One bucket per value; ordered by its natural order, or by count with the empty bucket last. Long tails fold into Other.
export function groupIncidents(list: DeskIncident[], by: GroupBy, now: number): { label: string; count: number }[] {
  const buckets = new Map<string, { label: string; count: number; order: number; empty: boolean }>();
  for (const i of list) {
    const key =
      by === 'priority' ? { label: i.priorityLabel, order: i.priority, empty: false }
      : by === 'state' ? { label: i.stateLabel, order: Number(i.state), empty: false }
      : by === 'assignee' ? { label: i.assignee?.name ?? 'Unassigned', order: 0, empty: !i.assignee }
      : by === 'group' ? { label: i.group?.name ?? 'No group', order: 0, empty: !i.group }
      : by === 'category' ? { label: i.category ?? 'No category', order: 0, empty: !i.category }
      : { ...dayLabel(i.openedAt, now), empty: i.openedAt === null };
    const b = buckets.get(key.label) ?? { ...key, count: 0 };
    b.count += 1;
    buckets.set(key.label, b);
  }
  const natural = by === 'priority' || by === 'state' || by === 'opened';
  const sorted = [...buckets.values()].sort((a, b) =>
    natural ? a.order - b.order : b.count - a.count || Number(a.empty) - Number(b.empty) || a.label.localeCompare(b.label),
  );
  const rows = sorted.map(({ label, count }) => ({ label, count }));
  if (rows.length <= MAX_GROUPS) return rows;
  const rest = rows.slice(MAX_GROUPS - 1).reduce((n, r) => n + r.count, 0);
  return [...rows.slice(0, MAX_GROUPS - 1), { label: 'Other', count: rest }];
}
