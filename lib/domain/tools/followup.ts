import { describeFailure, type Result } from '@/lib/integrations/http';
import type { Mode } from '@/lib/integrations/types';
import { CLAIM_TTL_MS, nextId } from '../actions';
import { ticketMilestone } from '../cards';
import { isResolved } from '../followup';
import { MAX_AHEAD_MS, MAX_PENDING_REMINDERS, parseWhen, reminderLabel, spokenWhen } from '../reminders';
import { clip, echo, findTicket, spokenTicket } from '../tickets';
import { DAY } from '../time';
import type { FixCheck, FixOutcome, SessionState, TicketRecord } from '../types';
import { alertSay, failed, ok, tool, type Outcome } from './shared';

const MAX_CHECKS = 20;

// Empty means the ticket this follow-up call is about, or the one just answered, so a retry finds it. A reminder is no follow-up.
const target = (state: SessionState, raw: string): TicketRecord | undefined => {
  const f = state.followUp?.reminder ? null : state.followUp;
  const number = f?.number ?? state.fixChecks?.at(-1)?.number;
  return raw ? findTicket(state, raw) : state.tickets.find((t) => t.number === number);
};

const checkOf = (state: SessionState, number: string) => state.fixChecks?.find((c) => c.number === number);

function saveCheck(state: SessionState, check: FixCheck | null, number: string) {
  const rest = (state.fixChecks ?? []).filter((c) => c.number !== number);
  state.fixChecks = check ? [...rest, check].slice(-MAX_CHECKS) : rest;
}

const workNote = (outcome: FixOutcome, note: string) => {
  const lead = outcome === 'fixed' ? 'Caller confirmed the fix by voice' : 'Caller says the fix did not work';
  return note ? `${lead}: ${note}` : lead;
};

// The follow-up for this ticket is settled; the next queued one rings after the call.
function settleFollowUp(state: SessionState, number: string) {
  if (state.followUp?.number === number && !state.followUp.reminder) state.followUp = null;
  if (state.followUpLog) state.followUpLog.queue = state.followUpLog.queue.filter((f) => f.number !== number);
}

// When it is not resolved any more, there is nothing to close or reopen.
function notResolved(state: SessionState, t: TicketRecord, outcome: FixOutcome): Outcome {
  const spoken = spokenTicket(t.number);
  if (/closed|cancel/i.test(t.state)) {
    settleFollowUp(state, t.number);
    if (outcome === 'fixed') return { title: `${t.number} already closed`, result: ok(`Glad it works. ${spoken} is already closed, so there's nothing more to do.`, { number: t.number, alreadyClosed: true }) };
    return failed(`Reopen: ${t.number} already closed`, 'ticket_closed', `${spoken} is already closed in ServiceNow, so I can't reopen it. I can raise a new ticket with what's still wrong. Shall I?`, ['prepareTicket'], 'If she agrees, call prepareTicket.');
  }
  return failed(`Confirm fix: ${t.number} not resolved`, 'ticket_open', `${spoken} isn't marked resolved, it's ${t.state.toLowerCase()}, so IT is still working on it. I can add what you said as a note.`, ['addTicketNote'], 'If she wants, call addTicketNote with her words.');
}

const RETRY_NEXT = 'If Priya wants, call confirmFix again with the same answer; retrying is safe.';

function commitFailed(t: TicketRecord, outcome: FixOutcome, result: Result<null>): Outcome {
  const error = result.ok ? { kind: 'bad_response' as const } : result.error;
  const unknown = error.kind === 'timeout' || error.kind === 'network';
  if (outcome === 'fixed') {
    const say = unknown
      ? "Glad it works. I'm not sure ServiceNow closed the ticket, because it did not answer in time. Shall I try again?"
      : `Glad it works. I couldn't close it in ServiceNow: ${describeFailure('ServiceNow', error)} It stays resolved. Shall I try again?`;
    return failed(`Close of ${t.number} not saved`, 'close_not_synced', say, undefined, RETRY_NEXT);
  }
  const say = unknown
    ? "I'm not sure ServiceNow reopened it, because it did not answer in time. Shall I try again?"
    : `I couldn't reopen it in ServiceNow: ${describeFailure('ServiceNow', error)} Nothing changed yet. Shall I try again, or raise a new ticket instead?`;
  return failed(`Reopen of ${t.number} not saved`, 'reopen_not_synced', say, undefined, RETRY_NEXT);
}

interface FixEffect {
  notifyMode: Mode;
  saved: Result<null>;
}

const confirmFix = tool<FixEffect>({
  name: 'confirmFix',
  description:
    "Record Priya's answer on a follow-up call about a ticket IT resolved: fixed closes it in ServiceNow, not_fixed reopens it at high urgency with her words and alerts IT. Her spoken answer to the follow-up question is the approval: call it straight away, never ask for another yes. Safe to repeat.",
  params: {
    ticket: { description: 'Ticket number as said, or empty string for the ticket this call is about', allowEmpty: true },
    outcome: { description: 'fixed if it works now, not_fixed if it still fails', enum: ['fixed', 'not_fixed'] },
    note: { description: 'What Priya said, in her words, or empty string', allowEmpty: true },
  },
  minutesSaved: 5,
  begin(state, args, now, claim) {
    const t = target(state, args.ticket);
    if (!t?.sysId || !isResolved(t)) return false;
    const check = checkOf(state, t.number);
    if (check?.status === 'committing' && now - (check.claimedAt ?? 0) <= CLAIM_TTL_MS) return false;
    saveCheck(state, { number: t.number, outcome: args.outcome as FixOutcome, status: 'committing', claim, claimedAt: now, at: now }, t.number);
    return true;
  },
  async effect({ state, deps, claim }, args) {
    const t = target(state, args.ticket);
    const check = t && checkOf(state, t.number);
    if (!t?.sysId || check?.status !== 'committing' || check.claim !== claim) return undefined;
    const ref = { number: t.number, sysId: t.sysId };
    const note = workNote(check.outcome, args.note);
    const saved = check.outcome === 'fixed' ? await deps.tickets.close(ref, note) : await deps.tickets.reopen(ref, note);
    return { notifyMode: deps.notifyMode, saved };
  },
  run({ state, now, effect, claim }, args) {
    const outcome = args.outcome as FixOutcome;
    const t = target(state, args.ticket);
    if (!t) return failed('Confirm fix: unknown ticket', 'unknown_ticket', args.ticket ? `I can't find ticket ${echo(args.ticket)} among your tickets.` : 'Which ticket is this about? Tell me its number.');
    if (!t.sysId) return failed(`Confirm fix: ${t.number} is local only`, 'not_synced', "That ticket only exists as a local copy, so there's nothing in ServiceNow to close or reopen.");
    const check = checkOf(state, t.number);
    if (check?.status === 'committing' && check.claim !== claim) return failed(`Confirm fix: ${t.number} in progress`, 'in_progress', "I'm saving that right now. Give it a moment.");
    if (check?.status === 'done' && check.outcome === outcome && !isResolved(t)) {
      return { title: `Already recorded for ${t.number}`, result: ok(`That's already recorded, nothing changed. ${check.say ?? ''}`.trim(), { number: t.number, alreadyDone: true }) };
    }
    if (check?.claim !== claim) return isResolved(t) ? failed('Confirm fix: try again', 'try_again', 'That did not go through. Please try again.') : notResolved(state, t, outcome);
    if (!effect || !effect.saved.ok) {
      saveCheck(state, null, t.number);
      return effect ? commitFailed(t, outcome, effect.saved) : failed('Confirm fix: try again', 'try_again', 'That did not go through. Please try again.');
    }
    const spoken = spokenTicket(t.number);
    settleFollowUp(state, t.number);
    if (outcome === 'fixed') {
      Object.assign(t, { state: 'Closed', updatedAt: now });
      delete t.syncFailed;
      const say = `Great, thanks for confirming. I've closed ${spoken} in ServiceNow. Anything else I can help with?`;
      saveCheck(state, { number: t.number, outcome, status: 'done', at: now, say }, t.number);
      return { title: `Closed ${t.number} · caller confirmed the fix`, result: ok(say, { number: t.number, outcome }) };
    }
    Object.assign(t, { state: 'In Progress', urgency: 1, updatedAt: now });
    delete t.syncFailed;
    // A later resolution of the reopened ticket rings again.
    if (state.followUpLog) state.followUpLog.rung = state.followUpLog.rung.filter((n) => n !== t.number);
    const e = state.employee;
    const detail = `Reopened at high urgency, caller says the fix did not work${args.note ? `: ${args.note}` : ''}`;
    const alert = ticketMilestone(state, now, { number: t.number, title: t.summary, person: e.name, device: e.device.id }, 'reopened', detail, `${t.number} reopened by ${e.name}: the fix did not work.${args.note ? ` ${args.note}` : ''}`);
    const say = `Sorry it's still not working. I've reopened ${spoken} at high urgency with what you told me. ${alertSay(effect.notifyMode)}`;
    saveCheck(state, { number: t.number, outcome, status: 'done', at: now, say }, t.number);
    return {
      title: `Reopened ${t.number} · fix did not work`,
      alerts: [alert],
      result: ok(say, { number: t.number, outcome }, 'Offer a guided fix while IT works on it, or ask if there is anything else.'),
    };
  },
});

const REMINDER_SET_NEXT = 'Do not offer another reminder on this call. Ask if there is anything else.';

const scheduleReminder = tool({
  name: 'scheduleReminder',
  description:
    "Set a reminder: at that time ASK IT rings Priya's page to check back, for example after a ticket is raised or a fix is done. Not a critical action, so no confirmation code: read the time back instead. India time, up to 7 days ahead, at most 5 waiting.",
  params: {
    when: { description: 'When, in her words: "in 2 minutes", "in 3 hours", "tomorrow at 10 am", "at 5 pm", "this evening" or "tomorrow morning"' },
    about: { description: 'What to check on, in a few words, or empty string for the ticket or current issue', allowEmpty: true },
    ticket: { description: 'Ticket number as said, or empty string for none', allowEmpty: true },
  },
  run({ state, now }, args) {
    const t = args.ticket ? findTicket(state, args.ticket) : undefined;
    if (args.ticket && !t) return failed('Reminder: unknown ticket', 'unknown_ticket', `I can't find ticket ${echo(args.ticket)} among your tickets. Which one should I check back about?`);
    const at = parseWhen(args.when, now);
    if (at === null) return failed(`Reminder: unclear time "${clip(args.when, 40)}"`, 'unclear_time', "I didn't catch when to check back. Should it be in an hour, tomorrow morning, or at a time like 5 PM?");
    if (at <= now) return failed('Reminder: time already passed', 'time_passed', 'That time has already passed. When should I check back instead?');
    if (at - now > MAX_AHEAD_MS) return failed('Reminder: more than a week ahead', 'too_far', 'I can only check back within the next seven days. When this week works for you?');
    // Rung reminders are kept a day, so the list stays short.
    const kept = (state.reminders ?? []).filter((r) => r.status === 'pending' || now - r.at < DAY);
    if (kept.filter((r) => r.status === 'pending').length >= MAX_PENDING_REMINDERS) {
      return failed('Reminder: too many waiting', 'too_many_reminders', `You already have ${MAX_PENDING_REMINDERS} reminders waiting, which is the most I can keep. I'll check back on those first.`);
    }
    const about = echo(args.about || t?.summary || state.troubleshooting?.issue || 'your IT issue', 100);
    const reminder = { id: nextId(state, 'RM'), at, about, ticket: t?.number ?? null, createdAt: now, status: 'pending' as const };
    state.reminders = [...kept, reminder];
    const what = t ? `${spokenTicket(t.number)}, ${about}` : about;
    return {
      title: `Reminder set for ${reminderLabel(at, now)}: ${about}`,
      result: ok(`I'll check back with you ${spokenWhen(at, now)} about ${what}.`, { id: reminder.id, at, ticket: reminder.ticket }, REMINDER_SET_NEXT),
    };
  },
});

export const FOLLOW_UP_TOOLS = [confirmFix, scheduleReminder];
