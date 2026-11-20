import { describeFailure, failure, success, type Result } from '@/lib/integrations/http';
import type { AccountAction, AccountInfo, DeskIncident, Mode, NewTicket } from '@/lib/integrations/types';
import { CLAIM_TTL_MS, findAction, nextId } from '../actions';
import { issueMilestone, ticketMilestone } from '../cards';
import { HOLD_WORD } from './itdesk';
import { deviceLabel } from '../company';
import { mergeTickets } from '../followup';
import { addTicket, clip, nextSimNumber, spokenTicket } from '../tickets';
import { outageName } from '../services';
import type { ActionPayload, Lockdown, LockdownStep, PendingAction, Persona, SessionState } from '../types';
import { currentUser, identityFailure, lockdownTitle, verificationBlock } from './identity';
import { alertSay, fail, failed, ok, tool, type Deps, type Outcome } from './shared';

type Created = Result<{ number: string; sysId: string }>;
type AccountStep = Exclude<LockdownStep, 'incident'>;
type LockdownPayload = Extract<ActionPayload, { kind: 'lockdown' }>;
type NotePayload = Extract<ActionPayload, { kind: 'note' }>;
type ResolutionPayload = Extract<ActionPayload, { kind: 'resolution' }>;

type CommitEffect =
  | { kind: 'ticket'; mode: Mode; notifyMode: Mode; created: Created }
  | { kind: 'escalation'; notifyMode: Mode; escalated: Result<null> }
  | { kind: 'account'; mode: Mode; done: Result<unknown>; notLocked?: true }
  | { kind: 'incident'; mode: Mode; notifyMode: Mode; updated: Result<DeskIncident> }
  | { kind: 'lockdown'; mode: Mode; notifyMode: Mode; account: Record<AccountStep, Result<null>>; created: Created }
  | { kind: 'note'; added: Result<null> }
  // No `added` when the outage was gone or already followed, so nothing was sent.
  | { kind: 'outage'; added?: Result<null> }
  | { kind: 'resolution'; mode: Mode; created?: Created; resolved?: Result<null> };

const URGENCY_WORD = { 1: 'high', 2: 'medium', 3: 'low' } as const;
const RETRY_NEXT = 'If Priya says yes, call confirmAction again with the same code.';
const REMINDER_NEXT = 'If you have not offered a reminder on this call yet, offer one; if she wants it, call scheduleReminder.';

function blocker(state: SessionState, action: PendingAction, now: number) {
  if (now > action.expiresAt) return { error: 'action_expired', say: 'That confirmation expired after 5 minutes, so nothing was done. Shall I prepare it again?' };
  return action.payload.kind === 'account' ? verificationBlock(state, now) : null;
}


const correlationId = (state: SessionState, action: PendingAction) => `askit:${state.id}:${action.code}`;

const unknownOutcome = (r: Result<unknown>) => !r.ok && (r.error.kind === 'timeout' || r.error.kind === 'network');

// A retry first looks for the ticket an earlier, unanswered attempt may have created.
async function createTicket(action: PendingAction, ticket: NewTicket, deps: Deps): Promise<Created> {
  if (action.tries) {
    const found = await deps.tickets.find(ticket.correlationId);
    if (!found.ok) return failure(found.error);
    if (found.value) return success(found.value);
  }
  return deps.tickets.create(ticket);
}

const STEP_LABEL: Record<LockdownStep, string> = { block: 'block account', sessions: 'end sessions', refreshTokens: 'revoke refresh tokens', mfa: 'reset MFA', incident: 'P1 incident' };
const ACCOUNT_STEPS: AccountStep[] = ['block', 'sessions', 'refreshTokens', 'mfa'];

function lockdownDescription(state: SessionState, p: LockdownPayload, account: Record<AccountStep, Result<null>>) {
  const e = state.employee;
  const results = ACCOUNT_STEPS.map((s) => `${STEP_LABEL[s]}: ${account[s].ok ? 'done' : `failed, ${describeFailure('Auth0', account[s].error)}`}`);
  return [
    `${e.name} (${e.email}) reported a lost or stolen device to the ASK IT voice helpdesk: ${p.what}`,
    p.when ? `When: ${p.when}` : '',
    `Device: ${deviceLabel(e)}.`,
    `Auth0 lockdown, confirmed by voice: ${results.join('; ')}.`,
  ].filter(Boolean).join('\n');
}

// Auth0 gets this long, so the P1 incident still has time inside the effect budget.
const AUTH0_BUDGET_MS = 4500;

// Every step runs, in order, even after an earlier one failed; steps Auth0 did not finish in its budget count as timed out.
async function lockdownEffect(state: SessionState, action: PendingAction, p: LockdownPayload, deps: Deps): Promise<CommitEffect> {
  const { identity } = deps;
  const calls: Record<AccountStep, (u: AccountInfo) => Promise<Result<null>>> = {
    block: (u) => identity.block(u.userId),
    sessions: (u) => identity.endSessions(u.userId),
    refreshTokens: (u) => identity.revokeRefreshTokens(u.userId),
    mfa: (u) => identity.lifecycle({ userId: u.userId, email: u.email }, 'resetMfa'),
  };
  const results: Partial<Record<AccountStep, Result<null>>> = {};
  let open = true;
  const steps = (async () => {
    const user = await currentUser(state, identity);
    for (const s of ACCOUNT_STEPS) {
      if (!open) return;
      const r = user.ok ? await calls[s](user.value) : user;
      if (open) results[s] = r;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([steps, new Promise((r) => (timer = setTimeout(r, AUTH0_BUDGET_MS)))]);
  clearTimeout(timer);
  open = false;
  const account = Object.fromEntries(ACCOUNT_STEPS.map((s) => [s, results[s] ?? failure<null>({ kind: 'timeout' })])) as Record<AccountStep, Result<null>>;
  const ticket = { shortDescription: lockdownTitle(p.what), description: lockdownDescription(state, p, account), urgency: 1, impact: 1, category: 'hardware', correlationId: correlationId(state, action) } as const;
  return { kind: 'lockdown', mode: deps.tickets.mode, notifyMode: deps.notifyMode, account, created: await deps.tickets.create(ticket) };
}

// Logs the fix as a resolved incident, unless the same fix was logged meanwhile.
async function resolutionEffect(state: SessionState, action: PendingAction, p: ResolutionPayload, deps: Deps): Promise<CommitEffect> {
  const mode = deps.tickets.mode;
  if (state.lastResolution?.key === p.key) return { kind: 'resolution', mode };
  const created = await deps.tickets.create({ ...p.ticket, correlationId: correlationId(state, action) });
  if (!created.ok) return { kind: 'resolution', mode, created };
  const resolved = await deps.tickets.resolve({ ...created.value }, `Resolved with the employee by the ASK IT voice helpdesk: ${p.summary}`);
  return { kind: 'resolution', mode, created, resolved };
}

async function commitEffect(state: SessionState, action: PendingAction, deps: Deps): Promise<CommitEffect> {
  const payload = action.payload;
  if (payload.kind === 'lockdown') return lockdownEffect(state, action, payload, deps);
  if (payload.kind === 'resolution') return resolutionEffect(state, action, payload, deps);
  if (payload.kind === 'note') return { kind: 'note', added: await deps.tickets.addNote({ number: payload.number, sysId: payload.sysId }, payload.text) };
  if (payload.kind === 'outage') {
    const outage = state.outages.find((o) => o.incident === payload.incident);
    if (!outage || outage.followed) return { kind: 'outage' };
    const e = state.employee;
    return { kind: 'outage', added: await deps.tickets.addNote({ number: outage.incident, sysId: null }, `Also affected: ${e.name} (${e.email}, ${deviceLabel(e)}). Reported through ASK IT; no duplicate ticket raised.`) };
  }
  if (payload.kind === 'ticket') {
    const created = await createTicket(action, { ...payload.ticket, correlationId: correlationId(state, action) }, deps);
    return { kind: 'ticket', mode: deps.tickets.mode, notifyMode: deps.notifyMode, created };
  }
  if (payload.kind === 'incident') {
    return { kind: 'incident', mode: deps.desk.mode, notifyMode: deps.notifyMode, updated: await deps.desk.update(payload.sysId, payload.fields) };
  }
  if (payload.kind === 'escalation') {
    const escalated = await deps.tickets.escalate({ number: payload.number, sysId: payload.sysId }, payload.reason);
    return { kind: 'escalation', notifyMode: deps.notifyMode, escalated };
  }
  if (payload.action === 'unlock' && state.account.locked === false) return { kind: 'account', mode: deps.identity.mode, done: { ok: true, value: null }, notLocked: true };
  const user = await currentUser(state, deps.identity);
  if (!user.ok) return { kind: 'account', mode: deps.identity.mode, done: user };
  const done = await deps.identity.lifecycle({ userId: user.value.userId, email: user.value.email }, payload.action);
  return { kind: 'account', mode: deps.identity.mode, done };
}

// Back to pending with the same code and expiry, so "yes" again retries.
function retryLater(action: PendingAction) {
  release(action);
  action.tries = (action.tries ?? 0) + 1;
}

// Two simulated creates from the same snapshot pick the same number; the later one moves up.
function placed(state: SessionState, mode: Mode, created: { number: string; sysId: string }) {
  if (mode !== 'simulated' || !state.tickets.some((x) => x.number === created.number)) return created;
  const number = nextSimNumber(state);
  return { number, sysId: `sim-${number}` };
}

function commitTicket(state: SessionState, action: PendingAction, t: Omit<NewTicket, 'correlationId'>, effect: Extract<CommitEffect, { kind: 'ticket' }>, now: number): Outcome {
  const base = { summary: t.shortDescription, urgency: t.urgency, source: effect.mode, createdAt: now, updatedAt: now, raisedHere: true };
  if (!effect.created.ok) {
    retryLater(action);
    if (!action.localRef) {
      action.localRef = nextId(state, 'LOCAL');
      addTicket(state, { ...base, number: action.localRef, sysId: null, state: 'Not submitted', syncFailed: true });
    }
    if (unknownOutcome(effect.created)) {
      const say = "I'm not sure it went through, because ServiceNow did not answer in time. I'll check for it before trying again, so it won't be raised twice. Shall I try again?";
      return failed('Ticket outcome unknown · will check before retrying', 'ticket_unconfirmed', say, undefined, `${RETRY_NEXT} It looks for the ticket first.`);
    }
    const say = `I couldn't create the ticket in ServiceNow: ${describeFailure('ServiceNow', effect.created.error)} I've kept a local copy with everything we tried. Shall I try again?`;
    return failed('Ticket not created in ServiceNow · kept locally', 'ticket_not_synced', say, undefined, RETRY_NEXT);
  }
  const { number, sysId } = placed(state, effect.mode, effect.created.value);
  if (action.localRef) state.tickets = state.tickets.filter((x) => x.number !== action.localRef);
  addTicket(state, { ...base, number, sysId, state: 'New' });
  // The next report about the scanned device joins this ticket.
  if (state.asset) state.asset.ticket = { number, sysId, summary: t.shortDescription };
  const fix = state.troubleshooting;
  if (fix && fix.status !== 'resolved') {
    fix.status = 'ticketed';
    fix.ticket = number;
  }
  const e = state.employee;
  const text = `New IT ticket ${number} from ${e.name} (${e.device.id}), ${URGENCY_WORD[t.urgency]} urgency: ${t.shortDescription}`;
  const alert = issueMilestone(state, now, 'ticket_raised', `Raised as ${number}, ${URGENCY_WORD[t.urgency]} urgency`, { title: t.shortDescription, ticket: number, text, kind: 'ticketRaised' });
  return {
    title: `Ticket ${number} raised · ${t.shortDescription}`,
    minutesSaved: 10,
    metrics: { ticketsRaised: 1 },
    alerts: [alert],
    result: ok(`Ticket raised: ${spokenTicket(number)}. ${alertSay(effect.notifyMode)} Everything we tried is on the ticket.`, { number }, REMINDER_NEXT),
  };
}

function commitEscalation(state: SessionState, action: PendingAction, number: string, reason: string, effect: Extract<CommitEffect, { kind: 'escalation' }>, now: number): Outcome {
  const ticket = state.tickets.find((t) => t.number === number);
  // Only a confirmed escalation is recorded, so a retry is still possible.
  if (!effect.escalated.ok) {
    if (ticket) ticket.syncFailed = true;
    retryLater(action);
    const say = `I couldn't escalate it in ServiceNow: ${describeFailure('ServiceNow', effect.escalated.error)} Nothing changed yet. Shall I try again?`;
    return failed(`Escalation of ${number} not saved in ServiceNow`, 'escalation_not_synced', say, undefined, RETRY_NEXT);
  }
  if (ticket) {
    Object.assign(ticket, { urgency: 1, escalated: true, updatedAt: now });
    delete ticket.syncFailed;
  }
  const e = state.employee;
  const text = `${number} escalated to high urgency by ${e.name}: ${reason}`;
  const card = { number, title: ticket?.summary ?? number, person: e.name, device: e.device.id };
  const alert = ticketMilestone(state, now, card, 'escalated', `Escalated to high urgency: ${reason}`, text, 'ticketEscalated');
  return { title: `Escalated ${number} to high urgency`, minutesSaved: 5, alerts: [alert], result: ok(`Escalated ${spokenTicket(number)} to high urgency. ${alertSay(effect.notifyMode)}`, { number }) };
}

// The card status an IT desk update moves the incident to.
function incidentMilestone(state: SessionState, now: number, p: Extract<ActionPayload, { kind: 'incident' }>, fresh: DeskIncident) {
  const f = p.fields;
  const card = { number: fresh.number, title: fresh.summary, person: fresh.caller ?? 'Unknown caller' };
  if (f.state === '6') return ticketMilestone(state, now, card, 'resolved_by_it', `Resolved: ${f.close_notes}`, p.alert);
  if (f.state === '3') return ticketMilestone(state, now, card, 'on_hold', `On hold: ${HOLD_WORD[f.hold_reason] ?? 'on hold'}`, p.alert);
  if ('assigned_to' in f || 'assignment_group' in f) {
    const who = [fresh.assignee?.name ?? 'nobody', fresh.group?.name].filter(Boolean).join(', ');
    return ticketMilestone(state, now, card, 'assigned', `Assigned to ${who}`, p.alert);
  }
  return ticketMilestone(state, now, card, 'in_progress', `Updated: ${p.changes.join(', ')}`);
}

// Saved: refresh the list, the open incident and, in simulated mode, the table itself.
function commitIncident(state: SessionState, action: PendingAction, p: Extract<ActionPayload, { kind: 'incident' }>, effect: Extract<CommitEffect, { kind: 'incident' }>, now: number): Outcome {
  if (!effect.updated.ok) {
    retryLater(action);
    if (unknownOutcome(effect.updated)) {
      return failed(`Update of ${p.number} unconfirmed`, 'incident_unconfirmed', "I'm not sure it saved, because ServiceNow did not answer in time. Saving again is safe. Shall I try again?", undefined, RETRY_NEXT);
    }
    const say = `I couldn't save the update in ServiceNow: ${describeFailure('ServiceNow', effect.updated.error)} Nothing changed yet. Shall I try again?`;
    return failed(`Update of ${p.number} not saved`, 'incident_not_saved', say, undefined, RETRY_NEXT);
  }
  const fresh = effect.updated.value;
  const desk = state.itdesk;
  const note = p.fields.work_notes ? [{ at: now, author: 'IT desk', text: p.fields.work_notes }] : [];
  desk.queue = desk.queue.map((i) => (i.number === fresh.number ? fresh : i));
  if (desk.current?.number === fresh.number) desk.current = { ...fresh, notes: [...note, ...desk.current.notes] };
  if (effect.mode === 'simulated') desk.backlog = desk.backlog.map((i) => (i.number === fresh.number ? { ...fresh, notes: [...note, ...i.notes] } : i));
  desk.lastUpdate = { number: fresh.number, changes: p.changes, at: now };
  // Her own ticket changed on the IT desk: the mirror follows, and a resolution rings her page.
  if (state.tickets.some((t) => t.number === fresh.number)) {
    mergeTickets(state, [{ number: fresh.number, sysId: fresh.sysId, summary: fresh.summary, state: fresh.stateLabel, urgency: fresh.urgency, createdAt: null, updatedAt: null }], effect.mode, now);
  }
  const alerts = [incidentMilestone(state, now, p, fresh)];
  const owner = fresh.assignee ? `, assigned to ${fresh.assignee.name}${fresh.group ? ` in ${fresh.group.name}` : ''}` : fresh.group ? `, with ${fresh.group.name}` : '';
  const alertText = p.alert ? ` ${alertSay(effect.notifyMode)}` : '';
  const priority = 'urgency' in p.fields || 'impact' in p.fields ? `, ${fresh.priorityLabel.toLowerCase()} priority` : '';
  return {
    title: `Updated ${fresh.number} by voice: ${p.changes.join(', ')}`,
    minutesSaved: 4,
    metrics: { ticketsUpdatedByVoice: 1 },
    alerts,
    result: ok(`Saved. ${spokenTicket(fresh.number)} is now ${fresh.stateLabel.toLowerCase()}${priority}${owner}.${alertText}`, { number: fresh.number }),
  };
}

const ACCOUNT_CARD = { unlock: 'Account unlocked', resetPassword: 'Password reset link sent', resetMfa: 'MFA reset' };
const SIGN_IN_NEXT = 'Ask whether Priya can sign in now. If yes, call markResolved; if not, keep troubleshooting.';

const ACCOUNT_DONE = {
  unlock: () => 'Your account is unlocked. Try signing in now, and tell me if it works.',
  resetPassword: () => 'A password reset link is on its way to your work email. Open it, set a new password, then sign in again.',
  resetMfa: () => "Your multi-factor sign-in is reset. At your next sign-in you'll be asked to enrol the authenticator on your new phone.",
};

function commitAccount(state: SessionState, action: PendingAction, kind: AccountAction, effect: Extract<CommitEffect, { kind: 'account' }>, now: number): Outcome {
  if (effect.notLocked) {
    action.status = 'cancelled';
    return failed('Unlock not needed: account not locked', 'not_locked', "Your account isn't locked any more, so there's nothing to unlock.");
  }
  if (!effect.done.ok) {
    release(action);
    const out = identityFailure(`Account action failed: ${action.summary}`, effect.done.error, 'finish that');
    if (out.result.error === 'identity_unavailable') out.result.say = `Auth0 didn't complete that: ${describeFailure('Auth0', effect.done.error)} Nothing changed. I can try again, or raise a ticket for IT.`;
    return out;
  }
  if (kind === 'unlock') state.account.locked = false;
  if (kind === 'resetMfa') state.account.factors = [];
  const alert = issueMilestone(state, now, 'waiting_employee', `${ACCOUNT_CARD[kind]}; waiting for the employee to sign in`, { title: 'Account access' });
  return { title: `Done: ${action.summary}`, minutesSaved: 15, metrics: { accountActions: 1 }, alerts: [alert], result: ok(ACCOUNT_DONE[kind](), { action: kind }, SIGN_IN_NEXT) };
}

const DONE_SAY: Record<AccountStep, string> = { block: 'your account is blocked', sessions: "you're signed out everywhere", refreshTokens: 'saved sign-ins are revoked', mfa: 'your multi-factor sign-in is reset' };
const FAILED_SAY: Record<LockdownStep, string> = { block: 'blocking your account', sessions: 'signing you out everywhere', refreshTokens: 'revoking saved sign-ins', mfa: 'resetting your multi-factor sign-in', incident: 'raising the security incident' };
const LOCKDOWN_NEXT = 'Ask whether anything else is at risk. Unlocking later needs verifyIdentity first.';
const LOCKDOWN_FAILED_NEXT = 'IT security finishes the failed steps by hand. Do not prepare another lockdown.';

const listed = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? ''));

function incidentReason(created: Created) {
  if (created.ok) return undefined;
  const why = describeFailure('ServiceNow', created.error);
  return unknownOutcome(created) ? `${why.slice(0, -1)}, so the incident may still have been raised.` : why;
}

function lockdownSay(lockdown: Lockdown, notifyMode: Mode) {
  const failedSteps = lockdown.steps.filter((s) => !s.ok);
  const done = lockdown.steps.filter((s) => s.ok).map((s) => (s.step === 'incident' ? `I raised urgent security incident ${spokenTicket(lockdown.incident!)}` : DONE_SAY[s.step]));
  if (!failedSteps.length) {
    const account = listed(done.slice(0, -1));
    return `Done. ${account.charAt(0).toUpperCase()}${account.slice(1)}. ${done.at(-1)}. ${alertSay(notifyMode)} Getting back in later needs the usual email verification.`;
  }
  const what = listed(failedSteps.map((s) => FAILED_SAY[s.step]));
  const head = done.length ? `Done: ${listed(done)}. ${failedSteps.length === 1 ? 'This' : 'These'} did not work: ${what}.` : `None of the lockdown steps went through: ${what}.`;
  const reasons = [...new Set(failedSteps.map((s) => s.reason))].join(' ');
  return `${head} ${reasons} ${alertSay(notifyMode)} IT security will finish ${failedSteps.length === 1 ? 'that' : 'those'} by hand.`;
}

// Records each step, locks the local mirror for what worked and alerts IT security once.
function commitLockdown(state: SessionState, p: LockdownPayload, effect: Extract<CommitEffect, { kind: 'lockdown' }>, now: number): Outcome {
  const { account, created } = effect;
  if (account.block.ok) state.account.locked = true;
  if (account.mfa.ok) state.account.factors = [];
  // A verification from before the lockdown must not unlock it.
  state.verification = { status: 'none', sentAt: null, approvedAt: null, expiresAt: null, attempts: 0, checking: [], simulatedCode: null };
  const title = lockdownTitle(p.what);
  const incident = created.ok ? placed(state, effect.mode, created.value) : null;
  if (incident) addTicket(state, { ...incident, summary: title, state: 'New', urgency: 1, source: effect.mode, createdAt: now, updatedAt: now, raisedHere: true });
  const steps: Lockdown['steps'] = [
    ...ACCOUNT_STEPS.map((step) => {
      const r = account[step];
      return r.ok ? { step, ok: true } : { step, ok: false, reason: describeFailure('Auth0', r.error) };
    }),
    created.ok ? { step: 'incident', ok: true } : { step: 'incident', ok: false, reason: incidentReason(created) },
  ];
  const failedLabels = steps.filter((s) => !s.ok).map((s) => STEP_LABEL[s.step]);
  const doneLabels = steps.filter((s) => s.ok && s.step !== 'incident').map((s) => STEP_LABEL[s.step]);
  const e = state.employee;
  const outcome = failedLabels.length ? `${doneLabels.length ? `Done: ${doneLabels.join(', ')}. ` : ''}Failed: ${failedLabels.join(', ')}. Finish by hand.` : `All steps done: ${doneLabels.join(', ')}.`;
  const text = `Security lockdown for ${e.name} (${e.device.id}): ${clip(p.what, 100)}. ${incident ? `P1 incident ${incident.number}.` : 'P1 incident not created.'} ${outcome}`;
  const detail = failedLabels.length ? `Lockdown confirmed by voice; failed: ${failedLabels.join(', ')}` : 'Lockdown confirmed by voice; all steps done';
  const alert = issueMilestone(state, now, 'escalated', detail, { title, fresh: true, ticket: incident?.number, text, kind: 'ticketEscalated' });
  const lockdown: Lockdown = { at: now, steps, incident: incident?.number ?? null, alertId: alert.id };
  state.lockdown = lockdown;
  const say = lockdownSay(lockdown, effect.notifyMode);
  const data = { incident: lockdown.incident, failed: steps.filter((s) => !s.ok).map((s) => s.step) };
  const base = { alerts: [alert], minutesSaved: 20, metrics: { accountActions: 1, ...(incident ? { ticketsRaised: 1 } : {}) } };
  if (!failedLabels.length) return { ...base, title: `Locked down · ${incident!.number} raised`, result: ok(say, data, LOCKDOWN_NEXT) };
  const error = failedLabels.length === steps.length ? 'lockdown_failed' : 'lockdown_incomplete';
  return { ...base, title: `Lockdown: ${steps.length - failedLabels.length} of ${steps.length} steps done`, result: { ...fail(error, say, undefined, LOCKDOWN_FAILED_NEXT), data } };
}

function commitNote(state: SessionState, action: PendingAction, p: NotePayload, effect: Extract<CommitEffect, { kind: 'note' }>, now: number): Outcome {
  const spoken = spokenTicket(p.number);
  if (!effect.added.ok) {
    if (effect.added.error.kind === 'not_found') {
      action.status = 'cancelled';
      return failed(`Note: ${p.number} not in ServiceNow`, 'unknown_ticket', `ServiceNow has no ticket ${spoken}.`);
    }
    retryLater(action);
    return failed(`Note not added to ${p.number}`, 'note_not_synced', `I couldn't add the note in ServiceNow: ${describeFailure('ServiceNow', effect.added.error)} Shall I try again?`, undefined, RETRY_NEXT);
  }
  if (p.shared) {
    const say = `Added your report to ${spoken}, the ticket already open for this device. IT will see it there, so there's no duplicate.`;
    return { title: `Report added to ${p.number} · duplicate avoided`, minutesSaved: 3, metrics: { duplicatesAvoided: 1 }, result: ok(say, { number: p.number }) };
  }
  const t = state.tickets.find((x) => x.number === p.number);
  if (t) t.updatedAt = now;
  return { title: `Note added to ${p.number}`, minutesSaved: 3, result: ok(`Added your note to ${spoken}. IT will see it on the ticket.`, { number: p.number }) };
}

function commitOutage(state: SessionState, action: PendingAction, incident: string, effect: Extract<CommitEffect, { kind: 'outage' }>, now: number): Outcome {
  const outage = state.outages.find((o) => o.incident === incident);
  const spoken = spokenTicket(incident);
  if (!outage) {
    action.status = 'cancelled';
    return failed(`Follow ${incident}: outage over`, 'unknown_outage', "That outage isn't active any more, so there's nothing to join.");
  }
  if (outage.followed) return { title: `Already following ${incident}`, result: ok(`You're already on ${spoken}, so you'll get an update when it's fixed.`, { alreadyFollowing: true }) };
  if (!effect.added) {
    release(action);
    return retry();
  }
  // Only a confirmed follow counts, so saying yes again after a failure still works.
  if (!effect.added.ok) {
    outage.syncFailed = true;
    retryLater(action);
    const say = `I couldn't add you in ServiceNow: ${describeFailure('ServiceNow', effect.added.error)} IT already tracks this outage, so no duplicate ticket is needed. Shall I try again?`;
    return failed(`Follow ${incident} not saved in ServiceNow`, 'follow_not_synced', say, undefined, RETRY_NEXT);
  }
  outage.followed = true;
  if (outage.affected !== null) outage.affected += 1;
  delete outage.syncFailed;
  const say = `Done. You're added to ${spoken} as affected, so you'll get updates when ${outageName(outage)} is fixed, and no duplicate ticket is needed.`;
  const alert = issueMilestone(state, now, 'opened', `Linked to known outage ${incident}`, { title: `Affected by ${outage.title}`, fresh: true });
  return { title: `Following ${incident} · duplicate ticket avoided`, minutesSaved: 10, metrics: { duplicatesAvoided: 1 }, alerts: [alert], result: ok(say, { incident, affected: outage.affected }) };
}

function resolvedSay(spoken: string, created: Result<unknown>, resolved: Result<null> | undefined): string {
  if (unknownOutcome(created)) return "Glad it's fixed. I'm not sure ServiceNow logged it, because it did not answer in time, so I've kept a local record too.";
  if (!created.ok) return `Glad it's fixed. I couldn't log it in ServiceNow: ${describeFailure('ServiceNow', created.error)} I've kept a local record instead.`;
  if (resolved && !resolved.ok) return `Glad it's fixed. I logged it as ${spoken}, but couldn't close it in ServiceNow: ${describeFailure('ServiceNow', resolved.error)}`;
  return `Logged as resolved by ASK IT, ${spoken}, so it counts as fixed without an IT ticket. Anything else I can help with?`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// A ServiceNow failure still counts as fixed on the call; the local record says it did not sync.
function commitResolution(state: SessionState, p: ResolutionPayload, effect: Extract<CommitEffect, { kind: 'resolution' }>, now: number): Outcome {
  const last = state.lastResolution;
  const { mode, created, resolved } = effect;
  if (!created || last?.key === p.key) return { title: 'Already logged as resolved', result: ok("That's already logged as resolved, nothing changed.", { alreadyResolved: true, number: last?.number }) };
  const number = created.ok ? placed(state, mode, created.value).number : nextId(state, 'LOCAL');
  const closed = created.ok && resolved?.ok;
  addTicket(state, {
    number,
    sysId: created.ok ? created.value.sysId : null,
    summary: p.ticket.shortDescription,
    state: created.ok && !closed ? 'New' : 'Resolved',
    urgency: 3,
    source: mode,
    createdAt: now,
    updatedAt: now,
    raisedHere: true,
    ...(closed ? {} : { syncFailed: true }),
  });
  const t = state.troubleshooting;
  if (t && t.status !== 'ticketed') {
    t.status = 'resolved';
    t.ticket = number;
  }
  state.lastResolution = { key: p.key, status: 'done', number };
  const alert = issueMilestone(state, now, 'resolved_by_askit', p.summary, { title: p.summary, ticket: number });
  return {
    title: `Resolved by ASK IT · ${capital(p.summary)}`,
    minutesSaved: 20,
    metrics: { resolvedByAgent: 1 },
    alerts: [alert],
    result: ok(resolvedSay(spokenTicket(number), created, resolved), { number, synced: Boolean(closed) }, REMINDER_NEXT),
  };
}

function release(action: PendingAction) {
  action.status = 'pending';
  delete action.claim;
  delete action.claimedAt;
}

const retry = (): Outcome => failed('Confirm: try again', 'try_again', 'That did not go through. Please try again.');

function commit(state: SessionState, action: PendingAction, effect: CommitEffect, now: number): Outcome {
  const p = action.payload;
  if (effect.kind === 'ticket' && p.kind === 'ticket') return commitTicket(state, action, p.ticket, effect, now);
  if (effect.kind === 'escalation' && p.kind === 'escalation') return commitEscalation(state, action, p.number, p.reason, effect, now);
  if (effect.kind === 'account' && p.kind === 'account') return commitAccount(state, action, p.action, effect, now);
  if (effect.kind === 'incident' && p.kind === 'incident') return commitIncident(state, action, p, effect, now);
  if (effect.kind === 'lockdown' && p.kind === 'lockdown') return commitLockdown(state, p, effect, now);
  if (effect.kind === 'note' && p.kind === 'note') return commitNote(state, action, p, effect, now);
  if (effect.kind === 'outage' && p.kind === 'outage') return commitOutage(state, action, p.incident, effect, now);
  if (effect.kind === 'resolution' && p.kind === 'resolution') return commitResolution(state, p, effect, now);
  release(action);
  return retry();
}

// Incident updates belong to IT desk calls and everything else to employee calls; neither confirms the other's.
function ownAction(state: SessionState, code: string, persona: Persona | undefined) {
  const action = findAction(state, code);
  return action && (!persona || (action.payload.kind === 'incident') === (persona === 'itdesk')) ? action : undefined;
}

const claimable = (a: PendingAction, now: number) => a.status === 'pending' || (a.status === 'committing' && now - (a.claimedAt ?? 0) > CLAIM_TTL_MS);

const confirmAction = tool<CommitEffect>({
  name: 'confirmAction',
  description:
    'Commit a prepared ticket, escalation, ticket note, outage follow, resolution, account action, security lockdown or incident update by its confirmation code, only after a clear yes. Safe to retry: the same code never commits twice.',
  params: { code: { description: 'Confirmation code returned by the prepare step' } },
  personas: ['employee', 'itdesk'],
  begin(state, args, now, claim, persona) {
    const action = ownAction(state, args.code, persona);
    if (!action || !claimable(action, now) || blocker(state, action, now)) return false;
    Object.assign(action, { status: 'committing', claim, claimedAt: now });
    return true;
  },
  async effect({ state, deps, claim }, args) {
    const action = findAction(state, args.code);
    return action?.status === 'committing' && action.claim === claim ? commitEffect(state, action, deps) : undefined;
  },
  run({ state, now, effect, claim, persona }, args) {
    const action = ownAction(state, args.code, persona);
    if (!action) return failed('Unknown confirmation code', 'unknown_code', "I can't find that confirmation. Let me prepare it again.");
    if (action.status === 'done') return { title: `Already done: ${action.summary}`, result: ok(`That was already done, nothing changed. ${action.outcome ?? ''}`.trim(), { alreadyDone: true }) };
    if (action.status === 'cancelled') return failed(`Cancelled earlier: ${action.summary}`, 'action_cancelled', 'That action was cancelled. Shall I prepare it again?');
    if (action.status === 'pending') {
      const why = blocker(state, action, now);
      return why ? failed(`Not confirmed: ${action.summary}`, why.error, why.say) : retry();
    }
    if (action.claim !== claim) return failed(`In progress: ${action.summary}`, 'in_progress', "That's already being processed. Give it a moment.");
    if (!effect) {
      release(action);
      return retry();
    }
    const out = commit(state, action, effect, now);
    if (action.status === 'committing') {
      action.status = 'done';
      action.outcome = out.result.say;
      delete action.claim;
      delete action.claimedAt;
    }
    return out;
  },
});

const cancelAction = tool({
  name: 'cancelAction',
  description: 'Discard a prepared action when the caller says no or wants changes. Nothing is changed.',
  params: { code: { description: 'Confirmation code returned by the prepare step' } },
  personas: ['employee', 'itdesk'],
  run({ state, persona }, args) {
    const action = ownAction(state, args.code, persona);
    if (!action) return failed('Unknown confirmation code', 'unknown_code', "I can't find that confirmation.");
    if (action.status === 'done') return failed(`Too late to cancel: ${action.summary}`, 'already_done', "That was already done, so it can't be cancelled.");
    if (action.status === 'committing') return failed(`Too late to cancel: ${action.summary}`, 'in_progress', "That's being processed right now, so it can't be cancelled.");
    if (action.status === 'cancelled') return { title: `Already discarded: ${action.summary}`, result: ok("It's already discarded. Nothing was changed.", { cancelled: true }) };
    action.status = 'cancelled';
    return { title: `Discarded: ${action.summary}`, result: ok('Okay, discarded. Nothing was changed.', { cancelled: true }) };
  },
});

export const ACTION_TOOLS = [confirmAction, cancelAction];

