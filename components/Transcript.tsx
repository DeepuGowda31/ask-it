'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import type { TranscriptMessage } from '@/lib/conversation';
import { capTranscript } from '@/lib/client/helpers';
import { timeOfDay } from '@/lib/client/format';
import { displayTicketNumbers, statusTone, ticketList, type TicketInfo } from '@/lib/client/ticket-lines';

const MAX_RENDERED = 200;
const NO_TICKETS: ReadonlyMap<string, TicketInfo> = new Map();

// Agent turns that read out tickets show one line per ticket; other turns show INC numbers as written.
// maxRows caps a long list to a few lines and says how many more there are.
export function AgentBody({ text, catalog, maxRows }: { text: string; catalog: ReadonlyMap<string, TicketInfo>; maxRows?: number }) {
  const list = ticketList(text, catalog);
  if (!list) return <div className="wc-msg-body">{displayTicketNumbers(text) || '…'}</div>;
  const shown = maxRows ? list.items.slice(0, maxRows) : list.items;
  const more = list.items.length - shown.length;
  return (
    <div className="wc-msg-body">
      {list.intro ? <p>{list.intro}</p> : null}
      <ul className="wc-ticket-lines">
        {shown.map((i) => (
          <li key={i.number}>
            <span className="wc-mono">{i.number}</span>
            <span className="min-w-0">{i.summary}</span>
            {i.status ? <span className="wc-chip" data-tone={statusTone(i.status)}>{i.status}</span> : <span />}
          </li>
        ))}
        {more > 0 ? <li className="wc-ticket-more">and {more} more</li> : null}
      </ul>
      {list.outro ? <p>{list.outro}</p> : null}
    </div>
  );
}

// Live transcript: follows new turns unless the user scrolled up, then offers "jump to latest".
// The employee screen speaks its captions elsewhere, so its history passes announce={false}, caps ticket lists and attaches cards to turns (extras, by message id).
export function Transcript({ messages, placeholder, catalog = NO_TICKETS, announce = true, maxTicketRows, extras }: { messages: TranscriptMessage[]; placeholder: string; catalog?: ReadonlyMap<string, TicketInfo>; announce?: boolean; maxTicketRows?: number; extras?: ReadonlyMap<string, ReactNode> }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const { visible, hidden } = capTranscript(messages, MAX_RENDERED);
  const last = messages.at(-1);

  useEffect(() => {
    const el = scroller.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [following, messages.length, last?.text]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  return (
    <div className="wc-transcript">
      <div ref={scroller} className="wc-transcript-scroll" role="log" aria-live={announce ? 'polite' : 'off'} aria-label="Live transcript" tabIndex={0} onScroll={onScroll}>
        {hidden > 0 ? <p className="wc-note text-center">{hidden} earlier turns hidden — export them from the Inspector.</p> : null}
        {visible.length === 0 ? (
          <div className="wc-msg">
            <div className="wc-msg-header"><strong>ASK IT</strong></div>
            <div className="wc-msg-body wc-muted">{placeholder}</div>
          </div>
        ) : (
          visible.map((m) => (
            <article key={m.id} className={`wc-msg ${m.role === 'user' ? 'wc-msg-user' : ''} ${m.streaming ? 'wc-msg-streaming' : ''}`}>
              <div className="wc-msg-header">
                <strong>{m.role === 'user' ? 'You' : 'ASK IT'}</strong>
                {m.createdAt ? <time dateTime={new Date(m.createdAt).toISOString()}>{timeOfDay(m.createdAt)}</time> : null}
                {m.streaming ? <span className="ml-2">· live</span> : null}
                {m.interrupted ? <span className="ml-2 wc-tone-warn">· interrupted</span> : null}
              </div>
              {m.role === 'agent' ? <AgentBody text={m.text} catalog={catalog} maxRows={maxTicketRows} /> : <div className="wc-msg-body">{m.text || '…'}</div>}
              {extras?.get(m.id)}
            </article>
          ))
        )}
      </div>
      {!following ? (
        <button
          className="wc-jump"
          aria-label="Jump to latest message"
          onClick={() => {
            setFollowing(true);
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
          }}
        >
          <ArrowDown size={18} />
        </button>
      ) : null}
    </div>
  );
}
