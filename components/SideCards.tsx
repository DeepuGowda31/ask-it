'use client';

import type { ReactNode } from 'react';
import { Activity, CircleAlert, CircleCheck, CircleMinus, CircleX, Clock3, FileText, Mail, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { SessionView } from '@/lib/domain/view';
import { formatCountdown, ticketQueue } from '@/lib/client/helpers';
import { rightNow } from '@/lib/client/right-now';
import { statusTone } from '@/lib/client/ticket-lines';
import { dateLabel } from '@/lib/client/format';

type Mode = 'live' | 'simulated';

// Live (with the system name) or Simulated.
function ModeBadge({ mode, system }: { mode: Mode; system: string }) {
  return (
    <span className="wc-chip" data-tone={mode === 'live' ? 'ok' : undefined} title={mode === 'live' ? `Connected to ${system}` : `${system} is simulated`}>
      <span className="wc-dot" aria-hidden="true" />
      {mode === 'live' ? `Live · ${system}` : 'Simulated'}
    </span>
  );
}

function Card({ title, meta, children, label }: { title: string; meta?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section className="wc-card wc-enter" aria-label={label ?? title}>
      <div className="wc-card-head">
        <p className="wc-label">{title}</p>
        {meta}
      </div>
      {children}
    </section>
  );
}

const FACTOR: Record<string, string> = {
  guardian: 'Guardian push',
  'push-notification': 'Guardian push',
  otp: 'Authenticator app',
  totp: 'Authenticator app',
  phone: 'SMS',
  sms: 'SMS',
  email: 'Email',
  'webauthn-roaming': 'Security key',
  'webauthn-platform': 'Device biometrics',
  'recovery-code': 'Recovery code',
};

export function AccountCard({ account }: { account: SessionView['account'] }) {
  // Live accounts are only shown as Auth0 read them.
  if (account.locked === null) {
    return (
      <Card title="Account" meta={<ModeBadge mode={account.source} system="Auth0" />}>
        <p className="wc-muted">{account.readFailed ? "Couldn't read your account from Auth0. ASK IT checks again when you call." : 'Reading your account from Auth0…'}</p>
      </Card>
    );
  }
  return (
    <Card title="Account" meta={<ModeBadge mode={account.source} system="Auth0" />}>
      <dl className="wc-kv">
        <dt>Status</dt>
        <dd className="wc-status" data-tone={account.locked ? 'bad' : 'ok'}>
          <span className="wc-dot" aria-hidden="true" />
          {account.locked ? 'Locked' : 'Unlocked'}
        </dd>
        <dt>MFA</dt>
        <dd>
          {!account.factorsKnown ? <span className="wc-muted">Couldn&apos;t read</span>
          : account.factors.length ? [...new Set(account.factors.map((f) => FACTOR[f] ?? f))].join(', ')
          : <span className="wc-tone-warn">None enrolled</span>}
        </dd>
        <dt>Password</dt>
        <dd className="wc-muted">{account.lastPasswordReset ? `last reset ${dateLabel(account.lastPasswordReset)}` : 'never reset'}</dd>
      </dl>
    </Card>
  );
}

const URGENCY = { 1: 'High', 2: 'Medium', 3: 'Low' } as const;
export const urgencyLabel = (u: number) => URGENCY[u as 1 | 2 | 3] ?? String(u);

// Documents ASK IT produced (call summaries), newest first.
export function DocumentList({ documents, onOpen }: { documents: SessionView['documents']; onOpen: (id: string) => void }) {
  if (!documents.length) return null;
  return (
    <section aria-label="Documents">
      <p className="wc-label">Documents</p>
      <ul className="mt-2 grid gap-2">
        {documents.slice(0, 4).map((d) => (
          <li key={d.id}>
            <button className="wc-doc-chip wc-enter" onClick={() => onOpen(d.id)}>
              <FileText size={14} className="wc-tone-accent" aria-hidden="true" />
              <span>{d.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// One laptop check: pending while the browser runs it, then fine, worth a look, a problem, or not available.
function CheckIcon({ status }: { status: 'pending' | 'ok' | 'warn' | 'bad' | 'unavailable' }) {
  if (status === 'pending') return <Clock3 size={14} className="wc-faint" aria-label="Checking" />;
  if (status === 'ok') return <CircleCheck size={14} className="wc-tone-ok" aria-label="Fine" />;
  if (status === 'warn') return <CircleAlert size={14} className="wc-tone-warn" aria-label="Worth a look" />;
  if (status === 'bad') return <CircleX size={14} className="wc-tone-bad" aria-label="Problem" />;
  return <CircleMinus size={14} className="wc-faint" aria-label="Not available" />;
}

const pretty = (code: string) => (/^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

// The one thing that needs the employee now; hidden before the call when nothing does.
export function RightNowCard({ view, now, inCall }: { view: SessionView; now: number; inCall: boolean }) {
  const r = rightNow(view, now);
  if (!r && !inCall) return null;
  return (
    <section className="wc-now wc-enter" data-kind={r?.kind ?? 'idle'} aria-label="Right now" aria-live="polite">
      <p className="wc-label">Right now</p>
      {!r ? (
        <p className="wc-muted mt-2">Tell ASK IT what&apos;s wrong. Steps, codes and confirmations show up here.</p>
      ) : r.kind === 'confirm' ? (
        <>
          <div className="wc-now-head"><Clock3 className="wc-tone-accent" aria-hidden="true" /><strong>Say &ldquo;yes&rdquo; to go ahead</strong><span className="wc-num wc-faint ml-auto text-[12px]">{formatCountdown(r.expiresAt - now)}</span></div>
          <p className="wc-now-text">{r.summary}</p>
          {r.warnings.map((w) => <p key={w} className="wc-tone-warn mt-1 text-[12px]">{w}</p>)}
          <p className="wc-faint mt-2 text-[12px]">Or say &ldquo;no&rdquo; to drop it.</p>
        </>
      ) : r.kind === 'verify' ? (
        <>
          <div className="wc-now-head"><Mail className="wc-tone-accent" aria-hidden="true" /><strong>Check your email</strong><span className="wc-faint ml-auto text-[12px]">{r.attemptsLeft} {r.attemptsLeft === 1 ? 'try' : 'tries'} left</span></div>
          <p className="wc-now-text">Read the 6-digit code out on the call.</p>
          <p className="wc-faint mt-1 break-all text-[12px]">Sent to {r.email}</p>
          {r.simulatedCode ? <p className="wc-inbox" aria-label="Simulated inbox"><span className="wc-faint text-[11px]">Simulated inbox</span><span className="wc-mono wc-inbox-code">{pretty(r.simulatedCode)}</span></p> : null}
        </>
      ) : r.kind === 'fix' ? (
        <>
          <div className="wc-now-head"><strong className="min-w-0 truncate">{r.title}</strong><span className="wc-faint ml-auto whitespace-nowrap text-[12px]">Step {r.step} of {r.total}</span></div>
          <ol className="wc-progress" aria-hidden="true">{Array.from({ length: r.total }, (_, i) => <li key={i} data-state={i < r.done ? 'done' : i === r.step - 1 ? 'current' : 'todo'} />)}</ol>
          <p className="wc-now-text">{r.text}</p>
          <p className="wc-tone-accent mt-1 text-[13px]">{r.check}</p>
        </>
      ) : r.kind === 'diagnostics' ? (
        <>
          <div className="wc-now-head">
            <Activity className={r.status === 'running' ? 'wc-tone-accent' : r.top && r.top.severity !== 'ok' ? 'wc-tone-warn' : 'wc-tone-ok'} aria-hidden="true" />
            <strong>{r.status === 'running' ? 'Checking your laptop…' : r.status === 'timeout' ? "Checks couldn't run" : 'Laptop check'}</strong>
          </div>
          {r.top ? <p className="wc-now-text">{r.top.say}</p> : null}
          <ul className="mt-2 grid gap-1" aria-label="Laptop checks">
            {r.rows.map((c) => (
              <li key={c.label} className="flex items-center gap-2 text-[13px]">
                <CheckIcon status={c.status} />
                <span className={c.status === 'bad' ? 'wc-tone-bad' : c.status === 'warn' ? 'wc-tone-warn' : c.status === 'unavailable' ? 'wc-faint' : undefined}>{c.label}</span>
              </li>
            ))}
          </ul>
          {r.status === 'timeout' ? <p className="wc-faint mt-2 text-[12px]">ASK IT will walk you through the steps instead.</p> : null}
        </>
      ) : r.kind === 'lockdown' ? (
        <>
          <div className="wc-now-head">
            {r.failed ? <ShieldAlert className="wc-tone-warn" aria-hidden="true" /> : <ShieldCheck className="wc-tone-ok" aria-hidden="true" />}
            <strong>{r.failed ? 'Lockdown partly done' : 'Account locked down'}</strong>
          </div>
          {r.incident ? <p className="wc-now-text">Security incident <span className="wc-mono">{r.incident}</span></p> : null}
          <ul className="mt-2 grid gap-1" aria-label="Lockdown steps">
            {r.steps.map((s) => (
              <li key={s.label} className="flex items-center gap-2 text-[13px]">
                {s.status === 'ok' ? <CircleCheck size={14} className="wc-tone-ok" aria-label="Done" />
                : s.status === 'failed' ? <CircleX size={14} className="wc-tone-bad" aria-label="Failed" />
                : <Clock3 size={14} className="wc-faint" aria-label="In progress" />}
                <span className={s.status === 'failed' ? 'wc-tone-bad' : undefined}>{s.label}</span>
              </li>
            ))}
          </ul>
          {r.failed ? <p className="wc-faint mt-2 text-[12px]">IT security will finish what failed by hand.</p> : null}
        </>
      ) : (
        <div className="wc-now-head mt-2">
          {r.tone === 'ok' ? <CircleCheck className="wc-tone-ok" aria-hidden="true" /> : <CircleAlert className="wc-tone-warn" aria-hidden="true" />}
          <span className="min-w-0"><strong className="block">{r.title}</strong><span className="wc-muted text-[13px]">{r.detail}</span></span>
        </div>
      )}
    </section>
  );
}

const MAX_TICKETS = 5;

type TicketRow = SessionView['tickets'][number];
const fixedOnCall = (t: TicketRow) => 'fixedOnCall' in t && Boolean(t.fixedOnCall);
const FixedTag = () => <span className="em-fixed">Fixed on call</span>;

const LIST_TITLE = { open: 'Open tickets', resolved: 'Resolved tickets', all: 'Your tickets' } as const;
const LIST_ROWS = 3;

// The tickets ASK IT just read out, as a small card in the conversation: title, number and status, a few rows at most.
export function TicketListCard({ list }: { list: NonNullable<SessionView['ticketList']> }) {
  const rows = list.tickets.slice(0, LIST_ROWS);
  const more = list.tickets.length - rows.length;
  return (
    <section className="em-tl" aria-label={LIST_TITLE[list.status]}>
      <p className="em-tl-head">
        <strong>{LIST_TITLE[list.status]}</strong>
        <span className="wc-num">{list.tickets.length}</span>
        {list.period ? <span className="em-tl-period">{list.period}</span> : null}
      </p>
      {rows.length ? (
        <ul>
          {rows.map((t) => (
            <li key={t.number} title={t.summary}>
              <span className="em-tl-title">{t.summary.replace(/^Resolved by ASK IT: /, '')}</span>
              <span className="em-tl-meta"><span className="wc-mono">{t.number}</span>{fixedOnCall(t) ? <FixedTag /> : null}</span>
              <span className="wc-chip" data-tone={statusTone(t.state)}>{t.state}</span>
            </li>
          ))}
        </ul>
      ) : <p className="em-tl-none">None found.</p>}
      {more > 0 ? <p className="em-tl-more">and {more} more in My tickets</p> : null}
    </section>
  );
}

// The employee's tickets, open first, then closed ones; one line each. Tickets in highlight are the ones ASK IT is talking about.
export function MyTickets({ view, highlight }: { view: SessionView; highlight?: ReadonlySet<string> }) {
  const rows = ticketQueue(view.tickets).map((t) => ({ number: t.number, summary: t.summary.replace(/^Resolved by ASK IT: /, ''), status: t.state, fixed: fixedOnCall(t) }));
  return (
    <Card title="My tickets" meta={<ModeBadge mode={view.integrations.tickets} system="ServiceNow" />}>
      {rows.length === 0 ? (
        <p className="wc-note">No tickets. ASK IT only raises one when a fix does not work.</p>
      ) : (
        <ul className="wc-ticket-lines">
          {rows.slice(0, MAX_TICKETS).map((t) => (
            <li key={t.number} title={t.summary} data-mentioned={highlight?.has(t.number) || undefined}>
              <span className="wc-mono">{t.number}{t.fixed ? <FixedTag /> : null}</span>
              <span className="min-w-0 truncate">{t.summary}</span>
              <span className="wc-chip" data-tone={statusTone(t.status)}>{t.status}</span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > MAX_TICKETS ? <p className="wc-faint mt-2 text-[12px]">+{rows.length - MAX_TICKETS} more in the Inspector</p> : null}
    </Card>
  );
}
