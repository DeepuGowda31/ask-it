import { describeFailure, success, type Failure, type Result } from '@/lib/integrations/http';
import type { Activity, DeskAdapter, DeskIncident, Mode, Opened, QueueQuery, QueueSort, Ref, Resource, WorkNote } from '@/lib/integrations/types';
import { buildDashboard, weekStart, type Dashboard } from '../dashboard';
import { CATEGORIES, GROUP_BY, QUERY_PARAMS, SORTS, describeQuery, groupIncidents, parseQueueArgs } from '../queue-query';
import { parseTicketNumber, spokenDigits, spokenTicket } from '../tickets';
import { DAY, MINUTE, formatTime } from '../time';
import type { GroupBy, OpenIncident, PersonCard, ResourceStatus, SessionState } from '../types';
import { alertSay, failed, ok, plural, prepare, tool, type Args, type Outcome } from './shared';
import { queueAlert } from '../actions';

const IT = ['itdesk' as const];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const STOP = new Set('the a an one incident ticket about with for of on in that this is it'.split(' '));
const LEVELS: Record<string, string> = { high: '1', medium: '2', low: '3', '1': '1', '2': '2', '3': '3' };
const LEVEL_WORD: Record<string, string> = { '1': 'high', '2': 'medium', '3': 'low' };
const STATES: Record<string, string> = { new: '1', 'in progress': '2', inprogress: '2', working: '2', 'on hold': '3', onhold: '3', hold: '3', resolved: '6', resolve: '6', fixed: '6' };
const HOLD_REASONS: Record<string, string> = { 'awaiting caller': '1', caller: '1', 'awaiting problem': '3', problem: '3', 'awaiting vendor': '4', vendor: '4', 'awaiting change': '5', change: '5' };
export const HOLD_WORD: Record<string, string> = { '1': 'awaiting caller', '3': 'awaiting problem', '4': 'awaiting vendor', '5': 'awaiting change' };
const NOBODY = /^(nobody|no one|unassigned|unassign|remove|clear)$/;
// What a model writes for "leave this field alone"; never a value, and never a request to clear.
const PLACEHOLDER = /^(none|n a|na|null|nil|no change|unchanged|same|keep|leave it|not given)$/;
const PRIORITY_SETS: Record<string, { word: string; urgency: string; impact: string }> = {
  critical: { word: 'critical', urgency: '1', impact: '1' },
  high: { word: 'high', urgency: '1', impact: '2' },
  moderate: { word: 'moderate', urgency: '2', impact: '2' },
  medium: { word: 'moderate', urgency: '2', impact: '2' },
  low: { word: 'low', urgency: '2', impact: '3' },
};
const CHOSEN = ['assignedTo', 'assignmentGroup', 'state', 'holdReason', 'priority', 'urgency', 'impact', 'category'] as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// "A, B or C"
const orList = (items: string[], last = 'or') => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}`);

export function incidentAge(openedAt: number | null, now: number): string {
  if (openedAt === null) return 'at an unknown time';
  const minutes = Math.max(1, Math.round((now - openedAt) / MINUTE));
  const days = Math.floor((now - openedAt) / DAY);
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  if (now - openedAt < DAY) return `${plural(Math.round(minutes / 60), 'hour')} ago`;
  if (days < 60) return `${plural(Math.round((now - openedAt) / DAY), 'day')} ago`;
  if (days < 365) return `over ${Math.floor(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'over a year ago' : `over ${years} years ago`;
}

const failureOutcome = (title: string, error: string, f: Failure, what: string) => failed(title, error, `I couldn't ${what}: ${describeFailure('ServiceNow', f)}`);

const SCREEN_LIMIT = 25;
const COUNT_LIMIT = 500;
const READ_GROUPS = 4;
const GROUP_WORD: Record<GroupBy, string> = { priority: 'priority', state: 'state', assignee: 'assignee', group: 'group', category: 'category', opened: 'day opened' };

const badFilter = (field: string) => failed(`Queue: unclear ${field}`, 'invalid_filter', `I couldn't use that ${field}. Could you say it another way?`);

const DONE_STATES = new Set(['resolved', 'closed', 'canceled']);
const WIDER: Partial<Record<Opened, string>> = { today: 'this week', yesterday: 'this week', last_24h: 'this week', this_week: 'this month', last_7_days: 'this month' };
const SHOWN: Record<QueueSort, (n: number) => string> = { priority: (n) => `top ${n} by priority`, newest: (n) => `${n} newest`, oldest: (n) => `${n} oldest` };

// The filters as asked, empty ones left out, so the board can be read again later.
const boardQuery = (args: Args): Args => Object.fromEntries([...Object.keys(QUERY_PARAMS), 'sort'].filter((k) => args[k]).map((k) => [k, args[k]]));

const criticalOf = (list: DeskIncident[]) => list.filter((i) => i.priority === 1).length;
const unassignedOf = (list: DeskIncident[]) => list.filter((i) => !i.assignee).length;

// ", 2 critical and 3 unassigned", leaving out what the filter already fixes and what finished work cannot be.
function breakdown(list: DeskIncident[], q: QueueQuery): string {
  if (q.state && DONE_STATES.has(q.state)) return '';
  const parts = [!q.priority && criticalOf(list) && `${criticalOf(list)} critical`, !q.assignee && unassignedOf(list) && `${unassignedOf(list)} unassigned`].filter(Boolean);
  return parts.length ? `, ${parts.join(' and ')}` : '';
}

// A summary of the list on screen; the tickets themselves are never read one by one.
function queueSay(list: DeskIncident[], more: boolean, q: QueueQuery): string {
  const d = describeQuery(q);
  if (more) return `There are more than ${SCREEN_LIMIT} ${d.noun(2)}. The ${SHOWN[q.sort](SCREEN_LIMIT)} are on your screen. Want details on any of them, or a narrower filter?`;
  if (!list.length) {
    if (Object.keys(q).every((k) => k === 'sort')) return 'There are no open incidents right now. The queue is clear.';
    const wider = q.opened && WIDER[q.opened];
    return `There are no ${d.noun(0)}. ${wider ? `Want me to check ${wider} instead?` : 'Want me to widen the filter?'}`;
  }
  if (list.length === 1) return `There's one ${d.noun(1)}, ${spokenTicket(list[0].number)}, ${list[0].summary.trim().replace(/[.!?]+$/, '')}. Want the details?`;
  return `Here are ${d.phrase(list.length)}${breakdown(list, q)}. They're on your screen. Want details on any of them?`;
}

const listQueue = tool<Result<DeskIncident[]>>({
  name: 'listQueue',
  description: "List open ServiceNow incidents with any mix of filters. Everything found appears on the engineer's screen; the reply is a short summary, never the tickets one by one.",
  params: {
    ...QUERY_PARAMS,
    sort: { description: 'priority (default), newest or oldest; empty string for priority', enum: SORTS, allowEmpty: true },
  },
  personas: IT,
  minutesSaved: 2,
  async effect({ now, deps }, args) {
    const parsed = parseQueueArgs(args, now);
    return parsed.ok ? deps.desk.listOpen(parsed.query, SCREEN_LIMIT + 1) : undefined;
  },
  run({ state, now, effect }, args) {
    const parsed = parseQueueArgs(args, now);
    if (!parsed.ok) return badFilter(parsed.field);
    if (!effect || !effect.ok) return failureOutcome('Queue unavailable', 'queue_unavailable', effect && !effect.ok ? effect.error : { kind: 'network' }, 'read the queue');
    const d = describeQuery(parsed.query);
    const more = effect.value.length > SCREEN_LIMIT;
    const list = effect.value.slice(0, SCREEN_LIMIT);
    state.itdesk.queue = list;
    state.itdesk.board = { kind: 'list', title: d.title, total: list.length, more, at: now, query: boardQuery(args) };
    state.itdesk.focus = 'board';
    const incidents = list.map((i, n) => ({ position: n + 1, number: i.number, summary: i.summary, priority: i.priorityLabel, state: i.stateLabel, assignee: i.assignee?.name ?? null, group: i.group?.name ?? null, caller: i.caller }));
    return {
      title: list.length ? `Queue: ${more ? `${SCREEN_LIMIT}+ ${d.noun(2)}` : d.phrase(list.length)}` : `Queue: no ${d.noun(0)}`,
      result: ok(
        queueSay(list, more, parsed.query),
        { incidents, onScreen: list.length, more, critical: criticalOf(list), unassigned: unassignedOf(list) },
        list.length ? 'The list is on the engineer\'s screen: do not read it aloud. When they pick one, call openIncident with its number or position; "the second one" is position 2.' : undefined,
      ),
    };
  },
});

const countIncidents = tool<Result<DeskIncident[]>>({
  name: 'countIncidents',
  description: 'Count open ServiceNow incidents with any mix of filters, optionally broken down by priority, state, assignee, group, category or day opened. The numbers appear on the engineer\'s screen.',
  params: {
    ...QUERY_PARAMS,
    groupBy: { description: 'priority, state, assignee, group, category or opened (by day); empty string for just the total', enum: GROUP_BY, allowEmpty: true },
  },
  personas: IT,
  minutesSaved: 2,
  async effect({ now, deps }, args) {
    const parsed = parseQueueArgs(args, now);
    return parsed.ok ? deps.desk.listOpen(parsed.query, COUNT_LIMIT + 1) : undefined;
  },
  run({ state, now, effect }, args) {
    const parsed = parseQueueArgs(args, now);
    if (!parsed.ok) return badFilter(parsed.field);
    if (!effect || !effect.ok) return failureOutcome('Count unavailable', 'queue_unavailable', effect && !effect.ok ? effect.error : { kind: 'network' }, 'count the incidents');
    const d = describeQuery(parsed.query);
    const more = effect.value.length > COUNT_LIMIT;
    const list = effect.value.slice(0, COUNT_LIMIT);
    const groupBy = (args.groupBy || null) as GroupBy | null;
    const groups = groupBy ? groupIncidents(list, groupBy, now) : [];
    state.itdesk.board = { kind: 'count', title: d.title, total: list.length, more, groupBy, groups, at: now, query: boardQuery(args) };
    state.itdesk.focus = 'board';
    const total = more ? `are more than five hundred ${d.noun(2)}` : list.length === 0 ? `are no ${d.noun(0)}` : `${list.length === 1 ? 'is' : 'are'} ${d.phrase(list.length)}`;
    const read = groups.slice(0, READ_GROUPS).map((g) => `${g.label} ${g.count}`);
    const breakdown = groupBy && read.length ? ` By ${GROUP_WORD[groupBy]}: ${read.join(', ')}${groups.length > READ_GROUPS ? ', and the rest are on your screen' : ''}.` : '';
    return {
      title: `Count: ${more ? `${COUNT_LIMIT}+ ${d.noun(2)}` : d.phrase(list.length)}${groupBy ? ` by ${GROUP_WORD[groupBy]}` : ''}`,
      result: ok(`There ${total}.${breakdown}`, { total: list.length, more, groups }, 'The numbers are on the engineer\'s screen. Offer to list them with listQueue using the same filters.'),
    };
  },
});

// The dashboard's two reads: up to 501 open incidents and the last week's activity.
const dashboardReads = (desk: DeskAdapter, now: number) => Promise.all([desk.listOpen({ sort: 'priority' }, COUNT_LIMIT + 1), desk.activity(weekStart(now))]);
const dashboardOf = (open: DeskIncident[], activity: Activity, now: number) => buildDashboard(open.slice(0, COUNT_LIMIT), open.length > COUNT_LIMIT, activity, now);

type ItDesk = SessionState['itdesk'];
type Board = NonNullable<ItDesk['board']>;
// Incidents for a list, count or dashboard; the roster for people.
export interface BoardRead {
  rows?: Result<DeskIncident[]>;
  activity?: Result<Activity>;
  roster?: Result<Resource[]>;
}

export const boardReadOk = (read: BoardRead | null | undefined) => Boolean(read?.rows?.ok || read?.roster?.ok);

// A list, count or dashboard read again the way its tool read it; null for boards that do not come from the incident table.
export async function readBoard(desk: DeskAdapter, board: Board, now: number): Promise<BoardRead | null> {
  if (board.kind === 'dashboard') {
    const [rows, activity] = await dashboardReads(desk, now);
    return { rows, activity };
  }
  if (board.kind === 'people' || board.kind === 'person') return { roster: await desk.roster(TEAMS) };
  if ((board.kind !== 'list' && board.kind !== 'count') || !board.query) return null;
  const parsed = parseQueueArgs(board.query, now);
  return parsed.ok ? { rows: await desk.listOpen(parsed.query, (board.kind === 'list' ? SCREEN_LIMIT : COUNT_LIMIT) + 1) } : null;
}

// The board and its list as ServiceNow says now; when it was asked stays, so the screen does not replay its entry. Null when a read failed.
export function refreshBoard(desk: ItDesk, read: BoardRead, now: number): Pick<ItDesk, 'board' | 'queue'> | null {
  const board = desk.board;
  if (!board) return null;
  if (board.kind === 'people' || board.kind === 'person') return read.roster?.ok ? refreshPeople(desk, board, read.roster.value) : null;
  if (!read.rows?.ok) return null;
  const rows = read.rows.value;
  if (board.kind === 'list') return { queue: rows.slice(0, SCREEN_LIMIT), board: { ...board, total: Math.min(rows.length, SCREEN_LIMIT), more: rows.length > SCREEN_LIMIT, syncedAt: now } };
  if (board.kind === 'count') {
    const list = rows.slice(0, COUNT_LIMIT);
    return { queue: desk.queue, board: { ...board, total: list.length, more: rows.length > COUNT_LIMIT, groups: board.groupBy ? groupIncidents(list, board.groupBy, now) : [], syncedAt: now } };
  }
  if (board.kind === 'dashboard' && read.activity?.ok) return { queue: desk.queue, board: { kind: 'dashboard', at: board.at, ...dashboardOf(rows, read.activity.value, now), syncedAt: now } };
  return null;
}

// The headline in two or three short sentences; the rest is on screen.
function dashboardSay(d: Dashboard, now: number): string {
  const total = d.more ? 'more than five hundred open incidents' : plural(d.total, 'open incident');
  const open = d.total ? `Right now there ${d.total === 1 && !d.more ? 'is' : 'are'} ${total}, ${d.critical} critical, ${d.unassigned} unassigned and ${d.onHold} on hold.` : 'Right now there are no open incidents.';
  const flow = `${d.openedToday || 'None'} came in today and ${d.resolvedToday || 'none'} ${d.resolvedToday === 1 ? 'was' : 'were'} resolved today.`;
  const oldest = d.oldest ? ` The oldest was opened ${incidentAge(d.oldest.openedAt, now)}.` : '';
  return `${open} ${flow}${oldest} It's all on your screen.`;
}

const showDashboard = tool<{ open: Result<DeskIncident[]>; activity: Result<Activity> }>({
  name: 'showDashboard',
  description: "The service desk at a glance, shown as a dashboard on the engineer's screen: open, critical, unassigned, in progress and on hold incidents, new and resolved today, resolved this week, average time to resolve, the oldest open incident, open incidents by state, priority and team, and new and resolved incidents per day for the last seven days.",
  params: {},
  personas: IT,
  minutesSaved: 2,
  async effect({ now, deps }) {
    const [open, activity] = await dashboardReads(deps.desk, now);
    return { open, activity };
  },
  run({ state, now, effect }) {
    const failed = !effect ? { kind: 'network' as const } : !effect.open.ok ? effect.open.error : !effect.activity.ok ? effect.activity.error : null;
    if (!effect || failed || !effect.open.ok || !effect.activity.ok) return failureOutcome('Dashboard unavailable', 'queue_unavailable', failed ?? { kind: 'network' }, 'build the dashboard');
    const d = dashboardOf(effect.open.value, effect.activity.value, now);
    state.itdesk.board = { kind: 'dashboard', at: now, ...d };
    state.itdesk.focus = 'board';
    return { title: `Dashboard: ${plural(d.total, 'open incident')}`, result: ok(dashboardSay(d, now), { ...d }) };
  },
});

const showImpact = tool({
  name: 'showImpact',
  description: 'What ASK IT has done in this session: issues fixed on calls, tickets raised, duplicates avoided, incidents updated by voice and time saved. Shown on the engineer\'s screen.',
  params: {},
  personas: IT,
  run({ state, now }) {
    const m = state.metrics;
    state.itdesk.board = { kind: 'impact', at: now };
    state.itdesk.focus = 'board';
    const parts = [
      m.resolvedByAgent && `fixed ${plural(m.resolvedByAgent, 'issue')} on the call`,
      m.ticketsRaised && `raised ${plural(m.ticketsRaised, 'ticket')}`,
      m.duplicatesAvoided && `avoided ${plural(m.duplicatesAvoided, 'duplicate ticket')}`,
      m.ticketsUpdatedByVoice && `updated ${plural(m.ticketsUpdatedByVoice, 'incident')} by voice`,
    ].filter((p): p is string => Boolean(p));
    if (!parts.length) return { title: 'Impact: nothing yet', result: ok('Nothing yet: no issues have been handled in this session.') };
    const handled = m.resolvedByAgent + m.duplicatesAvoided;
    const outcomes = handled + m.ticketsRaised;
    const deflection = outcomes ? `, and ${Math.round((handled / outcomes) * 100)} percent of issues were handled without a new ticket` : '';
    const hours = Math.round(m.minutesSaved / 6) / 10;
    const say = `So far ASK IT ${orList(parts, 'and')}. That's about ${hours} hours saved${deflection}.`;
    return { title: 'Impact shown', result: ok(say, { ...m, deflectionRate: outcomes ? handled / outcomes : null }) };
  },
});

type Target = { kind: 'number'; number: string } | { kind: 'words'; words: string[] } | { kind: 'invalid' } | { kind: 'none' };

// A spoken number, a position in the last list, the open incident, or search words.
function target(state: SessionState, raw: string): Target {
  const q = raw.trim().toLowerCase();
  if (/[\^=]/.test(q)) return { kind: 'invalid' };
  if (!q || /^(it|this one|that one|this|that|current)$/.test(q)) return state.itdesk.current ? { kind: 'number', number: state.itdesk.current.number } : { kind: 'none' };
  const position = ORDINALS.findIndex((o) => new RegExp(`\\b${o}\\b`).test(q));
  const digits = spokenDigits(q);
  const index = position >= 0 ? position : /^\d{1,2}$/.test(digits) ? Number(digits) - 1 : -1;
  if (index >= 0 && state.itdesk.queue[index]) return { kind: 'number', number: state.itdesk.queue[index].number };
  if (digits.length >= 4) {
    const number = parseTicketNumber(q);
    return number ? { kind: 'number', number } : { kind: 'invalid' };
  }
  const words = norm(q.slice(0, 60))
    .split(' ')
    .filter((w) => w.length > 1 && !STOP.has(w))
    .slice(0, 4);
  return words.length ? { kind: 'words', words } : { kind: 'none' };
}

interface OpenEffect {
  found: Result<DeskIncident[]>;
  notes?: Result<WorkNote[]>;
}

async function lookup(desk: DeskAdapter, t: Target): Promise<Result<DeskIncident[]>> {
  if (t.kind === 'number') {
    const one = await desk.get(t.number);
    return one.ok ? success(one.value ? [one.value] : []) : one;
  }
  return t.kind === 'words' ? desk.search(t.words) : success([]);
}

const MISSING: [keyof DeskIncident, string, string][] = [
  ['assignee', 'an assignee', 'Who should own it?'],
  ['group', 'an assignment group', 'Which group should have it?'],
  ['category', 'a category', 'Which category: inquiry, software, hardware, network or database?'],
];

export const missingOf = (i: DeskIncident) => MISSING.filter(([key]) => !i[key]).map(([, label]) => label.replace(/^an? /, ''));

function describeIncident(i: OpenIncident, now: number): string {
  const assignment = i.assignee && i.group ? `Assigned to ${i.assignee.name} in ${i.group.name}.` : i.group ? `With ${i.group.name}, no assignee yet.` : i.assignee ? `Assigned to ${i.assignee.name}, no group.` : 'Not assigned to anyone yet.';
  const note = i.notes[0] ? ` Latest work note: ${i.notes[0].text.slice(0, 140).trim().replace(/[.!?]+$/, '')}.` : '';
  const gaps = MISSING.filter(([key]) => !i[key]);
  const ask = gaps.length ? ` It's missing ${orList(gaps.map(([, label]) => label), 'and')}. ${gaps[0][2]}` : ' What would you like to change?';
  const hold = i.holdReason && HOLD_WORD[i.holdReason] ? `, ${HOLD_WORD[i.holdReason]}` : '';
  return `${spokenTicket(i.number)}, ${i.summary}. ${i.priorityLabel}, ${i.stateLabel.toLowerCase()}${hold}, opened ${incidentAge(i.openedAt, now)}${i.caller ? ` by ${i.caller}` : ''}. ${assignment}${note}${ask}`;
}

// Keywords that match exactly one incident in the last list need no search.
function fromQueue(state: SessionState, t: Target): DeskIncident | undefined {
  if (t.kind !== 'words') return undefined;
  const hits = state.itdesk.queue.filter((i) => t.words.every((w) => i.summary.toLowerCase().includes(w)));
  return hits.length === 1 ? hits[0] : undefined;
}

const openIncident = tool<OpenEffect>({
  name: 'openIncident',
  description: 'Open one incident by number (spoken forms are fine), by position in the last list ("the second one"), or by words from its title. Returns its details, what is missing and the latest work notes.',
  params: { ticket: { description: 'Incident number, position like "second", or a few words from the title' } },
  personas: IT,
  minutesSaved: 1,
  async effect({ state, deps }, args) {
    const t = target(state, args.ticket);
    if (t.kind === 'invalid' || t.kind === 'none') return undefined;
    const queued = fromQueue(state, t);
    const found = queued ? await lookup(deps.desk, { kind: 'number', number: queued.number }) : await lookup(deps.desk, t);
    if (!found.ok || found.value.length !== 1) return { found };
    return { found, notes: await deps.desk.workNotes(found.value[0].sysId) };
  },
  run({ state, now, effect }, args) {
    const t = target(state, args.ticket);
    if (t.kind === 'invalid') return failed('Open incident: invalid search', 'invalid_search', 'I can only search with plain words or an incident number. Could you say it again?');
    if (t.kind === 'none') return failed('Open incident: nothing to open', 'unknown_incident', 'Which incident? Give me its number or a few words from the title.');
    if (!effect) return failed('Open incident: try again', 'try_again', 'That did not go through. Please try again.');
    if (!effect.found.ok) return failureOutcome('Open incident failed', 'desk_unavailable', effect.found.error, 'read that incident');
    const hits = effect.found.value;
    if (!hits.length) {
      const what = t.kind === 'number' ? spokenTicket(t.number) : 'an open incident matching that';
      return failed('Open incident: not found', 'unknown_incident', `I can't find ${what}.`);
    }
    if (hits.length > 1) {
      const say = `I found ${hits.length} matches: ${hits.map((i) => `${spokenTicket(i.number)}, ${i.summary}`).join('; ')}. Which one?`;
      return { title: `Open incident: ${hits.length} matches`, result: ok(say, { candidates: hits.map((i) => ({ number: i.number, summary: i.summary, priority: i.priorityLabel })) }) };
    }
    const notes = effect.notes?.ok ? effect.notes.value : [];
    const incident: OpenIncident = { ...hits[0], notes };
    state.itdesk.current = incident;
    state.itdesk.focus = 'incident';
    return {
      title: `Opened ${incident.number} · ${incident.summary}`,
      result: ok(
        describeIncident(incident, now),
        { number: incident.number, missing: missingOf(incident), workNotes: notes.map((n) => ({ at: n.at, author: n.author, text: n.text })) },
        'Ask for missing details one at a time. Collect every change, then call prepareIncidentUpdate once for this incident.',
      ),
    };
  },
});

const DEFAULT_UPDATE_MINUTES = 15;
const MAX_UPDATE_MINUTES = 240;
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45 };

// "3 minutes", "half an hour", "in 2 hours" to minutes, capped at four hours; null when it cannot be read.
function updateMinutes(raw: string): number | null {
  const q = norm(raw).replace(/^in /, '');
  if (!q) return DEFAULT_UPDATE_MINUTES;
  if (/^half an? hour$/.test(q)) return 30;
  const m = q.match(/^(\d+|[a-z]+(?: five)?) (minute|minutes|min|mins|hour|hours|hr|hrs)$/) ?? q.match(/^(\d+)$/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  if (!n) return null;
  return Math.min(MAX_UPDATE_MINUTES, m[2]?.startsWith('h') ? n * 60 : n);
}

const requestUpdate = tool<OpenEffect & { mode: Mode }>({
  name: 'requestUpdate',
  description: "Ask an incident's assignee for a status update by a deadline: posts in the IT helpdesk Slack channel asking where they are and any blockers. Uses the open incident when ticket is empty.",
  params: {
    ticket: { description: 'Incident number, position like "second", words from the title, or empty string for the open incident', allowEmpty: true },
    within: { description: 'How soon, e.g. "3 minutes", "half an hour", "2 hours"; empty string means 15 minutes', allowEmpty: true },
  },
  personas: IT,
  minutesSaved: 3,
  async effect({ state, deps }, args) {
    const t = target(state, args.ticket);
    if (t.kind === 'invalid' || t.kind === 'none' || updateMinutes(args.within) === null) return undefined;
    const queued = fromQueue(state, t);
    return { found: await lookup(deps.desk, queued ? { kind: 'number', number: queued.number } : t), mode: deps.notifyMode };
  },
  run({ state, now, effect }, args) {
    const minutes = updateMinutes(args.within);
    if (minutes === null) return failed('Update request: unclear time', 'invalid_time', 'How long should they have? For example, three minutes or half an hour.');
    const t = target(state, args.ticket);
    if (t.kind === 'invalid' || t.kind === 'none') return failed('Update request: which incident', 'unknown_incident', 'Which incident? Give me its number or a few words from the title.');
    if (!effect) return failed('Update request: try again', 'try_again', 'That did not go through. Please try again.');
    if (!effect.found.ok) return failureOutcome('Update request failed', 'desk_unavailable', effect.found.error, 'read that incident');
    const hits = effect.found.value;
    if (hits.length !== 1) return failed('Update request: which incident', 'unknown_incident', hits.length ? `That matches ${hits.length} incidents. Which one?` : "I can't find that incident.");
    const i = hits[0];
    if (!i.assignee) return failed(`Update request: ${i.number} unassigned`, 'no_assignee', `Nobody is assigned to ${spokenTicket(i.number)} yet. Who should take it?`);
    const due = now + minutes * MINUTE;
    const text = `Update requested: ${i.assignee.name}, the IT desk needs an update on ${i.number}, ${i.summary}, by ${formatTime(due)}. Please reply with where you are and any blockers.`;
    const alert = queueAlert(state, now, 'updateRequest', text);
    state.itdesk.updateRequest = { number: i.number, assignee: i.assignee.name, due, at: now };
    // The card shows the request, so the incident asked about becomes the open one; its notes come with the next refresh.
    if (state.itdesk.current?.number !== i.number) state.itdesk.current = { ...i, notes: [] };
    state.itdesk.focus = 'incident';
    const say = `Done. I've asked ${i.assignee.name} in the IT helpdesk channel for an update on ${spokenTicket(i.number)} by ${formatTime(due)}. ${alertSay(effect.mode)}`;
    return { title: `Update requested from ${i.assignee.name} on ${i.number}`, alerts: [alert], result: ok(say, { number: i.number, assignee: i.assignee.name, due }) };
  },
});

interface Parsed {
  number: string | null;
  priority: string | null;
  user: { clear: true } | { name: string } | null;
  group: string | null;
  fields: Record<string, string>;
}

type Parse = { ok: true; value: Parsed } | { ok: false; error: string; say: string };

const bad = (error: string, say: string): Parse => ({ ok: false, error, say });
const cleanName = (raw: string) => raw.replace(/[^A-Za-z .'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
const cleanGroup = (raw: string) => cleanName(raw).toLowerCase().replace(/^the /, '').replace(/ (team|group|queue)$/, '').trim();

// Spoken values to raw ServiceNow values, with the rules for On Hold and Resolved.
function parseUpdate(state: SessionState, raw: Args): Parse {
  const a: Args = { ...raw };
  for (const key of CHOSEN) if (a[key] && PLACEHOLDER.test(norm(a[key]))) a[key] = '';
  const fields: Record<string, string> = {};
  let priority: string | null = null;
  if (a.priority) {
    const set = PRIORITY_SETS[norm(a.priority)];
    if (!set) return bad('invalid_value', 'The priority can be critical, high, moderate or low.');
    if (a.urgency || a.impact) return bad('conflicting_priority', 'Tell me either the priority, or the urgency and impact, not both.');
    Object.assign(fields, { urgency: set.urgency, impact: set.impact });
    priority = set.word;
  }
  for (const key of ['urgency', 'impact'] as const) {
    if (!a[key]) continue;
    const v = LEVELS[norm(a[key])];
    if (!v) return bad('invalid_value', `${key === 'urgency' ? 'Urgency' : 'Impact'} can be high, medium or low.`);
    fields[key] = v;
  }
  let stateCode = a.state ? STATES[norm(a.state)] : '';
  if (stateCode === undefined) return bad('invalid_value', 'The state can be new, in progress, on hold or resolved.');
  const hold = a.holdReason ? HOLD_REASONS[norm(a.holdReason)] : '';
  if (hold === undefined) return bad('invalid_value', 'The hold reason can be awaiting caller, vendor, problem or change.');
  if (hold && !stateCode) stateCode = '3';
  if (a.resolutionNotes && !stateCode) stateCode = '6';
  if (stateCode === '3' && !hold) return bad('hold_reason_required', "What's the hold reason: awaiting caller, vendor, problem or change?");
  if (stateCode === '6' && !a.resolutionNotes) return bad('resolution_notes_required', 'What fixed it? I need a short resolution note.');
  if (stateCode) fields.state = stateCode;
  if (stateCode === '3') fields.hold_reason = hold;
  if (stateCode === '6') fields.close_notes = a.resolutionNotes;
  if (a.category) {
    const c = norm(a.category);
    if (!CATEGORIES.includes(c)) return bad('invalid_value', 'The category can be inquiry, software, hardware, network or database.');
    fields.category = c;
  }
  if (a.workNote) fields.work_notes = a.workNote;
  if (a.comment) fields.comments = a.comment;
  if (/[\^=]/.test(a.assignedTo + a.assignmentGroup)) return bad('invalid_name', 'I can only look up plain names. Could you say it again?');
  const user = !a.assignedTo ? null : NOBODY.test(norm(a.assignedTo)) ? { clear: true as const } : { name: cleanName(a.assignedTo) };
  const group = a.assignmentGroup ? cleanGroup(a.assignmentGroup) : null;
  const t = target(state, a.ticket);
  if (t.kind === 'invalid' || t.kind === 'words') return bad('invalid_value', 'Which incident? Give me its number, or open it first.');
  return { ok: true, value: { number: t.kind === 'number' ? t.number : null, priority, user, group, fields } };
}

type Lookup = { kind: 'one'; ref: Ref } | { kind: 'many'; names: string[] } | { kind: 'none'; suggestions: string[] } | { kind: 'error'; error: Failure };

async function findUser(desk: DeskAdapter, name: string): Promise<Lookup> {
  for (const match of ['exact', 'starts', 'like'] as const) {
    const res = await desk.findUsers(name, match);
    if (!res.ok) return { kind: 'error', error: res.error };
    if (res.value.length === 1) return { kind: 'one', ref: res.value[0] };
    if (res.value.length > 1) return { kind: 'many', names: res.value.map((u) => u.name) };
  }
  const close = name.length >= 3 ? await desk.findUsers(name.slice(0, 3), 'like') : success([]);
  return { kind: 'none', suggestions: close.ok ? close.value.slice(0, 3).map((u) => u.name) : [] };
}

async function findGroup(desk: DeskAdapter, name: string): Promise<Lookup> {
  const res = await desk.findGroups(name);
  if (!res.ok) return { kind: 'error', error: res.error };
  const exact = res.value.find((g) => g.name.toLowerCase() === name);
  if (exact || res.value.length === 1) return { kind: 'one', ref: exact ?? res.value[0] };
  if (res.value.length > 1) return { kind: 'many', names: res.value.map((g) => g.name) };
  const close = name.length >= 3 ? await desk.findGroups(name.slice(0, 3)) : success([]);
  return { kind: 'none', suggestions: close.ok ? close.value.slice(0, 3).map((g) => g.name) : [] };
}

interface UpdateEffect {
  incident: Result<DeskIncident | null>;
  user?: Lookup;
  group?: Lookup;
  members?: Result<Ref[]>;
}

function knownIncident(state: SessionState, number: string): DeskIncident | undefined {
  const current = state.itdesk.current;
  return current?.number === number ? current : state.itdesk.queue.find((i) => i.number === number);
}

function lookupFailure(kind: 'assignee' | 'group', raw: string, l: Lookup): Outcome | null {
  if (l.kind === 'error') return failureOutcome(`Update: ${kind} lookup failed`, 'desk_unavailable', l.error, `look up that ${kind === 'assignee' ? 'person' : 'group'}`);
  if (l.kind === 'many') return failed(`Update: several ${kind}s match`, `ambiguous_${kind}`, `Which ${raw}: ${orList(l.names)}?`);
  if (l.kind === 'none') {
    const hint = l.suggestions.length ? ` Did you mean ${orList(l.suggestions)}?` : '';
    return failed(`Update: unknown ${kind}`, `unknown_${kind}`, `I can't find ${raw}${kind === 'group' ? ' as a group' : ''} in ServiceNow.${hint}`);
  }
  return null;
}

function stateChange(code: string, hold: string | undefined, notes: string | undefined): string {
  if (code === '1') return 'set it back to new';
  if (code === '2') return 'set it to in progress';
  if (code === '3') return `put it on hold, ${HOLD_WORD[hold ?? ''] ?? 'on hold'}`;
  return `resolve it with the note: ${notes ?? ''}`;
}

const prepareIncidentUpdate = tool<UpdateEffect>({
  name: 'prepareIncidentUpdate',
  description:
    'Step 1 of saving changes to one incident: every change for it in a single call, then one read-back and confirmAction. Every argument is a string; empty string leaves that field unchanged. A new call for the same incident replaces the earlier one.',
  params: {
    ticket: { description: 'Incident number, or empty string for the open incident', allowEmpty: true },
    assignedTo: { description: 'Person to assign, as said, or "nobody" to clear; empty string keeps the current assignee', allowEmpty: true },
    assignmentGroup: { description: 'Group, e.g. Network, Software, Hardware, Service Desk', allowEmpty: true },
    state: { description: 'new, in progress, on hold or resolved', allowEmpty: true },
    holdReason: { description: 'awaiting caller, vendor, problem or change', allowEmpty: true },
    priority: { description: 'critical, high, moderate or low; sets urgency and impact to match. Use it whenever the engineer says priority', allowEmpty: true },
    urgency: { description: 'high, medium or low', allowEmpty: true },
    impact: { description: 'high, medium or low', allowEmpty: true },
    category: { description: 'inquiry, software, hardware, network or database', allowEmpty: true },
    workNote: { description: 'Internal work note', allowEmpty: true },
    comment: { description: 'Comment the caller can see', allowEmpty: true },
    resolutionNotes: { description: 'What fixed it, needed to resolve', allowEmpty: true },
  },
  personas: IT,
  async effect({ state, deps }, args) {
    const parsed = parseUpdate(state, args);
    if (!parsed.ok || !parsed.value.number) return undefined;
    const p = parsed.value;
    const known = knownIncident(state, parsed.value.number!);
    const incident = known ? success(known) : await deps.desk.get(parsed.value.number!);
    if (!incident.ok || !incident.value) return { incident };
    const user = p.user && 'name' in p.user ? await findUser(deps.desk, p.user.name) : undefined;
    const group = p.group ? await findGroup(deps.desk, p.group) : undefined;
    const groupRef = group?.kind === 'one' ? group.ref : incident.value.group;
    const assignee = user?.kind === 'one' ? user.ref : p.user && 'clear' in p.user ? null : incident.value.assignee;
    const members = (p.user || p.group) && assignee && groupRef ? await deps.desk.groupMembers(groupRef.id) : undefined;
    return { incident, user, group, members };
  },
  run({ state, now, effect }, args) {
    const parsed = parseUpdate(state, args);
    if (!parsed.ok) return failed('Update not prepared', parsed.error, parsed.say);
    const p = parsed.value;
    if (!p.number) return failed('Update: no incident', 'no_incident', 'Which incident? Open one first or give me its number.');
    if (!effect) return failed('Update: try again', 'try_again', 'That did not go through. Please try again.');
    if (!effect.incident.ok) return failureOutcome('Update: incident unavailable', 'desk_unavailable', effect.incident.error, 'read that incident');
    const incident = effect.incident.value;
    if (!incident) return failed('Update: unknown incident', 'unknown_incident', `I can't find ${spokenTicket(p.number)}.`);
    const userError = effect.user && lookupFailure('assignee', args.assignedTo, effect.user);
    if (userError) return userError;
    const groupError = effect.group && lookupFailure('group', args.assignmentGroup, effect.group);
    if (groupError) return groupError;

    const fields: Record<string, string> = {};
    const changes: string[] = [];
    const user = effect.user?.kind === 'one' ? effect.user.ref : null;
    const group = effect.group?.kind === 'one' ? effect.group.ref : null;
    if (user && user.id !== incident.assignee?.id) {
      fields.assigned_to = user.id;
      changes.push(`assign it to ${user.name}`);
    }
    if (p.user && 'clear' in p.user && incident.assignee) {
      fields.assigned_to = '';
      changes.push('remove the assignee');
    }
    if (group && group.id !== incident.group?.id) {
      fields.assignment_group = group.id;
      changes.push(`move it to the ${group.name} group`);
    }
    const f = p.fields;
    if (f.state && (f.state !== incident.state || (f.state === '3' && f.hold_reason !== incident.holdReason))) {
      Object.assign(fields, { state: f.state }, f.hold_reason ? { hold_reason: f.hold_reason } : {}, f.close_notes ? { close_notes: f.close_notes } : {});
      changes.push(stateChange(f.state, f.hold_reason, f.close_notes));
    }
    for (const key of ['urgency', 'impact'] as const) {
      if (f[key] && f[key] !== String(incident[key])) {
        fields[key] = f[key];
        if (!p.priority) changes.push(`set ${key} to ${LEVEL_WORD[f[key]]}`);
      }
    }
    if (p.priority && (fields.urgency || fields.impact)) changes.push(`set the priority to ${p.priority}`);
    if (f.category && f.category !== incident.category) {
      fields.category = f.category;
      changes.push(`set the category to ${f.category}`);
    }
    if (f.work_notes) {
      fields.work_notes = f.work_notes;
      changes.push('add a work note');
    }
    if (f.comments) {
      fields.comments = f.comments;
      changes.push('add a comment for the caller');
    }
    if (!changes.length) return failed(`Update: nothing to change on ${incident.number}`, 'no_changes', `That doesn't change anything on ${spokenTicket(incident.number)}. What should I change?`);

    const groupName = (group ?? incident.group)?.name;
    const assignee = 'assigned_to' in fields ? user : incident.assignee;
    if (effect.members && !effect.members.ok) return failureOutcome('Update: group members unavailable', 'desk_unavailable', effect.members.error, 'check who is in that group');
    const members = effect.members?.ok ? effect.members.value : null;
    const outsider = assignee && groupName && members && !members.some((m) => m.id === assignee.id);
    // ServiceNow aborts a group change whose assignee is not in the new group.
    if (outsider && 'assignment_group' in fields) {
      const who = members.length ? `${groupName} has ${orList(members.slice(0, 3).map((m) => m.name), 'and')}. Who should take it?` : `The ${groupName} group has no active members, so pick another group or leave it unassigned.`;
      return failed(`Update: ${assignee.name} not in ${groupName}`, 'assignee_not_in_group', `${assignee.name} isn't in the ${groupName} group, and ServiceNow only accepts an assignee from that group. ${who}`);
    }
    const warnings = outsider ? [`${assignee.name} isn't a member of the ${groupName} group.`] : [];

    // A new prepare for the same incident replaces the older one.
    const replaced = state.pending.filter((a) => a.status === 'pending' && a.payload.kind === 'incident' && a.payload.number === incident.number);
    for (const a of replaced) a.status = 'cancelled';
    state.itdesk.current = { ...incident, notes: state.itdesk.current?.number === incident.number ? state.itdesk.current.notes : [] };
    state.itdesk.focus = 'incident';

    const owner = user ?? incident.assignee;
    const alert = 'assigned_to' in fields || 'assignment_group' in fields ? `${incident.number} assigned to ${[owner?.name ?? 'nobody', groupName].filter(Boolean).join(', ')}, from the IT desk.` : undefined;
    const text = orList(changes, 'and');
    return prepare(
      state,
      now,
      { kind: 'incident', number: incident.number, sysId: incident.sysId, fields, changes, ...(alert ? { alert } : {}) },
      `Update ${incident.number}: ${text}`,
      warnings,
      `Ready to update ${spokenTicket(incident.number)}: ${text}.`,
      '',
      { changes, replaced: replaced.length },
    );
  },
});

// The teams the desk hands work to, looked up by exact name.
export const TEAMS = ['Service Desk', 'Network', 'Hardware', 'Software', 'Database', 'Finance Systems', 'Payroll'];
const TEAM_OF_CATEGORY = new Map([['network', 'Network'], ['hardware', 'Hardware'], ['software', 'Software'], ['database', 'Database'], ['inquiry', 'Service Desk']]);
const ALL_TEAMS = /^(all|all teams|every team|everyone|everybody|any)$/;
const RESOURCE_STATUS = ['available', 'busy', 'all'] as const;
const SPOKEN_PEOPLE = 5;
const SPOKEN_TICKETS = 3;

type TeamPick = { ok: true; team: string | null } | { ok: false; outcome: Outcome };

const incidentTeam = (i: OpenIncident | null) => TEAMS.find((t) => t.toLowerCase() === i?.group?.name.toLowerCase()) ?? TEAM_OF_CATEGORY.get(i?.category ?? '') ?? null;

// A named team, else the open incident's team; null means every team.
function pickTeam(state: SessionState, raw: string): TeamPick {
  if (/[\^=]/.test(raw)) return { ok: false, outcome: failed('People: invalid team', 'invalid_team', 'I can only look up plain team names. Could you say it again?') };
  const said = cleanGroup(raw);
  if (!raw.trim()) return { ok: true, team: incidentTeam(state.itdesk.current) };
  if (ALL_TEAMS.test(said)) return { ok: true, team: null };
  const starts = said.length >= 3 ? TEAMS.filter((t) => t.toLowerCase().startsWith(said)) : [];
  const team = TEAMS.find((t) => t.toLowerCase() === said) ?? (starts.length === 1 ? starts[0] : undefined);
  if (team) return { ok: true, team };
  return { ok: false, outcome: failed('People: unknown team', 'unknown_team', `I don't know ${said ? `a team called ${cleanName(raw)}` : 'that team'}. The teams are ${orList(TEAMS, 'and')}.`) };
}

const card = (p: Resource): PersonCard => ({ name: p.name, teams: p.teams, open: p.open });
const ALL_TEAMS_TITLE = 'All teams';

// A team and who of it to show; with nobody free the whole team shows, so the least busy can be picked.
function rosterView(roster: Resource[], team: string | null, status: ResourceStatus) {
  const everyone = roster.filter((p) => !team || p.teams.includes(team));
  const free = everyone.filter((p) => !p.open.length);
  const taken = everyone.filter((p) => p.open.length);
  const nobodyFree = status === 'available' && !free.length;
  const shown = status === 'all' || nobodyFree ? everyone : status === 'available' ? free : taken;
  return { everyone, free, taken, shown, showing: nobodyFree ? ('all' as const) : status };
}

// People on screen as the roster says now; a person no longer in the teams keeps the last card.
function refreshPeople(desk: ItDesk, board: Extract<Board, { kind: 'people' | 'person' }>, roster: Resource[]): Pick<ItDesk, 'board' | 'queue'> | null {
  if (board.kind === 'person') {
    const p = roster.find((r) => r.name === board.person.name);
    return p ? { queue: desk.queue, board: { ...board, person: card(p) } } : null;
  }
  const { free, taken, shown, showing } = rosterView(roster, board.title === ALL_TEAMS_TITLE ? null : board.title, board.status);
  return { queue: desk.queue, board: { ...board, status: showing, available: free.length, busy: taken.length, people: shown.map(card) } };
}
const tickets = (p: Resource) => plural(p.open.length, 'open ticket');

// The first few joined by `sep` and how many more are on screen; null when all of them fit.
function overflow(items: string[], limit: number, sep: string): string | null {
  const rest = items.length - limit;
  return rest > 0 ? `${items.slice(0, limit).join(sep)}, and ${rest} more ${rest === 1 ? 'is' : 'are'} on your screen` : null;
}
const spokenNames = (items: string[]) => overflow(items, SPOKEN_PEOPLE, ', ') ?? orList(items, 'and');

const assignNext = (current: OpenIncident, team: string | null, who = 'that person') =>
  `If the engineer picks someone for ${current.number}, call prepareIncidentUpdate with assignedTo set to ${who}${team && current.group?.name !== team ? ` and assignmentGroup ${team}` : ''}. If a first name matches several people, ask which one.`;

const rosterFailure = (effect: Result<Resource[]> | undefined) => failureOutcome('People unavailable', 'desk_unavailable', effect && !effect.ok ? effect.error : { kind: 'network' }, 'read the IT teams');

const listResources = tool<Result<Resource[]>>({
  name: 'listResources',
  description:
    "Engineers in the IT teams and whether they can take work: available means no open incident right now, busy shows how many they have. For \"who's available to take this?\" use status available and an empty team. Shown on the engineer's screen.",
  params: {
    team: { description: `${orList(TEAMS)}; "all" for every team; empty string for the open incident's team`, allowEmpty: true },
    status: { description: 'available, busy or all; empty string for all', enum: RESOURCE_STATUS, allowEmpty: true },
  },
  personas: IT,
  minutesSaved: 2,
  async effect({ state, deps }, args) {
    return pickTeam(state, args.team).ok ? deps.desk.roster(TEAMS) : undefined;
  },
  run({ state, now, effect }, args) {
    const pick = pickTeam(state, args.team);
    if (!pick.ok) return pick.outcome;
    if (!effect?.ok) return rosterFailure(effect);
    const team = pick.team;
    const status = (args.status || 'all') as ResourceStatus;
    const { everyone, free, taken, shown, showing } = rosterView(effect.value, team, status);
    state.itdesk.board = { kind: 'people', title: team ?? ALL_TEAMS_TITLE, status: showing, available: free.length, busy: taken.length, people: shown.map(card), at: now };
    state.itdesk.focus = 'board';
    const where = team ? `in ${team}` : 'across the IT teams';
    const are = (n: number) => (n === 1 ? 'is' : 'are');
    const least = [...everyone].sort((a, b) => a.open.length - b.open.length)[0];
    let say: string;
    if (!everyone.length) say = `I can't find anyone active in ${team ? `the ${team} team` : 'the IT teams'} in ServiceNow.`;
    else if (status === 'available') say = free.length ? `${plural(free.length, 'person', 'people')} ${where} ${are(free.length)} free: ${spokenNames(free.map((p) => p.name))}.` : `Nobody ${where} is free; the least busy is ${least.name} with ${tickets(least)}.`;
    else if (status === 'busy') say = taken.length ? `${plural(taken.length, 'person', 'people')} ${where} ${are(taken.length)} busy: ${spokenNames(taken.map((p) => `${p.name} with ${tickets(p)}`))}.` : `Nobody ${where} has an open ticket right now.`;
    else say = `${team ? `${team} has` : 'The IT teams have'} ${plural(everyone.length, 'person', 'people')}: ${free.length} available and ${taken.length} busy. They're on your screen.`;
    // Only an open incident nobody owns yet gets an offer to assign it.
    const current = state.itdesk.current?.assignee ? null : state.itdesk.current;
    const ask = current && everyone.length && status !== 'busy' ? ' Who should take it?' : '';
    const people = shown.map((p) => ({ name: p.name, teams: p.teams, openTickets: p.open.length, tickets: p.open.map((t) => t.number) }));
    return {
      title: `People: ${team ?? 'all teams'} · ${free.length} available · ${taken.length} busy`,
      result: ok(`${say}${ask}`, { team: team ?? 'all', status, available: free.length, busy: taken.length, people }, current ? assignNext(current, team) : undefined),
    };
  },
});

// Exact full name first, else a first or last name or the start of the name.
function matchPeople(people: Resource[], said: string): Resource[] {
  const q = norm(said);
  if (!q) return [];
  const exact = people.filter((p) => norm(p.name) === q);
  return exact.length ? exact : people.filter((p) => norm(p.name).startsWith(q) || norm(p.name).split(' ').includes(q));
}

const showResource = tool<Result<Resource[]>>({
  name: 'showResource',
  description: "One engineer from the IT teams: their teams, whether they are free, and their open incidents. Shown on the engineer's screen.",
  params: { name: { description: 'Full or first name, as said' } },
  personas: IT,
  minutesSaved: 1,
  async effect({ deps }, args) {
    return /[\^=]/.test(args.name) ? undefined : deps.desk.roster(TEAMS);
  },
  run({ state, now, effect }, args) {
    if (/[\^=]/.test(args.name)) return failed('Person: invalid name', 'invalid_name', 'I can only look up plain names. Could you say it again?');
    if (!effect?.ok) return rosterFailure(effect);
    const said = cleanName(args.name.replace(/['’]s$/i, ''));
    const hits = matchPeople(effect.value, said);
    if (!hits.length) return failed('Person: not found', 'unknown_person', `I can't find ${said || 'that person'} in the IT teams.`);
    if (hits.length > 1) return failed(`Person: ${hits.length} match ${said}`, 'ambiguous_person', `Which ${said}: ${orList(hits.map((p) => p.name))}?`, hits.map((p) => p.name));
    const p = hits[0];
    state.itdesk.board = { kind: 'person', person: card(p), at: now };
    state.itdesk.focus = 'board';
    const list = p.open.map((t) => `${spokenTicket(t.number)}, ${t.summary}, ${t.priorityLabel.toLowerCase()} priority`);
    const work = p.open.length ? `has ${tickets(p)}: ${overflow(list, SPOKEN_TICKETS, '; ') ?? list.join('; ')}.` : 'is free right now.';
    const current = state.itdesk.current?.assignee ? null : state.itdesk.current;
    const ask = current ? ` Should I assign it to ${p.name.split(' ')[0]}?` : '';
    const team = incidentTeam(current);
    return {
      title: `Person: ${p.name} · ${p.open.length ? tickets(p) : 'available'}`,
      result: ok(
        `${p.name} is in ${orList(p.teams, 'and')} and ${work}${ask}`,
        { name: p.name, teams: p.teams, openTickets: p.open.length, tickets: p.open },
        current ? assignNext(current, team && p.teams.includes(team) ? team : p.teams[0], p.name) : undefined,
      ),
    };
  },
});

export const ITDESK_TOOLS = [listQueue, countIncidents, showDashboard, showImpact, openIncident, prepareIncidentUpdate, requestUpdate, listResources, showResource];
