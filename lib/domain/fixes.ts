import { failure, success, type Result } from '@/lib/integrations/http';
import type { AccountAction, Mode, NewTicket } from '@/lib/integrations/types';
import { CLAIM_TTL_MS, nextId } from './actions';
import { DESK_GROUPS, PRIORITY_LABELS, STATE_LABELS } from './desk-seed';
import { findArticle } from './kb';
import { addTicket, fixCorrelationId, nextSimNumber, plainText, ticketDescription } from './tickets';
import type { Deps } from './tools/shared';
import type { AccountFix, SessionState } from './types';

// Fixes made on the call become one resolved ServiceNow incident each: on markResolved, at wrap up, or when the call ends.

type Created = Result<{ number: string; sysId: string }>;

export const ACTION_LABEL: Record<AccountAction, string> = { unlock: 'account unlocked', resetPassword: 'password reset link sent', resetMfa: 'MFA reset' };
// Short record titles for an account fix logged without markResolved.
const ACTION_TITLE: Record<AccountAction, string> = { unlock: 'Account unlocked', resetPassword: 'Password reset', resetMfa: 'MFA reset' };
// The guide each account action belongs to, for its topic and category.
export const ACCOUNT_ARTICLE = { unlock: 'password', resetPassword: 'password', resetMfa: 'mfa-new-phone' } as const;

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (s: string) => `${plainText(s).replace(/[.!?]+$/, '')}.`;
// The record title: the summary itself, plain and short.
const title = (summary: string) => capital(plainText(summary).replace(/[.!?]+$/, '')).slice(0, 160);
const listed = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? ''));

const claimable = (f: { claim?: string; claimedAt?: number }, now: number) => !f.claim || now - (f.claimedAt ?? 0) > CLAIM_TTL_MS;

// The account actions of this call not logged yet, if any.
export const openAccountFix = (state: SessionState) => (state.accountFix && state.accountFix.status !== 'logged' ? state.accountFix : null);

// After a successful unlock or reset: joins the open account fix, or starts a new one.
export function noteAccountAction(state: SessionState, action: AccountAction, now: number) {
  const open = state.accountFix?.status === 'open' ? state.accountFix : null;
  if (open) {
    if (!open.actions.includes(action)) open.actions.push(action);
    return;
  }
  state.accountFix = { actions: [action], at: now, status: 'open' };
}

// A markResolved commit owns the account fix it covers. False only while another commit or flush is logging it.
export function claimAccountFix(state: SessionState, at: number, claim: string, now: number): boolean {
  const f = state.accountFix;
  if (!f || f.at !== at || f.status === 'logged') return true;
  if (f.status === 'logging' && !claimable(f, now)) return false;
  Object.assign(f, { status: 'logging', claim, claimedAt: now });
  return true;
}

// The record of a fix: what the employee said fixed it, the steps that worked and any account action.
export function fixTicket(state: SessionState, summary: string, now: number, account: AccountFix | null): Omit<NewTicket, 'correlationId'> {
  // A guided fix already ticketed or logged is not part of this one.
  const t = state.troubleshooting && !['ticketed', 'resolved'].includes(state.troubleshooting.status) ? state.troubleshooting : null;
  const actions = (account?.actions ?? []).map((a) => capital(ACTION_LABEL[a]));
  const worked = [...(t?.log.filter((l) => l.outcome === 'fixed').map((l) => l.text.trim().replace(/[.!?]+$/, '')) ?? []), ...actions];
  const details = [sentence(summary), actions.length ? `Account action on the call was ${listed(actions).toLowerCase()}.` : ''].filter(Boolean).join(' ');
  const article = t ? findArticle(t.articleId) : account ? findArticle(ACCOUNT_ARTICLE[account.actions[0]]) : undefined;
  return {
    shortDescription: title(summary),
    description: ticketDescription(state, t, details, now),
    urgency: 3,
    impact: 3,
    category: article?.category ?? 'inquiry',
    resolution: { notes: ['Resolved on the call by ASK IT.', sentence(summary), worked.length ? `Steps that worked. ${worked.map(sentence).join(' ')}` : ''].filter(Boolean).join(' '), at: now },
  };
}

// Two simulated creates from the same snapshot pick the same number; the later one moves up.
export function placed(state: SessionState, mode: Mode, created: { number: string; sysId: string }) {
  if (mode !== 'simulated' || !state.tickets.some((x) => x.number === created.number)) return created;
  const number = nextSimNumber(state);
  return { number, sysId: `sim-${number}` };
}

// Adds the resolved record to the employee's tickets and, when simulated, to the IT desk table. A failed create stays local and is retried once.
export function recordFix(state: SessionState, now: number, mode: Mode, key: string, ticket: NewTicket, created: Created): string {
  const ref = created.ok ? placed(state, mode, created.value) : null;
  const number = ref?.number ?? nextId(state, 'LOCAL');
  addTicket(state, { number, sysId: ref?.sysId ?? null, summary: ticket.shortDescription, state: 'Resolved', urgency: 3, source: mode, createdAt: now, updatedAt: now, raisedHere: true, fixedOnCall: true, ...(ref ? {} : { syncFailed: true }) });
  if (!ref) state.unsyncedFix = { localRef: number, ticket };
  state.lastResolution = { key, status: 'done', number };
  if (ref && mode === 'simulated') {
    state.itdesk.backlog.push({
      number,
      sysId: ref.sysId,
      summary: ticket.shortDescription,
      priority: 5,
      priorityLabel: PRIORITY_LABELS[5],
      state: '6',
      stateLabel: STATE_LABELS['6'],
      holdReason: null,
      assignee: null,
      group: DESK_GROUPS.find((g) => g.name === 'Service Desk') ?? null,
      caller: state.employee.name,
      category: ticket.category,
      urgency: 3,
      impact: 3,
      openedAt: now,
      resolvedAt: now,
      notes: [],
    });
  }
  return number;
}

function addEvent(state: SessionState, now: number, ok: boolean, title: string) {
  state.seq += 1;
  state.events.push({ id: state.seq, at: now, kind: 'call', ok, title });
}

// Claims what wrap up or the end of the call still has to log: an open account fix and a record ServiceNow did not take.
export function claimFixes(state: SessionState, claim: string, now: number): boolean {
  let claimed = false;
  const account = openAccountFix(state);
  if (account && claimable(account, now)) {
    Object.assign(account, { status: 'logging', claim, claimedAt: now });
    claimed = true;
  }
  const retry = state.unsyncedFix;
  if (retry && claimable(retry, now)) {
    Object.assign(retry, { claim, claimedAt: now });
    claimed = true;
  }
  return claimed;
}

export interface FixesEffect {
  mode: Mode;
  account?: { ticket: NewTicket; created: Created };
  retry?: Created;
}

// The account fix's own record, when the call ends before markResolved.
function accountTicket(state: SessionState, f: AccountFix, now: number): NewTicket {
  const what = capital(listed(f.actions.map((a) => ACTION_LABEL[a])));
  const ticket = fixTicket({ ...state, troubleshooting: null }, what, now, f);
  const name = listed(f.actions.map((a, i) => (i ? ACTION_TITLE[a].toLowerCase() : ACTION_TITLE[a])));
  return { ...ticket, shortDescription: name, correlationId: fixCorrelationId(state.id, f.at), resolution: { notes: `Resolved on the call by ASK IT. ${what}. The call ended before sign-in was confirmed.`, at: now } };
}

// A retry looks for the record an unanswered attempt may have made before creating it again.
async function retryCreate(ticket: NewTicket, deps: Deps): Promise<Created> {
  const found = await deps.tickets.find(ticket.correlationId);
  if (!found.ok) return failure(found.error);
  return found.value ? success(found.value) : deps.tickets.create(ticket);
}

// Outbound: both records in parallel, only for what this claim owns.
export async function fixesEffect(state: SessionState, deps: Deps, claim: string, now: number): Promise<FixesEffect> {
  const account = state.accountFix?.status === 'logging' && state.accountFix.claim === claim ? state.accountFix : null;
  const retry = state.unsyncedFix?.claim === claim ? state.unsyncedFix : null;
  const ticket = account ? accountTicket(state, account, now) : null;
  const [a, r] = await Promise.all([ticket ? deps.tickets.create(ticket) : undefined, retry ? retryCreate(retry.ticket, deps) : undefined]);
  return { mode: deps.tickets.mode, ...(ticket && a ? { account: { ticket, created: a } } : {}), ...(r ? { retry: r } : {}) };
}

// Applies what the effect did, for the claims still held. Mutates; counts each new record as resolved by ASK IT.
export function applyFixes(state: SessionState, effect: FixesEffect, claim: string, now: number) {
  const retry = state.unsyncedFix;
  if (retry?.claim === claim && effect.retry) {
    state.unsyncedFix = null;
    if (effect.retry.ok) {
      const { number, sysId } = placed(state, effect.mode, effect.retry.value);
      const t = state.tickets.find((x) => x.number === retry.localRef);
      if (t) {
        Object.assign(t, { number, sysId, updatedAt: now });
        delete t.syncFailed;
      }
      if (state.lastResolution?.number === retry.localRef) state.lastResolution.number = number;
      if (state.troubleshooting?.ticket === retry.localRef) state.troubleshooting.ticket = number;
    } else {
      addEvent(state, now, false, `Fix record ${retry.localRef} not saved in ServiceNow, kept on this session`);
    }
  }
  const account = state.accountFix;
  if (account?.status === 'logging' && account.claim === claim && effect.account) {
    const { ticket, created } = effect.account;
    const number = recordFix(state, now, effect.mode, `account:${account.at}`, ticket, created);
    state.accountFix = { actions: account.actions, at: account.at, status: 'logged', number };
    state.metrics.resolvedByAgent += 1;
    addEvent(state, now, true, `Logged as resolved by ASK IT, ${ticket.shortDescription}, ${number}`);
  }
}
