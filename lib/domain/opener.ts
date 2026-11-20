import { isoDate, zonedTime } from './time';
import type { SessionState, TicketRecord } from './types';

// The one line an employee call adds when the caller stays quiet after the greeting.
export interface Opener {
  kind: 'outage' | 'resolved' | 'changed' | 'default';
  say: string;
  ticket?: string;
  incident?: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// "earlier today", "yesterday" or "on Monday", in India time.
export function dayWord(at: number, now: number): string {
  const day = isoDate(at);
  if (day === isoDate(now)) return 'earlier today';
  if (day === isoDate(zonedTime(isoDate(now), 0) - 1)) return 'yesterday';
  return `on ${WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]}`;
}

export const resolvedTime = (t: TicketRecord) => t.resolvedAt ?? t.updatedAt;

// The line after the greeting when the caller stays quiet: an offer of help, nothing more.
export function callOpener(_state: SessionState, _now: number): Opener {
  return { kind: 'default', say: "I'm here to help you sort out any IT issue. What's going on?" };
}
