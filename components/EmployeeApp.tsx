'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Figtree } from 'next/font/google';
import { Download, MapPin, Mic, RotateCcw } from 'lucide-react';
import { Brand } from './Brand';
import { Drawer } from './Drawer';
import { DocumentView } from './DocumentView';
import { Transcript } from './Transcript';
import { AccountCard, DocumentList, MyTickets, RightNowCard, TicketListCard, urgencyLabel } from './SideCards';
import { CallMount, CallSignal } from './VoiceCall';
import { CallStage } from './CallStage';
import { Faq } from './Faq';
import { IncomingCall } from './IncomingCall';
import { useFollowUp } from '@/lib/client/useFollowUp';
import { useNow, useSessionState } from '@/lib/client/useSessionState';
import { useVoiceCall } from '@/lib/client/useVoiceCall';
import { useCallIntro } from '@/lib/client/useCallIntro';
import { useDiagnostics } from '@/lib/client/useDiagnostics';
import { ticketCatalog } from '@/lib/client/right-now';
import { listTurnId, mentionedTickets } from '@/lib/client/ticket-lines';
import { displayEvent } from '@/lib/domain/view';
import { ringId } from '@/lib/domain/followup';
import { findAsset } from '@/lib/domain/assets';
import { downloadText, timeOfDay } from '@/lib/client/format';

// The employee app has its own face: a warmer type and palette than the IT console (scoped by .wc-employee).
const sans = Figtree({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-employee', display: 'swap' });

const SESSION_KEY = 'askit.session';
const CODE_RE = /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/;

function readStoredCode(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export default function EmployeeApp({ setupWarning }: { setupWarning: string | null }) {
  const [code, setCode] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const { view, status: sessionStatus, refresh } = useSessionState(code);
  const now = useNow(1000);

  const [panel, setPanel] = useState<'faq' | 'inspector' | 'doc' | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const lastEvent = view?.events.find((e) => e.kind === 'tool');
  const call = useVoiceCall({
    code,
    persona: 'employee',
    now,
    recentAction: lastEvent && now - lastEvent.at < 6000 ? lastEvent.title : null,
    thinkingHint: 'Checking status pages, guides and your tickets',
  });
  useCallIntro(call, code, 2000);
  useDiagnostics(code, view?.diagnostics, call, refresh);

  // ---- session bootstrap: ?asset=ID starts a fresh session for that device; else ?session=CODE, then the last code used in this browser, else a new one
  const adopt = useCallback((c: string, remember = true) => {
    setCode(c);
    setSessionError(null);
    try {
      if (remember) localStorage.setItem(SESSION_KEY, c);
    } catch {
      /* private mode */
    }
    const url = new URL(window.location.href);
    url.searchParams.set('session', c);
    url.searchParams.delete('asset');
    window.history.replaceState(null, '', url);
  }, []);

  // A scanned device's session is not remembered, so the plain page keeps its own.
  const newSession = useCallback(async (asset?: string) => {
    try {
      const res = await fetch('/api/session', { method: 'POST', ...(asset ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asset }) } : {}) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      adopt(body.code, !asset);
    } catch {
      setSessionError('Could not create a demo session. Check that the server is running and the state store is reachable.');
    }
  }, [adopt]);

  useEffect(() => {
    const params = new URL(window.location.href).searchParams;
    const scanned = findAsset(params.get('asset'));
    const fromUrl = params.get('session')?.toUpperCase() ?? '';
    const stored = readStoredCode() ?? '';
    const candidate = CODE_RE.test(fromUrl) ? fromUrl : CODE_RE.test(stored) ? stored : null;
    (async () => {
      if (scanned) return newSession(scanned.id);
      if (candidate) {
        const res = await fetch(`/api/state?session=${candidate}`, { cache: 'no-store' }).catch(() => null);
        if (res?.ok) return adopt(candidate);
      }
      await newSession();
    })();
  }, [adopt, newSession]);

  const showDoc = useCallback((id: string) => {
    setDocId(id);
    setPanel('doc');
  }, []);

  // A document ASK IT creates mid-call (the call summary) opens by itself.
  const newestDoc = view?.documents[0]?.id ?? null;
  const seenDoc = useRef<string | null>(null);
  const loaded = view !== null;
  useEffect(() => {
    if (!loaded) return;
    if (seenDoc.current !== null && newestDoc && newestDoc !== seenDoc.current && call.phaseRef.current === 'live') showDoc(newestDoc);
    seenDoc.current = newestDoc ?? '';
  }, [loaded, newestDoc, showDoc, call.phaseRef]);

  const openDoc = view?.documents.find((d) => d.id === docId) ?? null;
  const { phase, transcript, issues, agentEvents } = call;
  const inCall = phase !== 'idle';
  // A follow-up or reminder rings only while no call is connecting or live on this session, here or on another screen.
  const { ringing, snooze } = useFollowUp(code, view?.followUp ?? null, (phase === 'idle' || phase === 'ended') && !!view && !view.call.active, now);
  const catalog = useMemo(() => (view ? ticketCatalog(view) : undefined), [view]);
  const asset = view?.asset ?? null;
  // A ticket list ASK IT reads out shows as a small card under that turn, in the caption and the transcript.
  const list = view?.ticketList ?? null;
  const listTurn = list ? listTurnId(transcript, list.at) : null;
  const attachment = list && listTurn ? { id: listTurn, node: <TicketListCard list={list} /> } : null;
  // Tickets ASK IT is talking about light up in My tickets.
  const lastAgent = transcript.findLast((m) => m.role === 'agent');
  const lastAgentText = lastAgent?.text ?? '';
  const listed = lastAgent && lastAgent.id === listTurn ? list : null;
  const mentioned = useMemo(() => new Set([...mentionedTickets(lastAgentText), ...(listed?.tickets.map((t) => t.number) ?? [])]), [lastAgentText, listed]);

  const header = (
    <header className="wc-header">
      <a className="wc-skip" href="#main-content">Skip to main content</a>
      <Brand subtitle="Voice IT helpdesk" />
      <nav className="wc-nav" aria-label="Tools">
        <button onClick={() => setPanel('faq')}>FAQ</button>
        <button onClick={() => setPanel('inspector')} disabled={!code}>Inspector</button>
        <a
          href={code ? `/it?session=${code}` : '/it'}
          target="_blank"
          rel="noopener noreferrer"
          title={code ? `Open IT Operations for session ${code}` : undefined}
        >
          IT Operations
        </a>
      </nav>
    </header>
  );

  const side = (
    <section className={inCall ? 'wc-side em-rail' : 'wc-side'} aria-label="Your IT status">
      {view ? (
        <>
          {sessionStatus === 'error' ? <p className="wc-notice wc-notice-warn" role="status">Connection lost. Showing the last known state while retrying…</p> : null}
          <RightNowCard view={view} now={now} inCall={inCall} />
          <MyTickets view={view} highlight={phase === 'live' ? mentioned : undefined} />
          <DocumentList documents={view.documents} onOpen={showDoc} />
        </>
      ) : sessionStatus === 'not_found' || sessionError ? null : (
        <p className="wc-note" role="status">{sessionStatus === 'error' ? 'Cannot reach the server. Retrying…' : 'Loading your IT status…'}</p>
      )}
    </section>
  );

  return (
    <div className={`wc-employee ${sans.variable} flex min-h-dvh flex-col`} data-in-call={inCall}>
      {header}
      {setupWarning && !inCall ? (
        <div className="mx-auto w-full max-w-[1200px] px-4 md:px-10">
          <p className="wc-notice wc-notice-warn" role="note">{setupWarning}</p>
        </div>
      ) : null}
      {sessionStatus === 'not_found' || sessionError ? (
        <div className="mx-auto w-full max-w-[1200px] px-4 pt-2 md:px-10">
          <div className="wc-notice wc-notice-bad" role="alert">
            <span>{sessionError ?? `Session ${code} has expired.`}</span>
            <button className="wc-btn" onClick={() => void newSession()}><RotateCcw size={14} aria-hidden="true" /> New session</button>
          </div>
        </div>
      ) : null}

      {!inCall && asset ? (
        <main id="main-content" className="wc-workspace wc-workspace-ready wc-asset-ready">
          <section className="wc-welcome wc-asset wc-enter" aria-labelledby="asset-name">
            <p className="wc-label">Scanned QR sticker</p>
            <div className="wc-card wc-asset-card">
              <h2 id="asset-name">{asset.name}</h2>
              <p className="wc-asset-place"><MapPin size={14} aria-hidden="true" /> {asset.location}</p>
              {asset.ticket ? (
                <p className="wc-notice wc-notice-warn wc-asset-reported" role="note">
                  Already reported as <span className="wc-mono">{asset.ticket.number}</span> ({asset.ticket.summary}). Your report will be added to it.
                </p>
              ) : null}
            </div>
            <button className="wc-btn wc-btn-primary wc-btn-lg wc-asset-talk" onClick={() => call.startCall(false)} disabled={!code}>
              <Mic size={18} aria-hidden="true" /> Talk to IT about {asset.name}
            </button>
            {call.canTakeOver ? (
              <button className="wc-btn wc-btn-lg wc-asset-talk" onClick={() => call.startCall(true)}>Take over the other call</button>
            ) : null}
            <p className="wc-note">Microphone access required. ASK IT already knows which device this is.</p>
            {call.error ? <p className="wc-notice wc-notice-bad mt-4" role="alert">{call.error}</p> : null}
          </section>
          <aside className="wc-signal-area" aria-label="Call status"><CallSignal call={call} /></aside>
          {side}
        </main>
      ) : !inCall ? (
        <main id="main-content" className="wc-workspace wc-workspace-ready wc-landing">
          <section className="wc-welcome wc-enter" aria-labelledby="landing-title">
            <h2 id="landing-title">IT help, <span className="wc-accent-text">one call away.</span></h2>
            <p className="wc-lead">Tell IT what&apos;s wrong.<br />Most issues get fixed on the call.</p>
            <div className="wc-talk-row">
              <button className="wc-btn wc-btn-primary wc-btn-lg wc-talk" onClick={() => call.startCall(false)} disabled={!code}>
                <Mic size={20} aria-hidden="true" /> Talk to IT
              </button>
              {call.canTakeOver ? (
                <button className="wc-btn wc-btn-lg wc-talk-alt" onClick={() => call.startCall(true)}>Take over the other call</button>
              ) : null}
            </div>
            {call.error ? <p className="wc-notice wc-notice-bad mt-6" role="alert">{call.error}</p> : null}
          </section>
          <aside className="wc-signal-area" aria-label="Call status"><CallSignal call={call} /></aside>
          {side}
        </main>
      ) : (
        <main id="main-content" className="em-call">
          <CallStage
            call={call}
            catalog={catalog}
            now={now}
            endedText={`Call ended${view?.call.endedAt ? ` at ${timeOfDay(view.call.endedAt)}` : ''}.`}
            onRestart={() => call.startCall(false)}
            attachment={attachment}
          />
          <section className="em-history" aria-label="Transcript">
            <p className="wc-label em-history-head">Transcript{transcript.length ? <span className="wc-num">{transcript.length}</span> : null}</p>
            <Transcript
              catalog={catalog}
              messages={transcript}
              announce={false}
              maxTicketRows={3}
              extras={attachment ? new Map([[attachment.id, attachment.node]]) : undefined}
              placeholder={phase === 'ended' ? 'No conversation was recorded.' : 'Everything you and ASK IT say shows up here.'}
            />
          </section>
          {side}
          <CallMount call={call} />
        </main>
      )}

      {ringing ? <IncomingCall number={ringing.number} summary={ringing.summary} reminder={Boolean(ringing.reminder)} onAnswer={() => call.startCall(false, ringId(ringing))} onDismiss={snooze} /> : null}
      <Faq open={panel === 'faq'} onClose={() => setPanel(null)} />
      <Drawer
        title="Inspector"
        description={code ? `Everything recorded in session ${code}.` : undefined}
        open={panel === 'inspector'}
        onClose={() => setPanel(null)}
        footer={
          <div className="flex flex-wrap gap-2">
            <button
              className="wc-btn"
              disabled={!view}
              onClick={() => downloadText(`askit-session-${code}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), session: view, transcript, agentEvents }, null, 2), 'application/json')}
            >
              Export JSON
            </button>
            <button className="wc-btn" disabled={inCall && phase !== 'ended'} onClick={() => { setPanel(null); call.reset(); newSession(); }}>
              Start a fresh demo session
            </button>
          </div>
        }
      >
        <dl className="wc-kv mb-6">
          <dt>Session</dt><dd className="wc-mono">{code ?? '—'}</dd>
          <dt>Call</dt><dd>{view?.call.active ? `active since ${timeOfDay(view.call.startedAt!)}` : view?.call.endedAt ? `ended (${view.call.endReason})` : 'not started'}</dd>
          <dt>Agent id</dt><dd className="wc-mono break-all">{view?.call.agentId ?? '—'}</dd>
          <dt>Channel</dt><dd className="wc-mono break-all">{call.agoraData?.channel ?? '—'}</dd>
          <dt>Tool calls</dt><dd>{view?.kpis.toolCalls ?? 0}</dd>
          <dt>State version</dt><dd>{view?.version ?? '—'}</dd>
        </dl>
        {view ? <div className="mb-6"><AccountCard account={view.account} /></div> : null}
        {view?.tickets.length ? (
          <div className="mb-6">
            <p className="wc-label">All tickets</p>
            <ul className="wc-ticket-lines mt-1">
              {view.tickets.map((t) => (
                <li key={t.number}>
                  <span className="wc-mono">{t.number}</span>
                  <span className="min-w-0">{t.summary}</span>
                  <span className="wc-faint whitespace-nowrap text-[12px]">{t.state} · {urgencyLabel(t.urgency)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {issues.length ? (
          <div className="mb-6">
            <p className="wc-label">Connection issues</p>
            <ul className="mt-1 grid gap-1 text-[12px] wc-tone-bad">{issues.map((i) => <li key={i}>{i}</li>)}</ul>
          </div>
        ) : null}
        <p className="wc-label">Agent events (RTM)</p>
        {agentEvents.length ? (
          <ol className="wc-events mb-6">
            {agentEvents.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <time>{timeOfDay(e.at)}</time>
                <div>
                  <strong className={e.kind === 'error' ? 'wc-tone-bad font-normal' : e.kind === 'interrupted' ? 'wc-tone-warn font-normal' : 'font-normal'}>
                    {e.kind}{e.module ? ` · ${e.module}` : ''}{e.code !== undefined ? ` · ${e.code}` : ''}
                  </strong>
                  <p className="wc-muted text-[12px] break-all">{e.message}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="wc-note mb-6 mt-1">Errors, interruptions and latency metrics from the agent appear here during a call.</p>
        )}
        <p className="wc-label">Event log</p>
        <ol className="wc-events">
          {(view?.events ?? []).map((e) => (
            <li key={e.id}>
              <time>{timeOfDay(e.at)}</time>
              <div>
                <span className={e.ok ? '' : 'wc-tone-bad'}>{displayEvent(e, now).title}</span>
                <p className="wc-muted text-[12px]">{e.kind === 'tool' ? e.tool : e.kind}{e.detail ? ` · ${e.detail}` : ''}{e.ok ? '' : ' · failed'}</p>
              </div>
            </li>
          ))}
        </ol>
      </Drawer>
      <Drawer
        title={openDoc?.title ?? 'Document'}
        description={openDoc ? `Created ${timeOfDay(openDoc.createdAt)} by ASK IT.` : undefined}
        open={panel === 'doc' && !!openDoc}
        onClose={() => setPanel(null)}
        footer={
          openDoc ? (
            <button className="wc-btn" onClick={() => downloadText(`${openDoc.title.replace(/[^\w]+/g, '-').toLowerCase()}.md`, openDoc.markdown)}>
              <Download size={14} aria-hidden="true" /> Download .md
            </button>
          ) : undefined
        }
      >
        {openDoc ? <DocumentView markdown={openDoc.markdown} /> : null}
      </Drawer>
    </div>
  );
}
