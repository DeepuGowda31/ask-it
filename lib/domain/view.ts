import type { Mode } from '@/lib/integrations/types';
import { findAsset } from './assets';
import { MAX_CODE_ATTEMPTS } from './company';
import { findArticle } from './kb';
import { searchKnowledge } from './search';
import { outageName } from './services';
import { isOpen } from './tickets';
import { verificationStatus } from './tools/identity';
import { ITDESK_TOOLS } from './tools/itdesk';
import type { LockdownStep, PendingAction, SessionEvent, SessionState, StepOutcome, TicketRecord } from './types';

export interface Integrations {
  tickets: Mode;
  identity: Mode;
  notify: Mode;
  status: 'live';
}

type StepState = 'done' | 'fixed' | 'failed' | 'skipped' | 'current' | 'todo';
const STEP_STATE: Record<StepOutcome, StepState> = { fixed: 'fixed', not_fixed: 'failed', done: 'done', skipped: 'skipped' };

function troubleshootingView(state: SessionState) {
  const t = state.troubleshooting;
  const article = t ? findArticle(t.articleId) : undefined;
  if (!t || !article) return null;
  const steps = article.steps.map((s, i) => {
    const logged = t.log.find((l) => l.step === i + 1);
    const stepState: StepState = logged ? STEP_STATE[logged.outcome] : t.status === 'active' && i === t.stepIndex ? 'current' : 'todo';
    return { number: i + 1, text: s.text, check: s.check, state: stepState, note: logged?.note ?? '' };
  });
  return { articleId: t.articleId, title: t.title, issue: t.issue, status: t.status, startedAt: t.startedAt, ticket: t.ticket ?? null, steps };
}

function verificationView(state: SessionState, now: number) {
  const v = state.verification;
  const status = verificationStatus(v, now);
  return {
    status,
    sentAt: v.sentAt,
    approvedAt: v.approvedAt,
    expiresAt: v.expiresAt,
    attemptsLeft: Math.max(0, MAX_CODE_ATTEMPTS - v.attempts),
    // Simulated mode stands in for the email inbox.
    simulatedInbox: status === 'pending' && v.simulatedCode ? { code: v.simulatedCode, sentAt: v.sentAt } : null,
  };
}

type LockdownStatus = 'ok' | 'failed' | 'pending';

// Each lockdown step, then the IT channel alert as delivered so far.
function assetView(state: SessionState) {
  const a = state.asset ? findAsset(state.asset.id) : undefined;
  const t = state.asset?.ticket;
  return a ? { id: a.id, name: a.name, location: a.location, ticket: t ? { number: t.number, summary: t.summary } : null } : null;
}

function lockdownView(state: SessionState) {
  const l = state.lockdown;
  if (!l) return null;
  const alert = state.notifications.find((n) => n.id === l.alertId);
  const alertStatus: LockdownStatus = alert?.status === 'failed' ? 'failed' : alert?.status === 'queued' ? 'pending' : 'ok';
  const steps = l.steps.map((s) => ({ step: s.step as LockdownStep | 'alert', status: (s.ok ? 'ok' : 'failed') as LockdownStatus }));
  return { at: l.at, incident: l.incident, steps: [...steps, { step: 'alert' as const, status: alertStatus }] };
}

// The last laptop check; the browser runs it while it is requested. Raw readings stay on the server.
function diagnosticsView(state: SessionState) {
  const d = state.diagnostics;
  if (!d) return null;
  const findings = (d.findings ?? []).map(({ key, group, severity, say }) => ({ key, group, severity, say }));
  return { id: d.id, focus: d.focus, status: d.status, requestedAt: d.requestedAt, findings };
}

function kpis(state: SessionState) {
  const m = state.metrics;
  const handled = m.resolvedByAgent + m.duplicatesAvoided;
  const total = handled + m.ticketsRaised;
  return { ...m, toolCalls: state.events.filter((e) => e.kind === 'tool').length, deflectionRate: total ? handled / total : null };
}

type IssueStatus = 'open' | 'fixed' | 'ticket' | 'closed' | 'outage';
interface IssueSignal {
  topic: string;
  status: IssueStatus;
  at: number;
}

const RESOLVED_PREFIX = 'Resolved by ASK IT: ';
const ACCOUNT_ARTICLE = { unlock: 'password', resetPassword: 'password', resetMfa: 'mfa-new-phone' } as const;

const articleTitle = (id: string) => findArticle(id)?.title ?? 'Other';

function ticketSignal(t: TicketRecord, linkedArticle: string | undefined): IssueSignal {
  const text = t.summary.replace(RESOLVED_PREFIX, '');
  const topic = linkedArticle ? articleTitle(linkedArticle) : searchKnowledge(text, 1)[0]?.title ?? 'Other';
  const status = isOpen(t) ? 'ticket' : t.summary.startsWith(RESOLVED_PREFIX) ? 'fixed' : 'closed';
  return { topic, status, at: t.updatedAt };
}

// What the employee needed help with, grouped by guide; status is the latest outcome per topic.
function topIssues(state: SessionState, limit = 5) {
  const fix = state.troubleshooting;
  const signals: IssueSignal[] = state.tickets.map((t) => ticketSignal(t, fix?.ticket === t.number ? fix.articleId : undefined));
  if (fix && !fix.ticket) {
    signals.push({ topic: articleTitle(fix.articleId), status: fix.status === 'fixed' ? 'fixed' : 'open', at: fix.log.at(-1)?.at ?? fix.startedAt });
  }
  for (const o of state.outages) if (o.followed) signals.push({ topic: outageName(o), status: 'outage', at: o.since ?? state.createdAt });
  for (const a of state.pending) {
    if (a.payload.kind === 'account' && a.status === 'done') signals.push({ topic: articleTitle(ACCOUNT_ARTICLE[a.payload.action]), status: 'fixed', at: a.createdAt });
  }
  const byTopic = new Map<string, IssueSignal & { count: number }>();
  for (const s of signals) {
    const seen = byTopic.get(s.topic);
    const latest = !seen || s.at >= seen.at ? s : seen;
    byTopic.set(s.topic, { ...latest, count: (seen?.count ?? 0) + 1 });
  }
  return [...byTopic.values()]
    .sort((a, b) => b.count - a.count || b.at - a.at)
    .slice(0, limit);
}

const DESK_TOOLS = new Set(ITDESK_TOOLS.map((t) => t.name));

const ticketRow = ({ sysId: _sysId, ...t }: TicketRecord, open: boolean) => ({ ...t, open });

// Read model for both screens: newest first, nothing secret beyond the simulated inbox.
export function buildSessionView(state: SessionState, now: number, version: number, integrations: Integrations) {
  // IT desk confirmations have their own read model; the employee screen never shows them.
  const pending = [...state.pending].reverse().find((a) => a.status === 'pending' && a.expiresAt > now && a.payload.kind !== 'incident');
  const { userId: _userId, ...account } = state.account;
  return {
    version,
    session: { id: state.id, createdAt: state.createdAt },
    call: state.call,
    employee: state.employee,
    account,
    verification: verificationView(state, now),
    troubleshooting: troubleshootingView(state),
    lockdown: lockdownView(state),
    diagnostics: diagnosticsView(state),
    // The page decides with its own clock whether this rings, so a snooze ends without a write.
    followUp: state.followUp ?? null,
    reminders: (state.reminders ?? []).filter((r) => r.status === 'pending').sort((a, b) => a.at - b.at).map(({ id, at, about, ticket }) => ({ id, at, about, ticket })),
    asset: assetView(state),
    tickets: state.tickets.map((t) => ticketRow(t, isOpen(t))),
    outages: state.outages,
    pending: pending ? { code: pending.code, kind: pending.payload.kind, summary: pending.summary, warnings: pending.warnings, expiresAt: pending.expiresAt } : null,
    documents: [...state.documents].reverse(),
    notifications: [...state.notifications].reverse(),
    events: [...state.events]
      .reverse()
      .slice(0, 100)
      .map((e) => {
        const action = e.actionCode ? state.pending.find((a) => a.code === e.actionCode) : undefined;
        const desk = (e.tool && DESK_TOOLS.has(e.tool)) || action?.payload.kind === 'incident';
        return { ...e, persona: desk ? ('itdesk' as const) : ('employee' as const), action: action ? { status: action.status, expiresAt: action.expiresAt } : null };
      }),
    kpis: kpis(state),
    topIssues: topIssues(state),
    integrations,
  };
}

export type SessionView = ReturnType<typeof buildSessionView>;

type EventStatus = 'ok' | 'neutral' | 'failed' | 'pending' | 'confirmed' | 'cancelled' | 'expired';
const PREFIX = { pending: 'Waiting for yes', confirmed: 'Confirmed', cancelled: 'Cancelled', expired: 'Expired' };

// How an activity row looks now: prepare steps follow their action (waiting, confirmed, cancelled, expired).
export function displayEvent(e: Pick<SessionEvent, 'ok' | 'title' | 'tool'> & { action: { status: PendingAction['status']; expiresAt: number } | null }, now: number): { status: EventStatus; title: string } {
  if (!e.ok) return { status: 'failed', title: e.title };
  // A discard changed nothing, so it is neither a success nor a failure.
  if (e.tool === 'cancelAction') return { status: 'neutral', title: e.title };
  if (!e.action) return { status: 'ok', title: e.title };
  const s = e.action.status;
  const status = s === 'done' ? 'confirmed' : s === 'cancelled' ? 'cancelled' : s === 'pending' && now > e.action.expiresAt ? 'expired' : 'pending';
  return { status, title: `${PREFIX[status]}: ${e.title}` };
}
