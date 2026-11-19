'use client';

import { BellRing, Check, Mic } from 'lucide-react';
import { Transcript } from './Transcript';
import { CallBanners, CallDock, CallSignal } from './VoiceCall';
import type { StateView } from '@/lib/client/useSessionState';
import type { VoiceCall } from '@/lib/client/useVoiceCall';
import { ageLabel, formatCountdown, holdLabel, priorityTone } from '@/lib/client/helpers';
import { timeOfDay } from '@/lib/client/format';
import type { TicketInfo } from '@/lib/client/ticket-lines';

type Desk = StateView['itdesk'];
type Incident = Desk['queue'][number];


const stateText = (i: Incident) => [i.stateLabel, holdLabel(i.holdReason)].filter(Boolean).join(' · ');

export function Priority({ incident }: { incident: Pick<Incident, 'priority' | 'priorityLabel'> }) {
  const tone = priorityTone(incident.priority);
  return <span className="wc-chip" data-tone={tone === 'muted' ? undefined : tone}>P{incident.priority} {incident.priorityLabel}</span>;
}

const OPEN_STATES = ['1', '2', '3'];

// Empty fields are flagged while the incident is still open; once finished they are just empty.
function Field({ label, value, open }: { label: string; value: string | null; open: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ?? (open ? <span className="wc-status wc-tone-warn" data-tone="warn"><span className="wc-dot" aria-hidden="true" />missing</span> : <span className="wc-faint">—</span>)}</dd>
    </div>
  );
}

function Pending({ pending, now }: { pending: NonNullable<Desk['pending']>; now: number }) {
  return (
    <div className="wc-live-pending" role="status">
      <strong className="whitespace-nowrap">Say &ldquo;yes&rdquo; to save <span className="wc-mono text-[12px]">{pending.number}</span></strong>
      <span className="min-w-0">{pending.changes.join(' · ')}</span>
      <span className="wc-num wc-faint ml-auto whitespace-nowrap text-[12px]">{formatCountdown(pending.expiresAt - now)}</span>
    </div>
  );
}

function Saved({ update }: { update: NonNullable<Desk['lastUpdate']> }) {
  return (
    <p className="wc-saved" role="status">
      <Check size={14} className="wc-tone-ok flex-none" aria-hidden="true" />
      <span className="min-w-0 truncate">Saved <span className="wc-mono text-[12px]">{update.number}</span> · {update.changes.join(', ')}</span>
      <span className="wc-faint ml-auto whitespace-nowrap text-[12px]">{timeOfDay(update.at)}</span>
    </p>
  );
}

// The incident being worked on, above the results: its fields, the change waiting for a yes, and the last save.
export function LiveIncident({ desk, now }: { desk: Desk; now: number }) {
  const i = desk.current;
  const pending = desk.pending && desk.pending.expiresAt > now ? desk.pending : null;
  const saved = desk.lastUpdate && (!i || desk.lastUpdate.number === i.number) ? desk.lastUpdate : null;
  if (!i && !pending && !saved) return null;
  const note = i?.workNotes[0];
  const asked = desk.updateRequest && i && desk.updateRequest.number === i.number ? desk.updateRequest : null;
  return (
    <section className="wc-live-card wc-enter" data-waiting={Boolean(pending)} aria-label={i ? `Open incident ${i.number}` : 'Incident update'}>
      {i ? (
        <>
          <div className="wc-live-head">
            <span className="wc-mono text-[12px]">{i.number}</span>
            <Priority incident={i} />
            <strong className="min-w-0 truncate" title={i.summary}>{i.summary}</strong>
            <span className="wc-faint ml-auto whitespace-nowrap text-[12px]">{i.caller ?? 'Unknown caller'} · opened {ageLabel(i.openedAt, now)} ago</span>
          </div>
          <dl key={saved?.at ?? 0} className="wc-live-fields wc-enter">
            <div><dt>State</dt><dd>{stateText(i)}</dd></div>
            <Field label="Assignee" value={i.assignee} open={OPEN_STATES.includes(i.state)} />
            <Field label="Group" value={i.group} open={OPEN_STATES.includes(i.state)} />
            <Field label="Category" value={i.category} open={OPEN_STATES.includes(i.state)} />
          </dl>
        </>
      ) : null}
      {pending ? <Pending pending={pending} now={now} /> : saved ? <Saved update={saved} /> : null}
      {asked ? (
        <p className="wc-asked" role="status">
          <BellRing size={14} className="wc-tone-accent flex-none" aria-hidden="true" />
          <span className="min-w-0 truncate">Update requested from {asked.assignee} in the IT channel</span>
          <span className="wc-faint ml-auto whitespace-nowrap text-[12px]">{now < asked.due ? `by ${timeOfDay(asked.due)}` : `due ${timeOfDay(asked.due)}`}</span>
        </p>
      ) : null}
      {note && !pending ? <p className="wc-faint truncate text-[12px]" title={note.text}>Last note{note.at ? ` · ${timeOfDay(note.at)}` : ''}: <span className="wc-muted">{note.text}</span></p> : null}
    </section>
  );
}

// The incidents ASK IT last found, with the open one highlighted.
export function QueueList({ queue, current, now }: { queue: Incident[]; current: string | null; now: number }) {
  return (
    <ul className="wc-desk-queue" aria-live="polite">
      <li className="wc-list-head" aria-hidden="true"><span>Incident</span><span>Summary</span><span>Priority</span><span>State</span><span>Assignee</span><span className="text-right">Age</span></li>
      {queue.map((i) => (
        <li key={i.number} aria-current={i.number === current ? 'true' : undefined}>
          <span className="wc-mono text-[12px]">{i.number}</span>
          <span className="min-w-0 truncate" title={i.summary}>{i.summary}</span>
          <Priority incident={i} />
          <span className="wc-muted">{stateText(i)}</span>
          <span className={i.assignee ? '' : 'wc-tone-warn'}>{i.assignee ?? 'unassigned'}</span>
          <span className="wc-faint wc-num text-right">{ageLabel(i.openedAt, now)}</span>
        </li>
      ))}
    </ul>
  );
}

// The call column: start a call, then the live conversation fills it.
export function CallPanel({ call, now, catalog, footer }: { call: VoiceCall; now: number; catalog: ReadonlyMap<string, TicketInfo>; footer: string }) {
  const inCall = call.phase !== 'idle';
  return (
    <section className="wc-call-col" aria-label="IT desk voice call">
      {inCall ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-3 text-[12px]">
              <span className="wc-status whitespace-nowrap" data-tone={call.status.tone} role="status"><span className="wc-dot" aria-hidden="true" />{call.status.label}</span>
              {call.phase === 'live' ? <span className="wc-muted truncate" aria-live="polite">{call.captionDetail || call.caption}</span> : null}
            </span>
            {call.phase === 'live' && call.deadline ? <span className="wc-num wc-muted text-[12px]">{formatCountdown(call.deadline - now)}</span> : null}
          </div>
          <div className="wc-desk-signal"><CallSignal call={call} /></div>
          <CallBanners call={call} />
          <div className="wc-desk-transcript">
            <Transcript catalog={catalog} messages={call.transcript} placeholder={call.phase === 'connecting' ? 'Connecting you to ASK IT…' : call.phase === 'ended' ? 'No conversation was recorded.' : 'Ask for the queue, or name an incident.'} />
          </div>
          <CallDock call={call} endedText="Call ended." onRestart={() => call.startCall(false)} />
        </>
      ) : (
        <div className="wc-desk-idle">
          <h2 className="wc-desk-title">IT desk by voice</h2>
          <p className="wc-muted">Tap once and talk. Answers appear on the left; nothing is saved until you say yes.</p>
          <button className="wc-btn wc-btn-primary wc-btn-lg w-full" onClick={() => call.startCall(false)}><Mic size={18} aria-hidden="true" /> Talk to ASK IT</button>
          {call.canTakeOver ? <button className="wc-btn w-full" onClick={() => call.startCall(true)}>Take over the other call</button> : null}
          {call.error ? <p className="wc-notice wc-notice-bad" role="alert">{call.error}</p> : null}
        </div>
      )}
      <p className="wc-call-foot">{footer}</p>
    </section>
  );
}
