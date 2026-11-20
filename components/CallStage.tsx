'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { TranscriptMessage } from '@/lib/conversation';
import type { VoiceCall } from '@/lib/client/useVoiceCall';
import type { TicketInfo } from '@/lib/client/ticket-lines';
import { formatCountdown } from '@/lib/client/helpers';
import { AgentSignal } from './AgentSignal';
import { AgentBody } from './Transcript';
import { CallBanners, CallDock } from './VoiceCall';

const NO_TICKETS: ReadonlyMap<string, TicketInfo> = new Map();

const lastOf = (messages: TranscriptMessage[], role: TranscriptMessage['role']) => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === role) return { message: messages[i], index: i };
  return null;
};

// The live moment of an employee call: the call state, what ASK IT is saying now, the employee's last words and the controls.
// attachment: a card (the ticket list) that belongs to one ASK IT turn, shown under it while it is the caption.
export function CallStage({ call, catalog = NO_TICKETS, now, endedText, onRestart, attachment }: { call: VoiceCall; catalog?: ReadonlyMap<string, TicketInfo>; now: number; endedText: string; onRestart: () => void; attachment?: { id: string; node: ReactNode } | null }) {
  const { phase, transcript, deadline } = call;
  const agent = lastOf(transcript, 'agent');
  const user = lastOf(transcript, 'user');
  // The employee spoke after ASK IT, so ASK IT's last words step back.
  const userTurn = Boolean(user && (!agent || user.index > agent.index));
  const left = deadline ? deadline - now : 0;
  const placeholder = phase === 'connecting' ? 'Connecting you to ASK IT…' : phase === 'ended' ? 'No conversation was recorded.' : "Say hello, then tell IT what's wrong.";

  // Long turns keep their newest words in view.
  const caption = useRef<HTMLDivElement>(null);
  const captionText = agent?.message.text;
  useEffect(() => {
    const el = caption.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    el.dataset.overflow = String(el.scrollHeight > el.clientHeight + 1);
  }, [captionText]);

  // Screen readers hear each finished ASK IT turn once; the visible caption streams word by word.
  const spoken = agent && !agent.message.streaming ? agent.message.text : '';

  return (
    <section className="em-stage" data-state={call.signalState} data-muted={!call.micEnabled} aria-label="Voice call">
      <div className="em-stage-top">
        <span className="em-state" role="status">
          <span className="em-state-dot" aria-hidden="true" />
          {call.caption}
        </span>
        {phase === 'live' && deadline ? (
          <span className="em-countdown wc-num" data-urgent={left < 60_000}>Ends in {formatCountdown(left)}</span>
        ) : null}
      </div>
      <CallBanners call={call} />

      <div className="em-live">
        <div className="em-signal">
          <AgentSignal activity={{ state: call.signalState, micEnabled: call.micEnabled, levelSource: call.levelSource }} paused={false} />
        </div>
        <p className="em-detail">{phase === 'ended' ? '' : call.captionDetail}</p>
        <div ref={caption} className="em-caption" data-stale={userTurn || phase === 'ended'} aria-hidden="true">
          {agent ? <AgentBody text={agent.message.text} catalog={catalog} maxRows={3} /> : <p className="em-caption-empty">{placeholder}</p>}
        </div>
        {agent && attachment?.id === agent.message.id ? <div className="em-attached" data-stale={userTurn || phase === 'ended'} aria-hidden="true">{attachment.node}</div> : null}
        {user ? (
          <p className="em-you" data-active={userTurn && phase !== 'ended'}>
            <span className="em-you-label">You</span>
            <span className="em-you-text">{user.message.text || '…'}</span>
          </p>
        ) : null}
        <p className="sr-only" aria-live="polite">{spoken}</p>
      </div>

      <CallDock call={call} endedText={endedText} onRestart={onRestart} />
    </section>
  );
}
