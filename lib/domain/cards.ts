import type { CardStatus, CardUpdate } from '@/lib/integrations/types';
import { nextId, queueAlert } from './actions';
import type { Alert, Issue, Notification, SessionState } from './types';

export const CARD_STATUS: Record<CardStatus, { emoji: string; label: string }> = {
  opened: { emoji: ':new:', label: 'Opened' },
  in_progress: { emoji: ':hammer_and_wrench:', label: 'In progress' },
  waiting_employee: { emoji: ':hourglass_flowing_sand:', label: 'Waiting for employee' },
  resolved_by_askit: { emoji: ':white_check_mark:', label: 'Resolved by ASK IT' },
  ticket_raised: { emoji: ':ticket:', label: 'Ticket raised' },
  escalated: { emoji: ':rotating_light:', label: 'Escalated' },
  assigned: { emoji: ':bust_in_silhouette:', label: 'Assigned' },
  on_hold: { emoji: ':double_vertical_bar:', label: 'On hold' },
  resolved_by_it: { emoji: ':heavy_check_mark:', label: 'Resolved by IT' },
  reopened: { emoji: ':leftwards_arrow_with_hook:', label: 'Reopened' },
};

const CLOSED: CardStatus[] = ['resolved_by_askit', 'resolved_by_it'];

// Plain text for webhooks and as the Slack notification fallback.
function cardText(card: CardUpdate): string {
  const s = CARD_STATUS[card.status];
  return `${s.label}: ${card.title}${card.ticket ? ` (${card.ticket})` : ''}. ${card.detail}`;
}

interface IssueOptions {
  // Title when a new issue starts.
  title: string;
  // Start a new issue even when one is open.
  fresh?: boolean;
  // A real ticket number for this issue; the card is also known by it from now on.
  ticket?: string;
  text?: string;
  kind?: Notification['kind'];
}

// A milestone for the employee's current issue (or a new one), queued for its live card.
export function issueMilestone(state: SessionState, now: number, status: CardStatus, detail: string, o: IssueOptions): Alert {
  const open = state.issue && !CLOSED.includes(state.issue.status) ? state.issue : null;
  const issue: Issue = open && !o.fresh ? open : { id: nextId(state, 'ISS'), title: o.title, status };
  state.issue = issue;
  const key = issue.ticket ?? `${state.id}:${issue.id}`;
  const alias = o.ticket && !issue.ticket && /^INC\d{7}$/.test(o.ticket) ? o.ticket : undefined;
  if (alias) issue.ticket = alias;
  issue.status = status;
  const e = state.employee;
  const card: CardUpdate = { key, ...(alias ? { alias } : {}), status, title: issue.title, person: e.name, device: e.device.id, ...(issue.ticket ? { ticket: issue.ticket } : {}), detail, at: now };
  return queueAlert(state, now, o.kind ?? 'issueStatus', o.text ?? cardText(card), card);
}

// A milestone for a card that is keyed by its ticket number.
export function ticketMilestone(state: SessionState, now: number, t: { number: string; title: string; person: string; device?: string }, status: CardStatus, detail: string, text?: string, kind: Notification['kind'] = 'issueStatus'): Alert {
  const card: CardUpdate = { key: t.number, status, title: t.title, person: t.person, ...(t.device ? { device: t.device } : {}), ticket: t.number, detail, at: now };
  return queueAlert(state, now, kind, text ?? cardText(card), card);
}
