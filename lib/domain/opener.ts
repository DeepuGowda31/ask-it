import { isResolved } from './followup';
import { mentionsService, outageName } from './services';
import { isAskItFix, isOpen, plainText, ticketPhrase } from './tickets';
import { DAY, isoDate, zonedTime } from './time';
import type { Outage, SessionState, TicketRecord } from './types';

// The one line an employee call adds when the caller stays quiet after the greeting, chosen from what the session knows.
export interface Opener {
  kind: 'outage' | 'resolved' | 'changed' | 'default';
  say: string;
  ticket?: string;
  incident?: string;
}

const RECENT_MS = 3 * DAY;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ABOUT_THAT = 'Is this about that, or something else?';

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// "earlier today", "yesterday" or "on Monday", in India time.
export function dayWord(at: number, now: number): string {
  const day = isoDate(at);
  if (day === isoDate(now)) return 'earlier today';
  if (day === isoDate(zonedTime(isoDate(now), 0) - 1)) return 'yesterday';
  return `on ${WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]}`;
}

// An outage the employee follows, or one whose service a recent ticket of theirs names.
function myOutage(state: SessionState, now: number): Outage | undefined {
  const reported = state.tickets.filter((t) => isOpen(t) || now - t.updatedAt <= RECENT_MS);
  return state.outages.find((o) => o.followed || (o.service && reported.some((t) => mentionsService(t.summary, o.service))));
}

// ServiceNow's resolution time, else the last update.
export const resolvedTime = (t: TicketRecord) => t.resolvedAt ?? t.updatedAt;

// The newest ticket IT resolved in the last 3 days that the employee has not confirmed with ASK IT.
function unconfirmedResolution(state: SessionState, now: number): TicketRecord | undefined {
  const confirmed = new Set((state.fixChecks ?? []).filter((c) => c.status === 'done').map((c) => c.number));
  return state.tickets
    .filter((t) => t.sysId && isResolved(t) && !isAskItFix(t) && !confirmed.has(t.number) && now - resolvedTime(t) <= RECENT_MS)
    .sort((a, b) => resolvedTime(b) - resolvedTime(a))[0];
}

// The newest open ticket ServiceNow showed changing state since the last call started.
function changedTicket(state: SessionState, now: number): TicketRecord | undefined {
  const since = Math.max(now - RECENT_MS, state.call.startedAt ?? 0);
  return state.tickets
    .filter((t) => t.sysId && isOpen(t) && !isAskItFix(t) && t.changedAt !== undefined && t.changedAt > since)
    .sort((a, b) => b.changedAt! - a.changedAt!)[0];
}

function changeSay(t: TicketRecord): string {
  const name = ticketPhrase(t.summary);
  const state = t.state.trim().toLowerCase();
  if (state === 'in progress') return `IT has started work on ${name}. ${ABOUT_THAT}`;
  if (state === 'on hold') return `${capital(name)} is on hold for now. ${ABOUT_THAT}`;
  if (state === 'new') return `${capital(name)} is open again. ${ABOUT_THAT}`;
  return `${capital(name)} is now ${state}. ${ABOUT_THAT}`;
}

// Priority: a matching outage, then an unconfirmed resolution, then a change IT made, else the plain question.
// Called when the call starts, before it is recorded, so `state.call` is still the previous call.
export function callOpener(state: SessionState, now: number): Opener {
  const outage = myOutage(state, now);
  if (outage) {
    const what = outage.service ? `the ${outageName(outage).replace(/^the /, '')} outage` : `the outage, ${plainText(outage.title)}`;
    return { kind: 'outage', incident: outage.incident, say: `IT is still working on ${what}. Is that why you're calling, or is it something else?` };
  }
  const resolved = unconfirmedResolution(state, now);
  if (resolved) {
    const say = `${capital(ticketPhrase(resolved.summary))} was resolved ${dayWord(resolvedTime(resolved), now)}. Is it working now, or is this about something else?`;
    return { kind: 'resolved', ticket: resolved.number, say };
  }
  const changed = changedTicket(state, now);
  if (changed) return { kind: 'changed', ticket: changed.number, say: changeSay(changed) };
  return { kind: 'default', say: 'What can I help you with today?' };
}
