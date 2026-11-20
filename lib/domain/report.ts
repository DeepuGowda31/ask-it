import type { DeskIncident, Mode, Resource, WorkNote } from '@/lib/integrations/types';
import { buildDashboard, weekStart } from './dashboard';
import { openedRange, sortIncidents } from './queue-query';
import { DAY, MINUTE, isoDate, zonedTime } from './time';
import { HOLD_WORD, TEAMS } from './tools/itdesk';
import type { ReportRequest, SessionState } from './types';

// The service desk report: periods, the lines the agent says about it, and its figures from the data read for it.

export const REPORT_PERIODS = ['today', 'yesterday', 'this_week', 'last_7_days', 'this_month'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

const KIND: Record<ReportPeriod, 'Daily' | 'Weekly' | 'Monthly'> = { today: 'Daily', yesterday: 'Daily', this_week: 'Weekly', last_7_days: 'Weekly', this_month: 'Monthly' };
const SPOKEN: Record<ReportPeriod, string> = { today: 'today', yesterday: 'yesterday', this_week: 'this week', last_7_days: 'the last seven days', this_month: 'this month' };
const LABEL: Record<ReportPeriod, string> = { today: 'Today', yesterday: 'Yesterday', this_week: 'This week', last_7_days: 'Last 7 days', this_month: 'This month' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR = 60 * MINUTE;

const kindWord = (p: ReportPeriod) => KIND[p].toLowerCase();
// "Weekly" and "Last 7 days", for the screen.
export const reportNames = (p: ReportPeriod) => ({ kind: KIND[p], periodLabel: LABEL[p] });
export const reportTitle = (p: ReportPeriod) => `${KIND[p]} IT Service Desk Report`;
export const reportStartLine = (p: ReportPeriod) => `I'm putting together your ${kindWord(p)} report for ${SPOKEN[p]}. It'll download in a few seconds. Meanwhile, anything else I can help with?`;
export const reportPendingLine = (p: ReportPeriod) => `I'm still putting together your ${kindWord(p)} report. It'll download in a few seconds.`;
export const reportReadyLine = (p: ReportPeriod) => `Your ${kindWord(p)} report is ready, it's in your downloads.`;
export const reportFailedLine = (p: ReportPeriod, live: boolean) => `I couldn't build your ${kindWord(p)} report${live ? ", ServiceNow didn't answer" : ''}. Want me to try again?`;

const parts = (ms: number) => isoDate(ms).split('-').map(Number) as [number, number, number];

// "ASK IT Weekly Service Desk Report 18 Nov 2026.pdf"
export function reportFilename(p: ReportPeriod, now: number): string {
  const [y, m, d] = parts(now);
  return `ASK IT ${KIND[p]} Service Desk Report ${d} ${MONTHS[m - 1].slice(0, 3)} ${y}.pdf`;
}

// Whole India-time days: last 7 days is today and the six before it, like the dashboard's bars.
export function reportRange(p: ReportPeriod, now: number): { since: number; end: number } {
  if (p === 'last_7_days') return { since: weekStart(now), end: now };
  const r = openedRange(p, now);
  return { since: r.since, end: r.before ?? now };
}

// "45 min", "5 h 20 min", "3 d 4 h"
export function spanText(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  if (ms < DAY) {
    const m = minutes % 60;
    return `${Math.floor(ms / HOUR)} h${m ? ` ${m} min` : ''}`;
  }
  const h = Math.floor((ms % DAY) / HOUR);
  return `${Math.floor(ms / DAY)} d${h ? ` ${h} h` : ''}`;
}

// An age for a table column: whole hours under a day, so it stays short.
const ageText = (ms: number) => (ms >= HOUR && ms < DAY ? `${Math.floor(ms / HOUR)} h` : spanText(ms));

// "12 to 18 November 2026", "26 November to 2 December 2026", or one day.
function rangeText(since: number, last: number): string {
  const [y1, m1, d1] = parts(since);
  const [y2, m2, d2] = parts(last);
  const end = `${d2} ${MONTHS[m2 - 1]} ${y2}`;
  if (y1 === y2 && m1 === m2) return d1 === d2 ? end : `${d1} to ${end}`;
  return `${d1} ${MONTHS[m1 - 1]}${y1 === y2 ? '' : ` ${y1}`} to ${end}`;
}

// "9.30 AM": a time without a colon.
function clock(ms: number): string {
  const t = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(ms);
  const get = (type: string) => t.find((x) => x.type === type)?.value ?? '';
  return `${get('hour')}.${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}

// "18 Nov", with the year when it is not this year's.
function shortDate(ms: number | null, now: number): string {
  if (ms === null) return 'Unknown';
  const [y, m, d] = parts(ms);
  return `${d} ${MONTHS[m - 1].slice(0, 3)}${y === parts(now)[0] ? '' : ` ${y}`}`;
}

export interface ReportIncident {
  number: string;
  priority: number;
  priorityLabel: string;
  state: string;
  title: string;
  team: string;
  assignee: string;
  opened: string;
  age: string;
}

export interface ReportData {
  title: string;
  kind: string;
  periodLabel: string;
  range: string;
  prepared: string;
  preparedAt: number;
  source: string;
  // What "open" covers when the desk reads a window of days, else null.
  scope: string | null;
  figures: {
    open: number;
    openMore: boolean;
    critical: number;
    unassigned: number;
    onHold: number;
    newInPeriod: number;
    resolvedInPeriod: number;
    avgResolve: { text: string; count: number } | null;
    oldest: { number: string; age: string } | null;
  };
  byPriority: { label: string; count: number }[];
  byState: { label: string; count: number }[];
  byTeam: { label: string; count: number }[];
  days: { label: string; opened: number; resolved: number }[];
  attention: {
    urgent: ReportIncident[];
    blocked: (ReportIncident & { waitingOn: string; reason: string })[];
    unassigned: ReportIncident[];
  };
  resolved: { number: string; title: string; team: string; assignee: string; resolved: string; took: string }[];
  resolvedMore: boolean;
  // Engineers are null for groups that are not one of the desk's teams.
  workload: { team: string; open: number; engineers: number | null; busy: number | null; free: number | null }[];
  openRows: ReportIncident[];
}

export interface ReportInput {
  period: ReportPeriod;
  now: number;
  open: DeskIncident[];
  openMore: boolean;
  // When incidents were opened, from the start of the period.
  opened: number[];
  // Incidents resolved since the start of the period, with resolvedAt.
  resolved: DeskIncident[];
  resolvedMore: boolean;
  roster: Resource[];
  // The latest work note of each on hold incident, by number.
  notes: Record<string, WorkNote | undefined>;
  // Live open incidents are read from the last `windowDays` days, like the rest of the desk; 0 means all of them.
  source: { mode: Mode; host?: string; windowDays?: number };
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Each India-time day from the start of the period to its end.
function dayStarts(since: number, end: number): number[] {
  const out: number[] = [];
  for (let d = since; d < end; d = zonedTime(isoDate(d + DAY + DAY / 2), 0)) out.push(d);
  return out;
}

function dayLabel(start: number, many: boolean): string {
  const [y, m, d] = parts(start);
  return many ? String(d) : `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d}`;
}

// Every figure comes from the rows read for this report; nothing is estimated.
export function buildReportData(input: ReportInput): ReportData {
  const { period, now, open } = input;
  const { since, end } = reportRange(period, now);
  const inPeriod = (t: number | null | undefined): t is number => typeof t === 'number' && t >= since && t < end;
  const glance = buildDashboard(open, input.openMore, { opened: [], resolved: [] }, now);
  const row = (i: DeskIncident): ReportIncident => ({
    number: i.number,
    priority: i.priority,
    priorityLabel: i.priorityLabel,
    state: i.stateLabel,
    title: oneLine(i.summary),
    team: i.group?.name ?? '',
    assignee: i.assignee?.name ?? '',
    opened: shortDate(i.openedAt, now),
    age: i.openedAt === null ? 'Unknown' : ageText(now - i.openedAt),
  });
  const sorted = sortIncidents(open, 'priority');
  const opened = input.opened.filter(inPeriod);
  const resolved = input.resolved.filter((r) => inPeriod(r.resolvedAt)).sort((a, b) => b.resolvedAt! - a.resolvedAt!);
  const took = (r: DeskIncident) => (r.openedAt !== null && r.openedAt <= r.resolvedAt! ? r.resolvedAt! - r.openedAt : null);
  const spans = resolved.map(took).filter((t): t is number => t !== null);
  const starts = dayStarts(since, end);
  const sameDay = (t: number, day: number) => isoDate(t) === isoDate(day);
  const teamOpen = (team: string) => open.filter((i) => (i.group?.name ?? 'No group') === team).length;
  const others = [...new Set(open.map((i) => i.group?.name ?? 'No group'))].filter((g) => !TEAMS.includes(g)).sort((a, b) => Number(a === 'No group') - Number(b === 'No group') || a.localeCompare(b));
  return {
    title: reportTitle(period),
    ...reportNames(period),
    range: rangeText(since, Math.max(since, end - 1)),
    prepared: `${rangeText(now, now)} at ${clock(now)} India time`,
    preparedAt: now,
    source: input.source.mode === 'live' ? `Live from ServiceNow${input.source.host ? `, ${input.source.host}` : ''}` : 'Simulated data',
    scope: input.source.mode === 'live' && input.source.windowDays ? `Open incidents are those opened in the last ${input.source.windowDays} days` : null,
    figures: {
      open: open.length,
      openMore: input.openMore,
      critical: glance.critical,
      unassigned: glance.unassigned,
      onHold: glance.onHold,
      newInPeriod: opened.length,
      resolvedInPeriod: resolved.length,
      avgResolve: spans.length ? { text: spanText(spans.reduce((a, b) => a + b, 0) / spans.length), count: spans.length } : null,
      oldest: glance.oldest ? { number: glance.oldest.number, age: spanText(now - glance.oldest.openedAt) } : null,
    },
    byPriority: glance.byPriority,
    byState: glance.byState,
    byTeam: glance.byTeam,
    days: starts.map((start) => ({ label: dayLabel(start, starts.length > 7), opened: opened.filter((t) => sameDay(t, start)).length, resolved: resolved.filter((r) => sameDay(r.resolvedAt!, start)).length })),
    attention: {
      urgent: sorted.filter((i) => i.priority <= 2).map(row),
      blocked: sorted
        .filter((i) => i.state === '3')
        .map((i) => {
          const note = input.notes[i.number]?.text;
          return { ...row(i), waitingOn: i.holdReason && HOLD_WORD[i.holdReason] ? capital(HOLD_WORD[i.holdReason]) : 'Not given', reason: note && oneLine(note) ? oneLine(note) : 'No work note yet' };
        }),
      unassigned: sorted.filter((i) => !i.assignee).map(row),
    },
    resolved: resolved.map((r) => {
      const t = took(r);
      return { number: r.number, title: oneLine(r.summary), team: r.group?.name ?? '', assignee: r.assignee?.name ?? '', resolved: shortDate(r.resolvedAt!, now), took: t === null ? 'Unknown' : spanText(t) };
    }),
    resolvedMore: input.resolvedMore,
    workload: [
      ...TEAMS.map((team) => {
        const members = input.roster.filter((p) => p.teams.includes(team));
        const busy = members.filter((p) => p.open.length).length;
        return { team, open: teamOpen(team), engineers: members.length, busy, free: members.length - busy };
      }),
      ...others.map((team) => ({ team, open: teamOpen(team), engineers: null, busy: null, free: null })),
    ],
    openRows: sorted.map(row),
  };
}

// A pending report no page has finished after this long no longer blocks a new one.
export const REPORT_PENDING_MS = 2 * 60_000;
// A build claimed longer ago than this was abandoned; the route's own limit is 30 s.
const BUILD_CLAIM_MS = 45_000;

type Claim = 'build' | 'again' | 'busy' | 'stale' | 'failed';

// Pure: who builds report `id`. Only one request claims a pending report; a ready one can be downloaded again.
export function claimReport(s: SessionState, id: string, now: number): { state: SessionState; outcome: Claim; report: ReportRequest | null } {
  const report = s.itdesk.report;
  if (!report || report.id !== id) return { state: s, outcome: 'stale', report: null };
  if (report.status === 'failed') return { state: s, outcome: 'failed', report };
  if (report.status === 'ready') return { state: s, outcome: 'again', report };
  if (report.startedAt !== undefined && now - report.startedAt < BUILD_CLAIM_MS) return { state: s, outcome: 'busy', report };
  const claimed = { ...report, startedAt: now };
  return { state: { ...s, itdesk: { ...s.itdesk, report: claimed } }, outcome: 'build', report: claimed };
}

// Pure: marks report `id` ready or failed once. `agentId` is the running IT desk agent that should say so, only on that first change.
export function finishReport(s: SessionState, id: string, status: 'ready' | 'failed', now: number, filename: string): { state: SessionState; agentId: string | null } {
  const report = s.itdesk.report;
  if (!report || report.id !== id || report.status !== 'pending') return { state: s, agentId: null };
  const call = s.call;
  const next: ReportRequest = { ...report, status, finishedAt: now, ...(status === 'ready' ? { filename } : {}) };
  return { state: { ...s, itdesk: { ...s.itdesk, report: next } }, agentId: call.active && call.persona === 'itdesk' && call.agentId ? call.agentId : null };
}
