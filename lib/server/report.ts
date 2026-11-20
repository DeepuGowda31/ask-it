import { buildReportData, reportRange, type ReportInput, type ReportPeriod } from '@/lib/domain/report';
import { TEAMS } from '@/lib/domain/tools/itdesk';
import { success, type Result } from '@/lib/integrations/http';
import { serviceNowConfig } from '@/lib/integrations/servicenow';
import { queueWindowDays } from '@/lib/integrations/servicenow-desk';
import type { DeskAdapter } from '@/lib/integrations/types';
import { renderReportPdf } from './report-pdf';

type Env = Record<string, string | undefined>;

// Rows read per table; a fuller table says so on the page.
const LIMIT = 500;
// On hold incidents whose latest work note is read as the reason they are blocked.
const NOTES = 20;

// Where the numbers come from, as the report states it.
export function reportSource(desk: DeskAdapter, env: Env = process.env): ReportInput['source'] {
  const cfg = desk.mode === 'live' ? serviceNowConfig(env) : null;
  if (!cfg) return { mode: 'simulated' };
  let host: string | undefined;
  try {
    host = new URL(cfg.instanceUrl).host;
  } catch {
    host = undefined;
  }
  return { mode: 'live', ...(host ? { host } : {}), windowDays: queueWindowDays(env) };
}

// Everything the report shows, read once: the open queue, the period's activity and resolutions, the roster, then the blocked incidents' notes.
export async function readReport(desk: DeskAdapter, period: ReportPeriod, now: number, source: ReportInput['source']): Promise<Result<ReportInput>> {
  const { since } = reportRange(period, now);
  const [open, activity, resolved, roster] = await Promise.all([desk.listOpen({ sort: 'priority' }, LIMIT + 1), desk.activity(since), desk.resolvedSince(since, LIMIT + 1), desk.roster(TEAMS)]);
  if (!open.ok) return open;
  if (!activity.ok) return activity;
  if (!resolved.ok) return resolved;
  if (!roster.ok) return roster;
  const rows = open.value.slice(0, LIMIT);
  const held = rows.filter((i) => i.state === '3').slice(0, NOTES);
  // A note that cannot be read leaves the hold reason as the only reason given.
  const notes = await Promise.all(held.map((i) => desk.workNotes(i.sysId)));
  return success({
    period,
    now,
    open: rows,
    openMore: open.value.length > LIMIT,
    opened: activity.value.opened,
    resolved: resolved.value.slice(0, LIMIT),
    resolvedMore: resolved.value.length > LIMIT,
    roster: roster.value,
    notes: Object.fromEntries(held.map((i, k) => [i.number, notes[k].ok ? notes[k].value[0] : undefined])),
    source,
  });
}

// The PDF, or why it could not be built: `read` when the desk did not answer, `render` when drawing it failed.
export async function buildReport(desk: DeskAdapter, period: ReportPeriod, now: number, env: Env = process.env): Promise<{ ok: true; pdf: Uint8Array } | { ok: false; why: 'read' | 'render' }> {
  const read = await readReport(desk, period, now, reportSource(desk, env));
  if (!read.ok) return { ok: false, why: 'read' };
  try {
    return { ok: true, pdf: await renderReportPdf(buildReportData(read.value)) };
  } catch (error) {
    console.error('Report could not be drawn:', error instanceof Error ? error.name : 'unknown error');
    return { ok: false, why: 'render' };
  }
}
