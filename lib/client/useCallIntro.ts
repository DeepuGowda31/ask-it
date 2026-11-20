'use client';

import { useEffect } from 'react';
import { introDue } from './helpers';
import type { VoiceCall } from './useVoiceCall';

// After `delayMs` of quiet following the greeting, asks the server for the call's intro line; the server says it at most once per call.
export function useCallIntro(call: Pick<VoiceCall, 'phase' | 'transcript' | 'signalState'>, code: string | null, delayMs: number) {
  const ready = call.phase === 'live' && introDue(call.transcript, call.signalState);
  useEffect(() => {
    if (!ready || !code) return;
    const timer = setTimeout(() => {
      fetch('/api/intro', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: code }) }).catch(() => {});
    }, delayMs);
    return () => clearTimeout(timer);
  }, [ready, code, delayMs]);
}
