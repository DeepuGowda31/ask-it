import { describe, expect, it } from 'vitest';
import { REPORT_PERIODS, buildReportData, reportFailedLine, reportFilename, reportRange, reportReadyLine, reportStartLine, reportTitle, spanText, type ReportInput, type ReportPeriod } from '@/lib/domain/report';
import { seedBacklog } from '@/lib/domain/desk-seed';
import { DAY, MINUTE, zonedTime } from '@/lib/domain/time';
import type { DeskIncident, Resource } from '@/lib/integrations/types';
import { SimulatedDesk } from '@/lib/integrations/simulated';
import { failure, success } from '@/lib/integrations/http';
import { readReport, reportSource } from '@/lib/server/report';
import { NOW, freshState, makeDeps } from './helpers';

const HOUR = 60 * MINUTE;
const TODAY = zonedTime('2026-11-18', 0);
const SEED = seedBacklog(NOW);
const OPEN: DeskIncident[] = SEED.map(({ notes: _notes, ...i }) => i);
const NO_PUNCTUATION = /[;:\-–—]/;

const input = (o: Partial<ReportInput> = {}): ReportInput => ({
  period: 'last_7_days',
  now: NOW,
  open: [],
  openMore: false,
  opened: [],
  resolved: [],
  resolvedMore: false,
  roster: [],
  notes: {},
  source: { mode: 'simulated' },
  ...o,
});

const resolvedRow = (n: number, at: number, openedAt: number | null, extra: Partial<DeskIncident> = {}): DeskIncident => ({
  ...OPEN[0],
  number: `INC00200${n}`,
  sysId: `r${n}`,
  summary: `Fixed thing ${n}`,
  state: '6',
  stateLabel: 'Resolved',
  openedAt,
  resolvedAt: at,
  ...extra,
});

describe('report periods', () => {
  it('names the kind of report the admin asked for', () => {
    const titles = Object.fromEntries(REPORT_PERIODS.map((p) => [p, reportTitle(p)]));
    expect(titles).toEqual({
      today: 'Daily IT Service Desk Report',
      yesterday: 'Daily IT Service Desk Report',
      this_week: 'Weekly IT Service Desk Report',
      last_7_days: 'Weekly IT Service Desk Report',
      this_month: 'Monthly IT Service Desk Report',
    });
  });
  it('says what it is putting together, per period, with no colons, semicolons or dashes', () => {
    const lines: Record<ReportPeriod, string> = {
      today: "I'm putting together your daily report for today. It'll download in a few seconds. Meanwhile, anything else I can help with?",
      yesterday: "I'm putting together your daily report for yesterday. It'll download in a few seconds. Meanwhile, anything else I can help with?",
      this_week: "I'm putting together your weekly report for this week. It'll download in a few seconds. Meanwhile, anything else I can help with?",
      last_7_days: "I'm putting together your weekly report for the last seven days. It'll download in a few seconds. Meanwhile, anything else I can help with?",
      this_month: "I'm putting together your monthly report for this month. It'll download in a few seconds. Meanwhile, anything else I can help with?",
    };
    for (const p of REPORT_PERIODS) {
      expect(reportStartLine(p)).toBe(lines[p]);
      for (const line of [reportStartLine(p), reportReadyLine(p), reportFailedLine(p, true), reportFailedLine(p, false)]) expect(line).not.toMatch(NO_PUNCTUATION);
    }
    expect(reportReadyLine('this_month')).toBe("Your monthly report is ready, it's in your downloads.");
    expect(reportFailedLine('today', true)).toBe("I couldn't build your daily report, ServiceNow didn't answer. Want me to try again?");
    expect(reportFailedLine('today', false)).toBe("I couldn't build your daily report. Want me to try again?");
  });
  it('covers whole India-time days, ending now or at midnight for yesterday', () => {
    expect(reportRange('today', NOW)).toEqual({ since: TODAY, end: NOW });
    expect(reportRange('yesterday', NOW)).toEqual({ since: TODAY - DAY, end: TODAY });
    // Wednesday 18 November: the week started on Monday 16th.
    expect(reportRange('this_week', NOW)).toEqual({ since: TODAY - 2 * DAY, end: NOW });
    expect(reportRange('last_7_days', NOW)).toEqual({ since: TODAY - 6 * DAY, end: NOW });
    expect(reportRange('this_month', NOW)).toEqual({ since: zonedTime('2026-11-01', 0), end: NOW });
  });
  it('gives the download a clean filename', () => {
    expect(reportFilename('last_7_days', NOW)).toBe('ASK IT Weekly Service Desk Report 18 Nov 2026.pdf');
    expect(reportFilename('today', NOW)).toBe('ASK IT Daily Service Desk Report 18 Nov 2026.pdf');
  });
  it('writes spans of time compactly', () => {
    expect(spanText(20 * 1000)).toBe('1 min');
    expect(spanText(45 * MINUTE)).toBe('45 min');
    expect(spanText(5 * HOUR)).toBe('5 h');
    expect(spanText(5 * HOUR + 20 * MINUTE)).toBe('5 h 20 min');
    expect(spanText(DAY)).toBe('1 d');
    expect(spanText(3 * DAY + 4 * HOUR + 59 * MINUTE)).toBe('3 d 4 h');
  });
});

describe('buildReportData', () => {
  it('describes the period in words with exact dates, and the source', () => {
    const d = buildReportData(input({ source: { mode: 'live', host: 'acme.service-now.com' } }));
    expect(d).toMatchObject({ title: 'Weekly IT Service Desk Report', kind: 'Weekly', periodLabel: 'Last 7 days', range: '12 to 18 November 2026', prepared: '18 November 2026 at 9.30 AM India time', source: 'Live from ServiceNow, acme.service-now.com' });
    expect(buildReportData(input()).source).toBe('Simulated data');
    expect(buildReportData(input()).scope).toBeNull();
    expect(buildReportData(input({ source: { mode: 'live', host: 'acme.service-now.com', windowDays: 30 } })).scope).toBe('Open incidents are those opened in the last 30 days');
    expect(buildReportData(input({ period: 'today' })).range).toBe('18 November 2026');
    expect(buildReportData(input({ period: 'yesterday' })).range).toBe('17 November 2026');
    expect(buildReportData(input({ period: 'this_month' })).range).toBe('1 to 18 November 2026');
    const acrossMonths = buildReportData(input({ now: zonedTime('2026-12-02', 600) }));
    expect(acrossMonths.range).toBe('26 November to 2 December 2026');
    const acrossYears = buildReportData(input({ now: zonedTime('2027-01-03', 600) }));
    expect(acrossYears.range).toBe('28 December 2026 to 3 January 2027');
  });
  it('is all zeros and empty lists with no data, never invented numbers', () => {
    const d = buildReportData(input());
    expect(d.figures).toEqual({ open: 0, openMore: false, critical: 0, unassigned: 0, onHold: 0, newInPeriod: 0, resolvedInPeriod: 0, avgResolve: null, oldest: null });
    expect(d.attention).toEqual({ urgent: [], blocked: [], unassigned: [] });
    expect(d.resolved).toEqual([]);
    expect(d.openRows).toEqual([]);
    expect(d.byPriority.map((r) => r.count)).toEqual([0, 0, 0, 0]);
    expect(d.byTeam).toEqual([]);
    expect(d.days).toHaveLength(7);
    expect(d.days.every((x) => x.opened === 0 && x.resolved === 0)).toBe(true);
  });
  it('reads the simulated desk: headline figures, attention lists and the open table', () => {
    const notes = { INC0013006: { at: NOW - DAY, author: 'david.loo', text: 'Replacement battery ordered from the vendor,\nwaiting for delivery' } };
    const d = buildReportData(input({ open: OPEN, opened: OPEN.map((i) => i.openedAt!), notes }));
    expect(d.figures).toMatchObject({ open: 14, critical: 3, unassigned: 4, onHold: 1, newInPeriod: 14, resolvedInPeriod: 0, avgResolve: null });
    expect(d.figures.oldest).toEqual({ number: 'INC0013013', age: '5 d' });
    expect(d.attention.urgent.map((i) => i.number)).toEqual(['INC0013002', 'INC0013003', 'INC0013001', 'INC0013004']);
    expect(d.attention.urgent[0]).toMatchObject({ priority: 1, priorityLabel: 'Critical', state: 'In Progress', team: 'Software', assignee: 'Karthik Nair', age: '1 d' });
    expect(d.attention.blocked).toEqual([expect.objectContaining({ number: 'INC0013006', waitingOn: 'Awaiting vendor', reason: 'Replacement battery ordered from the vendor, waiting for delivery' })]);
    expect(d.attention.unassigned.map((i) => i.number)).toEqual(['INC0013003', 'INC0013001', 'INC0013007', 'INC0013005']);
    expect(d.openRows).toHaveLength(14);
    expect(d.openRows[0]).toMatchObject({ number: 'INC0013002', opened: '17 Nov' });
    expect(d.openRows.find((i) => i.number === 'INC0013001')).toMatchObject({ team: '', assignee: '', age: '3 h' });
    // Ages stay short in their column: whole hours under a day.
    const late = buildReportData(input({ open: [{ ...OPEN[0], openedAt: NOW - 11 * HOUR - 53 * MINUTE }] }));
    expect(late.openRows[0].age).toBe('11 h');
    expect(late.figures.oldest?.age).toBe('11 h 53 min');
    expect(d.byState).toEqual([{ label: 'New', count: 10 }, { label: 'In Progress', count: 3 }, { label: 'On Hold', count: 1 }]);
  });
  it('uses the hold reason when there is no work note, and says when there is neither', () => {
    const held = { ...OPEN[0], number: 'INC0019001', state: '3', stateLabel: 'On Hold', holdReason: '1' };
    const unknown = { ...held, number: 'INC0019002', holdReason: null };
    const d = buildReportData(input({ open: [held, unknown] }));
    expect(d.attention.blocked.map((b) => [b.waitingOn, b.reason])).toEqual([['Awaiting caller', 'No work note yet'], ['Not given', 'No work note yet']]);
  });
  it('counts new and resolved per day across the period, zero days included', () => {
    const opened = [NOW - MINUTE, TODAY + MINUTE, TODAY - 1, TODAY - 6 * DAY, TODAY - 6 * DAY - 1];
    const resolved = [resolvedRow(1, NOW - HOUR, NOW - 3 * HOUR), resolvedRow(2, TODAY - 2 * DAY + HOUR, null), resolvedRow(3, TODAY - 9 * DAY, TODAY - 10 * DAY)];
    const d = buildReportData(input({ opened, resolved }));
    expect(d.days.map((x) => x.label)).toEqual(['Thu 12', 'Fri 13', 'Sat 14', 'Sun 15', 'Mon 16', 'Tue 17', 'Wed 18']);
    expect(d.days.map((x) => x.opened)).toEqual([1, 0, 0, 0, 0, 1, 2]);
    expect(d.days.map((x) => x.resolved)).toEqual([0, 0, 0, 0, 1, 0, 1]);
    expect(d.figures).toMatchObject({ newInPeriod: 4, resolvedInPeriod: 2 });
    const month = buildReportData(input({ period: 'this_month', opened, resolved }));
    expect(month.days).toHaveLength(18);
    expect(month.days[0].label).toBe('1');
    expect(month.figures.resolvedInPeriod).toBe(3);
  });
  it('averages the time to resolve over resolutions in the period that know when they were opened', () => {
    const resolved = [
      resolvedRow(1, NOW - HOUR, NOW - 3 * HOUR, { group: { id: 'g', name: 'Network' }, assignee: { id: 'u', name: 'Arjun Rao' } }),
      resolvedRow(2, TODAY - DAY, TODAY - 2 * DAY),
      resolvedRow(3, NOW - 2 * HOUR, null),
      resolvedRow(4, NOW - 2 * HOUR, NOW - HOUR),
    ];
    const d = buildReportData(input({ resolved }));
    expect(d.figures.avgResolve).toEqual({ text: '13 h', count: 2 });
    expect(d.resolved.map((r) => [r.number, r.took])).toEqual([
      ['INC002001', '2 h'],
      ['INC002003', 'Unknown'],
      ['INC002004', 'Unknown'],
      ['INC002002', '1 d'],
    ]);
    expect(d.resolved[0]).toMatchObject({ title: 'Fixed thing 1', team: 'Network', assignee: 'Arjun Rao', resolved: '18 Nov' });
  });
  it('keeps yesterday to yesterday', () => {
    const resolved = [resolvedRow(1, TODAY - HOUR, TODAY - 2 * HOUR), resolvedRow(2, TODAY + HOUR, TODAY)];
    const d = buildReportData(input({ period: 'yesterday', opened: [TODAY - HOUR, TODAY + HOUR, TODAY - DAY - 1], resolved }));
    expect(d.days).toEqual([{ label: 'Tue 17', opened: 1, resolved: 1 }]);
    expect(d.figures).toMatchObject({ newInPeriod: 1, resolvedInPeriod: 1, avgResolve: { text: '1 h', count: 1 } });
  });
  it('shows each team with its open work and who is busy or free, from the roster', () => {
    const person = (name: string, teams: string[], open: number): Resource => ({ id: name, name, teams, open: Array.from({ length: open }, (_, n) => ({ number: `INC${n}`, summary: 's', priority: 3, priorityLabel: 'Moderate' })) });
    const roster = [person('Arjun Rao', ['Network'], 1), person('Fred Luddy', ['Network', 'Software'], 0), person('Meera Krishnan', ['Software'], 2)];
    const d = buildReportData(input({ open: OPEN, roster }));
    const row = (team: string) => d.workload.find((w) => w.team === team);
    expect(row('Network')).toEqual({ team: 'Network', open: 1, engineers: 2, busy: 1, free: 1 });
    expect(row('Software')).toEqual({ team: 'Software', open: 3, engineers: 2, busy: 1, free: 1 });
    expect(row('Payroll')).toEqual({ team: 'Payroll', open: 1, engineers: 0, busy: 0, free: 0 });
    expect(row('Field Services')).toEqual({ team: 'Field Services', open: 1, engineers: null, busy: null, free: null });
    expect(row('No group')).toEqual({ team: 'No group', open: 1, engineers: null, busy: null, free: null });
    expect(d.workload.reduce((n, w) => n + w.open, 0)).toBe(14);
  });
  it('marks more open incidents than were read', () => {
    expect(buildReportData(input({ open: OPEN, openMore: true })).figures).toMatchObject({ open: 14, openMore: true });
  });
});

describe('SimulatedDesk.resolvedSince', () => {
  it('returns the incidents resolved in this session since a moment, newest first', async () => {
    const state = freshState();
    state.itdesk.backlog[0] = { ...state.itdesk.backlog[0], state: '6', stateLabel: 'Resolved', resolvedAt: NOW - HOUR };
    state.itdesk.backlog[1] = { ...state.itdesk.backlog[1], state: '6', stateLabel: 'Resolved', resolvedAt: NOW - MINUTE };
    state.itdesk.backlog[2] = { ...state.itdesk.backlog[2], state: '6', stateLabel: 'Resolved', resolvedAt: NOW - 3 * DAY };
    const res = await new SimulatedDesk(state, NOW).resolvedSince(NOW - DAY, 10);
    expect(res.ok && res.value.map((i) => [i.number, i.resolvedAt])).toEqual([['INC0013002', NOW - MINUTE], ['INC0013001', NOW - HOUR]]);
    expect(res.ok && 'notes' in res.value[0]).toBe(false);
  });
});

describe('readReport', () => {
  it('reads the queue, the period, the roster and the blocked notes from the desk', async () => {
    const state = freshState();
    const desk = makeDeps(state, NOW).desk;
    const read = await readReport(desk, 'last_7_days', NOW, reportSource(desk));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toMatchObject({ period: 'last_7_days', now: NOW, openMore: false, resolvedMore: false, source: { mode: 'simulated' } });
    expect(read.value.open).toHaveLength(14);
    expect(read.value.opened).toHaveLength(14);
    expect(read.value.roster.length).toBeGreaterThan(10);
    expect(read.value.notes).toEqual({ INC0013006: expect.objectContaining({ text: 'Replacement battery ordered from the vendor, waiting for delivery' }) });
  });
  it('fails as the desk failed when any main read fails, and gets by without a note', async () => {
    const state = freshState();
    const down = failure<never>({ kind: 'unavailable' });
    for (const broken of ['listOpen', 'activity', 'resolvedSince', 'roster'] as const) {
      const desk = makeDeps(state, NOW, { desk: { [broken]: async () => down } }).desk;
      expect(await readReport(desk, 'today', NOW, { mode: 'simulated' })).toEqual(down);
    }
    const desk = makeDeps(state, NOW, { desk: { workNotes: async () => down } }).desk;
    const read = await readReport(desk, 'today', NOW, { mode: 'simulated' });
    expect(read.ok && read.value.notes).toEqual({ INC0013006: undefined });
  });
  it('flags more rows than it reads', async () => {
    const row = OPEN[0];
    const desk = makeDeps(freshState(), NOW, { desk: { listOpen: async () => success(Array.from({ length: 501 }, () => row)), resolvedSince: async () => success(Array.from({ length: 501 }, () => ({ ...row, resolvedAt: NOW }))) } }).desk;
    const read = await readReport(desk, 'today', NOW, { mode: 'simulated' });
    expect(read.ok && [read.value.open.length, read.value.openMore, read.value.resolved.length, read.value.resolvedMore]).toEqual([500, true, 500, true]);
  });
  it('names the live instance and its window of days', () => {
    const live = { mode: 'live' as const } as Parameters<typeof reportSource>[0];
    const env = { SERVICENOW_INSTANCE_URL: 'https://acme.service-now.com/', SERVICENOW_USER: 'u', SERVICENOW_PASSWORD: 'p', SERVICENOW_CALLER_EMAIL: 'c@x.example' };
    expect(reportSource(live, env)).toEqual({ mode: 'live', host: 'acme.service-now.com', windowDays: 30 });
    expect(reportSource(live, { ...env, SERVICENOW_QUEUE_DAYS: '0' })).toEqual({ mode: 'live', host: 'acme.service-now.com', windowDays: 0 });
    expect(reportSource(live, {})).toEqual({ mode: 'simulated' });
  });
});
