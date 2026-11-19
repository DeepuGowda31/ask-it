'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionView } from '@/lib/domain/view';
import type { buildItDeskView } from '@/lib/domain/itdesk-view';

// What /api/state returns: the session view plus the IT desk read model.
export type StateView = SessionView & { itdesk: ReturnType<typeof buildItDeskView> };

type SessionStatus = 'idle' | 'loading' | 'ok' | 'not_found' | 'error';

// Polls /api/state about once a second; the ETag makes unchanged polls a cheap 304.
export function useSessionState(code: string | null, intervalMs = 1000) {
  const [view, setView] = useState<StateView | null>(null);
  const [status, setStatus] = useState<SessionStatus>('idle');
  const etag = useRef<string | null>(null);
  const kick = useRef<() => void>(() => {});
  // A hidden tab keeps the full rate during a call, so a laptop check is picked up in time.
  const inCall = useRef(false);

  useEffect(() => {
    etag.current = null;
    setView(null);
    if (!code) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      clearTimeout(timer);
      try {
        const res = await fetch(`/api/state?session=${encodeURIComponent(code)}`, {
          cache: 'no-store',
          headers: etag.current ? { 'If-None-Match': etag.current } : {},
        });
        if (stopped) return;
        if (res.status === 200) {
          etag.current = res.headers.get('etag');
          const next: StateView = await res.json();
          inCall.current = Boolean(next.call?.active);
          setView(next);
          setStatus('ok');
        } else if (res.status === 404 || res.status === 400) {
          setStatus('not_found');
        } else if (res.status !== 304) {
          setStatus('error');
        }
      } catch {
        if (!stopped) setStatus('error');
      }
      if (!stopped) timer = setTimeout(poll, document.hidden && !inCall.current ? intervalMs * 5 : intervalMs);
    };
    kick.current = poll;
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [code, intervalMs]);

  const refresh = useCallback(() => kick.current(), []);
  return { view, status, refresh };
}

// Re-renders every `ms` so countdowns stay live between polls.
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
