import { REPORT_PENDING_MS, REPORT_PERIODS, reportNames, reportPendingLine, reportStartLine, type ReportPeriod } from '../report';
import { failed, ok, tool } from './shared';

// Read-only, so no yes is needed: the tool only records the request; the IT page builds and downloads the PDF.
const generateReport = tool({
  name: 'generateReport',
  description:
    "Puts together a PDF report of the service desk from the live queue and downloads it on the engineer's screen within seconds: key figures, open incidents by priority, state and team, new and resolved per day, what needs attention, what was resolved, team workload and every open incident.",
  params: {
    period: {
      description:
        'today for a daily or today\'s report, yesterday for yesterday\'s report, last_7_days for a weekly report or the last 7 days, this_week for this week, this_month for a monthly report. Empty string when the engineer did not say which, so you ask "Daily, weekly or monthly?" first.',
      enum: REPORT_PERIODS,
      allowEmpty: true,
    },
  },
  personas: ['itdesk'],
  minutesSaved: 10,
  run({ state, now, claim }, args) {
    const period = args.period as ReportPeriod | '';
    if (!period) return failed('Report period needed', 'period_needed', 'Daily, weekly or monthly?', undefined, 'When the engineer answers, call generateReport again with that period.');
    const current = state.itdesk.report;
    if (current?.status === 'pending' && now - current.requestedAt < REPORT_PENDING_MS) {
      const other = current.period !== period ? `Offer to start the ${reportNames(period).kind.toLowerCase()} report once this one has downloaded.` : undefined;
      return { title: `${reportNames(current.period).kind} report already in progress`, result: ok(reportPendingLine(current.period), { status: 'pending', period: current.period }, other) };
    }
    state.itdesk.report = { id: claim || `report-${now}`, period, requestedAt: now, status: 'pending' };
    return {
      title: `${reportNames(period).kind} report requested`,
      result: ok(reportStartLine(period), { status: 'pending', period }, 'The report downloads by itself and its ready line is said for you. Do not wait for it. Carry on with whatever the engineer asks next.'),
    };
  },
});

export const REPORT_TOOLS = [generateReport];
