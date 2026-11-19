'use client';

import { useEffect, useRef } from 'react';
import type { SessionView } from '@/lib/domain/view';
import { collectDiagnostics } from './diagnostics';
import type { VoiceCall } from './useVoiceCall';

// Runs a requested laptop check once per id, only in the tab that holds the live call, and posts the results.
export function useDiagnostics(code: string | null, request: SessionView['diagnostics'] | undefined, call: VoiceCall, onPosted: () => void) {
  const started = useRef(new Set<string>());
  const live = call.phase === 'live';
  const id = request?.status === 'requested' ? request.id : null;
  const { probe, micEnabled } = call;
  useEffect(() => {
    if (!code || !live || !id || started.current.has(id)) return;
    started.current.add(id);
    collectDiagnostics({
      code,
      now: Date.now,
      fetch: (input, init) => fetch(input, init),
      nav: navigator,
      probe: probe.current,
      micMuted: !micEnabled,
      canPickOutput: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
    })
      .then((results) => fetch('/api/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: code, id, results }) }))
      .then(onPosted, () => {});
  }, [code, live, id, probe, micEnabled, onPosted]);
}
