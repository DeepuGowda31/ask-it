import { CHECK_GROUPS, type Severity } from '@/lib/domain/diagnose';
import type { SessionView } from '@/lib/domain/view';
import type { TicketInfo } from './ticket-lines';

type RightNow =
  | { kind: 'confirm'; summary: string; warnings: string[]; code: string; expiresAt: number }
  | { kind: 'verify'; email: string; attemptsLeft: number; simulatedCode: string | null }
  | { kind: 'fix'; title: string; step: number; total: number; done: number; text: string; check: string }
  | { kind: 'outcome'; tone: 'ok' | 'warn'; title: string; detail: string }
  | { kind: 'lockdown'; incident: string | null; failed: number; steps: { label: string; status: 'ok' | 'failed' | 'pending' }[] }
  | { kind: 'diagnostics'; status: 'running' | 'done' | 'timeout'; rows: { label: string; status: Severity | 'pending' | 'unavailable' }[]; top: { severity: Severity; say: string } | null };

const LOCKDOWN_LABEL = { block: 'Block account', sessions: 'Sign out everywhere', refreshTokens: 'Revoke saved sign-ins', mfa: 'Reset MFA', incident: 'Raise P1 incident', alert: 'Alert IT security' };
const CHECK_LABEL: Record<(typeof CHECK_GROUPS)[number], string> = { internet: 'Internet', call: 'Call connection', mic: 'Microphone', speakers: 'Speakers', camera: 'Camera', clock: 'Clock', battery: 'Battery' };
const SEVERITY_ORDER: Severity[] = ['bad', 'warn', 'ok'];

// Each check pending while the browser runs them, then the worst finding per check; the top finding is the one spoken first.
function diagnosticsCard(d: NonNullable<SessionView['diagnostics']>): RightNow {
  const rows = CHECK_GROUPS.map((group) => {
    const found = d.findings.filter((f) => f.group === group).map((f) => f.severity);
    const status: Severity | 'pending' | 'unavailable' = d.status === 'requested' ? 'pending' : SEVERITY_ORDER.find((s) => found.includes(s)) ?? 'unavailable';
    return { label: CHECK_LABEL[group], status };
  });
  const top = d.status === 'done' && d.findings[0] ? { severity: d.findings[0].severity, say: d.findings[0].say } : null;
  return { kind: 'diagnostics', status: d.status === 'requested' ? 'running' : d.status, rows, top };
}

// The one thing the employee needs to act on: a waiting yes, then the email code, then a laptop check while it runs, then the latest check, lockdown or fix step.
// `since` is when this call started: a fix, lockdown or laptop check from an earlier call is not shown again.
export function rightNow(view: SessionView, now: number, since: number | null = null): RightNow | null {
  const p = view.pending;
  if (p && p.expiresAt > now) return { kind: 'confirm', summary: p.summary, warnings: p.warnings, code: p.code, expiresAt: p.expiresAt };
  const v = view.verification;
  if (v.status === 'pending') return { kind: 'verify', email: view.account.email, attemptsLeft: v.attemptsLeft, simulatedCode: v.simulatedInbox?.code ?? null };
  const fresh = (at: number) => since === null || at >= since;
  const fix = view.troubleshooting && fresh(view.troubleshooting.startedAt) ? view.troubleshooting : null;
  const l = view.lockdown && fresh(view.lockdown.at) ? view.lockdown : null;
  const d = view.diagnostics && fresh(view.diagnostics.requestedAt) ? view.diagnostics : null;
  if (d && (d.status === 'requested' || ((!fix || d.requestedAt >= fix.startedAt) && (!l || d.requestedAt >= l.at)))) return diagnosticsCard(d);
  if (l && (!fix || l.at >= fix.startedAt)) {
    return { kind: 'lockdown', incident: l.incident, failed: l.steps.filter((s) => s.status === 'failed').length, steps: l.steps.map((s) => ({ label: LOCKDOWN_LABEL[s.step], status: s.status })) };
  }
  if (!fix) return null;
  const current = fix.steps.find((s) => s.state === 'current');
  if (fix.status === 'active' && current) {
    const done = fix.steps.filter((s) => s.state !== 'current' && s.state !== 'todo').length;
    return { kind: 'fix', title: fix.title, step: current.number, total: fix.steps.length, done, text: current.text, check: current.check };
  }
  if (fix.status === 'fixed' || fix.status === 'resolved') return { kind: 'outcome', tone: 'ok', title: 'Fixed on the call', detail: fix.title };
  if (fix.status === 'ticketed') return { kind: 'outcome', tone: 'warn', title: fix.ticket ? `Ticket ${fix.ticket} raised` : 'Ticket raised', detail: 'IT will follow up on it.' };
  return { kind: 'outcome', tone: 'warn', title: 'No steps left', detail: 'Ask ASK IT to raise a ticket.' };
}

interface DeskItem {
  number: string;
  summary: string;
  stateLabel: string;
}

// Every ticket the screen knows, so a spoken list can show each one's summary and status.
export function ticketCatalog(view: Pick<SessionView, 'tickets' | 'outages'>, desk?: { queue: DeskItem[]; current: DeskItem | null }): Map<string, TicketInfo> {
  const c = new Map<string, TicketInfo>();
  for (const o of view.outages) c.set(o.incident, { summary: o.title, status: 'Outage' });
  for (const i of [...(desk?.queue ?? []), ...(desk?.current ? [desk.current] : [])]) c.set(i.number, { summary: i.summary, status: i.stateLabel });
  for (const t of view.tickets) c.set(t.number, { summary: t.summary, status: t.state });
  return c;
}
