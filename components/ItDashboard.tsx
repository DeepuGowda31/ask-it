'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Brand } from './Brand';
import { CallPanel, LiveIncident } from './ItDesk';
import { Results } from './Results';
import { CallMount } from './VoiceCall';
import type { SessionView } from '@/lib/domain/view';
import { alertProblem, formatCountdown, introDue } from '@/lib/client/helpers';
import { ticketCatalog } from '@/lib/client/right-now';
import { pickSessionCode } from '@/lib/client/session-code';
import { useNow, useSessionState } from '@/lib/client/useSessionState';
import { useVoiceCall } from '@/lib/client/useVoiceCall';

const SESSION_KEY = 'askit.session';
// Quiet time after the greeting before the short intro.
const INTRO_DELAY_MS = 3000;

// Connected systems in the header; Slack turns red while its alerts are failing.
function Systems({ view }: { view: SessionView }) {
  const slackDown = alertProblem(view.notifications);
  const rows = [
    { name: 'ServiceNow', mode: view.integrations.tickets, problem: null },
    { name: 'Auth0', mode: view.integrations.identity, problem: null },
    { name: 'Slack', mode: view.integrations.notify, problem: slackDown?.error ?? null },
    { name: 'Status pages', mode: view.integrations.status, problem: null },
  ];
  return (
    <ul className="wc-systems" aria-label="Connected systems">
      {rows.map((r) => (
        <li key={r.name} className="wc-status" data-tone={r.problem ? 'bad' : r.mode === 'live' ? 'ok' : undefined} title={r.problem ?? (r.mode === 'live' ? `${r.name}: live` : `${r.name}: simulated`)}>
          <span className="wc-dot" aria-hidden="true" />{r.name}
        </li>
      ))}
    </ul>
  );
}

// The empty stage: who ASK IT is, in two lines.
function Welcome({ live }: { live: boolean }) {
  return (
    <section className="wc-welcome-it wc-enter" aria-label="Welcome">
      <p className="wc-eyebrow" data-live={live}><span className="wc-dot" aria-hidden="true" />{live ? 'Live on ServiceNow' : 'Simulated ServiceNow'}</p>
      <h2>Hi, I&apos;m ASK IT, your IT Admin voice agent.</h2>
      <p>Run the whole service desk by talking: ask for any slice of the queue, see who&apos;s free to take it, and assign, update or resolve incidents the moment you say yes.</p>
    </section>
  );
}

export default function ItDashboard({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [bootFailed, setBootFailed] = useState(false);
  const { view, status } = useSessionState(code);
  const now = useNow(1000);
  const lastEvent = view?.events.find((e) => e.kind === 'tool');
  const call = useVoiceCall({
    code,
    persona: 'itdesk',
    now,
    recentAction: lastEvent && now - lastEvent.at < 6000 ? lastEvent.title : null,
    thinkingHint: 'Checking the ServiceNow queue',
  });
  const catalog = useMemo(() => (view ? ticketCatalog(view, view.itdesk) : new Map()), [view]);
  // A few quiet seconds after the greeting bring the short intro; the server says it at most once per call.
  const introReady = call.phase === 'live' && introDue(call.transcript, call.signalState);
  useEffect(() => {
    if (!introReady || !code) return;
    const timer = setTimeout(() => {
      fetch('/api/intro', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: code }) }).catch(() => {});
    }, INTRO_DELAY_MS);
    return () => clearTimeout(timer);
  }, [introReady, code]);

  // The link's session, else this browser's last one, else a fresh one: the dashboard never asks for a code.
  const adopt = useCallback((c: string) => {
    setCode(c);
    setBootFailed(false);
    try {
      localStorage.setItem(SESSION_KEY, c);
    } catch {
      /* private mode */
    }
    const url = new URL(window.location.href);
    url.searchParams.set('session', c);
    window.history.replaceState(null, '', url);
  }, []);
  const startFresh = useCallback(async () => {
    try {
      const res = await fetch('/api/session', { method: 'POST' });
      const body = await res.json();
      if (!res.ok || typeof body.code !== 'string') throw new Error('no session');
      adopt(body.code);
    } catch {
      setBootFailed(true);
    }
  }, [adopt]);
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(SESSION_KEY);
    } catch {
      /* private mode */
    }
    const candidate = pickSessionCode(initialCode, stored);
    (async () => {
      if (candidate) {
        const res = await fetch(`/api/state?session=${candidate}`, { cache: 'no-store' }).catch(() => null);
        if (res?.ok) return adopt(candidate);
      }
      await startFresh();
    })();
  }, [initialCode, adopt, startFresh]);
  // A session that expires while the page is open is replaced quietly.
  useEffect(() => {
    if (status === 'not_found') startFresh();
  }, [status, startFresh]);

  const header = (extra?: ReactNode) => (
    <header className="wc-header wc-header-compact">
      <a className="wc-skip" href="#main-content">Skip to main content</a>
      <Brand subtitle="IT dashboard" href={code ? `/?session=${code}` : '/'} />
      {extra}
      <nav className="wc-nav" aria-label="Screens">
        <a href={code ? `/?session=${code}` : '/'}>Employee screen</a>
      </nav>
    </header>
  );

  if (!view) {
    return (
      <div className="min-h-dvh">
        {header()}
        <div className="wc-muted flex flex-wrap items-center gap-3 px-4 py-20 md:px-10" role="status">
          {bootFailed ? (
            <>
              <span>Could not start the IT desk. Check that the server is running.</span>
              <button className="wc-btn" onClick={startFresh}>Try again</button>
            </>
          ) : status === 'error' ? 'Cannot reach the server. Retrying…' : 'Starting your IT desk…'}
        </div>
      </div>
    );
  }

  const board = view.itdesk.board;

  const live = (
    <span className="wc-live whitespace-nowrap" data-on={view.call.active} role="status" aria-live="polite">
      <span className={`wc-dot ${view.call.active ? 'wc-pulse' : ''}`} aria-hidden="true" />
      {view.call.active && view.call.startedAt
        ? <>{view.call.persona === 'itdesk' ? 'IT desk call' : `${view.employee.firstName} is on a call`} · <span className="wc-num">{formatCountdown(now - view.call.startedAt)}</span></>
        : 'No active call'}
    </span>
  );

  return (
    <div className="wc-it">
      {header(<div className="wc-header-mid">{live}<Systems view={view} /></div>)}
      <main id="main-content" className="wc-it-main">
        <div className="wc-stage">
          {status === 'error' ? <p className="wc-notice wc-notice-warn" role="status">Connection lost. Showing the last known state; retrying…</p> : null}
          <LiveIncident desk={view.itdesk} now={now} />
          {board ? <section key={board.at} className="wc-board wc-enter" aria-live="polite"><Results view={view} now={now} /></section> : <Welcome live={view.integrations.tickets === 'live'} />}
        </div>
        <CallPanel call={call} now={now} catalog={catalog} footer={`${view.employee.name} · ${view.employee.device.id} · session ${view.session.id}`} />
        <CallMount call={call} />
      </main>
    </div>
  );
}
