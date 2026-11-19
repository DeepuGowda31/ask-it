import type { Mode, RemoteTicket } from '@/lib/integrations/types';
import { isOpen, mergeRemote } from './tickets';
import { MINUTE } from './time';
import type { FollowUp, Reminder, SessionState, TicketRecord } from './types';

// Follow-up calls: when IT resolves one of Priya's tickets outside ASK IT, or a reminder she asked for is due, her page rings.

export const SNOOZE_MS = 10 * MINUTE;
const MAX_QUEUE = 10;
const MAX_RUNG = 50;

export const isResolved = (t: TicketRecord) => /^resolved$/i.test(t.state.trim());

export const isRinging = (f: FollowUp | null | undefined, now: number) => Boolean(f && (f.status === 'ringing' || (f.status === 'snoozed' && now >= (f.snoozedUntil ?? 0))));

function logOf(state: SessionState) {
  return (state.followUpLog ??= { queue: [], rung: [] });
}

// What a ring is answered and snoozed by: the ticket of a follow-up, the id of a reminder.
export const ringId = (f: FollowUp) => f.reminder ?? f.number;

const stillResolved = (state: SessionState, f: FollowUp) => state.tickets.some((t) => t.number === f.number && isResolved(t));

const reminderRing = (r: Reminder): FollowUp => ({ number: r.ticket ?? '', summary: r.about, resolvedAt: r.at, status: 'ringing', reminder: r.id });

// The earliest due reminder; it never rings during a call.
function dueReminder(state: SessionState, now: number) {
  if (state.call.active) return undefined;
  return state.reminders?.filter((r) => r.status === 'pending' && r.at <= now).sort((a, b) => a.at - b.at)[0];
}

// Drops follow-ups whose ticket is no longer resolved, then rings the next resolution, else the next due reminder, when the line is free.
function settle(state: SessionState, now: number) {
  const current = state.followUp;
  if (current && !current.reminder && current.status !== 'answered' && !stillResolved(state, current)) state.followUp = null;
  const log = state.followUpLog;
  if (log?.queue.length) log.queue = log.queue.filter((f) => stillResolved(state, f));
  const free = !state.followUp || (state.followUp.status === 'answered' && !state.call.active);
  if (!free) return;
  if (log?.queue.length) {
    state.followUp = log.queue.shift()!;
    return;
  }
  const due = dueReminder(state, now);
  if (!due) return;
  due.status = 'rung';
  state.followUp = reminderRing(due);
}

// Queues each resolution once, newest first.
function queueResolved(state: SessionState, tickets: TicketRecord[]) {
  if (!tickets.length) return;
  const log = logOf(state);
  for (const t of tickets) {
    if (log.rung.includes(t.number)) continue;
    log.rung = [...log.rung, t.number].slice(-MAX_RUNG);
    log.queue.push({ number: t.number, summary: t.summary, resolvedAt: t.updatedAt, status: 'ringing' });
  }
  log.queue = log.queue.sort((a, b) => b.resolvedAt - a.resolvedAt).slice(0, MAX_QUEUE);
}

// Applies a ServiceNow list and queues a follow-up for every ticket that went from open to Resolved since the last look.
export function mergeTickets(state: SessionState, remote: RemoteTicket[], mode: Mode, now: number) {
  const before = new Map(state.tickets.map((t) => [t.number, t]));
  mergeRemote(state, remote, mode, now);
  queueResolved(state, state.tickets.filter((t) => {
    const old = before.get(t.number);
    return old && t.sysId && isOpen(old) && isResolved(t);
  }));
  settle(state, now);
}

// Pure: the same state object back when the list changed nothing, so the caller skips the write.
export function applyTicketList(current: SessionState, remote: RemoteTicket[], mode: Mode, now: number): SessionState {
  const state = structuredClone(current);
  mergeTickets(state, remote, mode, now);
  return JSON.stringify(state) === JSON.stringify(current) ? current : state;
}

// Pure: rings what is due when the line is free; the same state object back when nothing changed.
export function settleRings(current: SessionState, now: number): SessionState {
  const state = structuredClone(current);
  settle(state, now);
  return JSON.stringify(state) === JSON.stringify(current) ? current : state;
}

// Pure: "Not now" for the ringing ticket or reminder, by its ring id; null when it is not ringing.
export function snoozeFollowUp(current: SessionState, id: string, now: number): SessionState | null {
  const f = current.followUp;
  if (!f || ringId(f) !== id || f.status === 'answered') return null;
  const state = structuredClone(current);
  state.followUp = { ...f, status: 'snoozed', snoozedUntil: now + SNOOZE_MS };
  return state;
}

// Marks the ringing follow-up or reminder answered, by its ring id; it never rings again. Mutates.
export function answerFollowUp(state: SessionState, id: string): boolean {
  const f = state.followUp;
  if (!f || ringId(f) !== id || f.status === 'answered') return false;
  state.followUp = { number: f.number, summary: f.summary, resolvedAt: f.resolvedAt, status: 'answered', ...(f.reminder ? { reminder: f.reminder } : {}) };
  return true;
}
