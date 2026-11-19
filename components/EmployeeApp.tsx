'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, KeyRound, MapPin, Mic, RotateCcw, Ticket, Wrench } from 'lucide-react';
import { Brand } from './Brand';
import { Drawer } from './Drawer';
import { DocumentView } from './DocumentView';
import { Transcript } from './Transcript';
import { AccountCard, DocumentList, MyTickets, RightNowCard, urgencyLabel } from './SideCards';
import { CallBanners, CallDock, CallMount, CallSignal } from './VoiceCall';
import { Faq } from './Faq';
import { IncomingCall } from './IncomingCall';
import { formatCountdown } from '@/lib/client/helpers';
import { useFollowUp } from '@/lib/client/useFollowUp';
import { useNow, useSessionState } from '@/lib/client/useSessionState';
import { useVoiceCall } from '@/lib/client/useVoiceCall';
import { useDiagnostics } from '@/lib/client/useDiagnostics';
import { ticketCatalog } from '@/lib/client/right-now';
import { displayEvent } from '@/lib/domain/view';
import { ringId } from '@/lib/domain/followup';
import { findAsset } from '@/lib/domain/assets';
import { downloadText, timeOfDay } from '@/lib/client/format';

const SESSION_KEY = 'askit.session';
const TRY_SAYING = ['My VPN keeps disconnecting', "I'm locked out of my account", 'Is Slack down?', "What's the status of my tickets?"];
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
  const { phase, deadline, transcript, status, issues, agentEvents } = call;
  const left = deadline ? deadline - now : 0;
  const inCall = phase !== 'idle';
  // A follow-up or reminder rings only while no call is connecting or live on this session, here or on another screen.
  const { ringing, snooze } = useFollowUp(code, view?.followUp ?? null, (phase === 'idle' || phase === 'ended') && !!view && !view.call.active, now);
  const catalog = useMemo(() => (view ? ticketCatalog(view) : undefined), [view]);
  const asset = view?.asset ?? null;

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
          title={code ? `Open the IT dashboard for session ${code}` : undefined}
        >
          IT dashboard
        </a>
      </nav>
    </header>
  );

  const side = (
    <section className="wc-side" aria-label="Your IT status">
      {view ? (
        <>
          {sessionStatus === 'error' ? <p className="wc-notice wc-notice-warn" role="status">Connection lost. Showing the last known state; retrying…</p> : null}
          <RightNowCard view={view} now={now} inCall={inCall} />
          <MyTickets view={view} now={now} />
          <DocumentList documents={view.documents} onOpen={showDoc} />
        </>
      ) : sessionStatus === 'not_found' || sessionError ? null : (
        <p className="wc-note" role="status">{sessionStatus === 'error' ? 'Cannot reach the server. Retrying…' : 'Loading your IT status…'}</p>
      )}
    </section>
  );

  return (
    <div className="min-h-dvh">
      {header}
      {setupWarning && !inCall ? (
        <div className="mx-auto max-w-[1200px] px-4 md:px-10">
          <p className="wc-notice wc-notice-warn" role="note">{setupWarning}</p>
        </div>
      ) : null}
      {sessionStatus === 'not_found' || sessionError ? (
        <div className="mx-auto max-w-[1200px] px-4 pt-2 md:px-10">
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
                  Already reported as <span className="wc-mono">{asset.ticket.number}</span>: {asset.ticket.summary}. Your report will be added to it.
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
        <main id="main-content" className="wc-workspace wc-workspace-ready">
          <section className="wc-welcome wc-enter">
            <h2>ASK IT</h2>
            <p className="wc-lead">Tell IT what&apos;s wrong. Most issues get fixed on the call.</p>
            <div className="wc-features" aria-label="In this conversation">
              <span className="wc-pill-label">In this conversation</span>
              <ul>
                <li><Wrench aria-hidden="true" /> Guided fixes, one step at a time</li>
                <li><KeyRound aria-hidden="true" /> Unlock and resets after an email code</li>
                <li><Ticket aria-hidden="true" /> A ticket only when the fix fails</li>
              </ul>
            </div>
            <div className="wc-built-with">
              <span>Built with</span>
              <ul aria-label="Technology">
                <li className="wc-chip">Agora Conversational AI</li>
                <li className="wc-chip">Murf Falcon TTS</li>
                <li className="wc-chip">ServiceNow</li>
                <li className="wc-chip">Auth0</li>
              </ul>
            </div>
            <div className="mb-3 mt-7 flex flex-wrap items-center gap-3">
              <button className="wc-btn wc-btn-primary wc-btn-lg" onClick={() => call.startCall(false)} disabled={!code}>
                <Mic size={18} aria-hidden="true" /> Talk to IT
              </button>
              {call.canTakeOver ? (
                <button className="wc-btn wc-btn-lg" onClick={() => call.startCall(true)}>Take over the other call</button>
              ) : null}
            </div>
            <p className="wc-note">Microphone access required. Sessions end automatically after 10 minutes.</p>
            <p className="wc-note">
              Demo for Priya Sharma at Nimbus Labs. Each card shows whether its system is live or simulated.
              {code ? <> Session <span className="wc-mono text-foreground">{code}</span>.</> : null}
            </p>
            {call.error ? <p className="wc-notice wc-notice-bad mt-4" role="alert">{call.error}</p> : null}
            <div className="wc-try">
              <p className="wc-label">Try saying</p>
              <ul>
                {TRY_SAYING.map((t) => <li key={t}><q>{t}</q></li>)}
              </ul>
            </div>
          </section>
          <aside className="wc-signal-area" aria-label="Call status"><CallSignal call={call} /></aside>
          {side}
        </main>
      ) : (
        <main id="main-content" className="wc-workspace wc-workspace-session">
          <section className="wc-main wc-session" aria-label="Voice conversation">
            <div className="wc-session-heading">
              <h2>Conversation</h2>
              <div className="wc-session-meta">
                {phase === 'live' && deadline ? (
                  <span className="wc-num" data-urgent={left < 60_000}>Session ends in {formatCountdown(left)}</span>
                ) : null}
                <span className="wc-status" data-tone={status.tone} role="status">
                  <span className="wc-dot" aria-hidden="true" /> {status.label}
                </span>
              </div>
            </div>
            <CallBanners call={call} />
            <Transcript
              catalog={catalog}
              messages={transcript}
              placeholder={phase === 'connecting' ? 'Connecting you to ASK IT…' : phase === 'ended' ? 'No conversation was recorded.' : "Say hello, then tell IT what's wrong."}
            />
            <CallDock call={call} endedText={`Call ended${view?.call.endedAt ? ` at ${timeOfDay(view.call.endedAt)}` : ''}.`} onRestart={() => call.startCall(false)} />
          </section>
          <aside className="wc-signal-area" aria-label="Call status"><CallSignal call={call} /></aside>
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
