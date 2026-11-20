import type { DeskIncident } from '@/lib/integrations/types';
import { reportNames } from './report';
import { missingOf } from './tools/itdesk';
import type { SessionState } from './types';

// Read model for the IT dashboard: names only, never sys_ids.
const item = (i: DeskIncident) => ({
  number: i.number,
  summary: i.summary,
  priority: i.priority,
  priorityLabel: i.priorityLabel,
  state: i.state,
  stateLabel: i.stateLabel,
  holdReason: i.holdReason,
  assignee: i.assignee?.name ?? null,
  group: i.group?.name ?? null,
  caller: i.caller,
  category: i.category,
  urgency: i.urgency,
  impact: i.impact,
  openedAt: i.openedAt,
});

export function buildItDeskView(state: SessionState, now: number) {
  const desk = state.itdesk;
  const current = desk.current;
  const waiting = [...state.pending].reverse().find((a) => a.status === 'pending' && a.expiresAt > now && a.payload.kind === 'incident');
  return {
    queue: desk.queue.map(item),
    current: current ? { ...item(current), missing: missingOf(current), workNotes: current.notes } : null,
    lastUpdate: desk.lastUpdate,
    board: desk.board ?? null,
    updateRequest: desk.updateRequest ?? null,
    report: desk.report ? { id: desk.report.id, status: desk.report.status, requestedAt: desk.report.requestedAt, filename: desk.report.filename ?? null, ...reportNames(desk.report.period) } : null,
    pending: waiting?.payload.kind === 'incident' ? { code: waiting.code, number: waiting.payload.number, summary: waiting.summary, changes: waiting.payload.changes, expiresAt: waiting.expiresAt } : null,
  };
}
