'use client';

import { useEffect } from 'react';

const REFRESH_MS = 15_000;
const TIMEOUT_MS = 8_000;

// While the tab is visible and something from ServiceNow is on screen, asks the server every 15 s to read it again.
// A hidden tab pauses; coming back refreshes at once if a beat was missed. Failures stay quiet: the last values stay.
export function useDeskRefresh(code: string | null, active: boolean) {
  useEffect(() => {
    if (!code || !active) return;
    let busy = false;
    let last = Date.now();
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      last = Date.now();
      try {
        await fetch('/api/itdesk/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: code }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        /* the next beat tries again */
      } finally {
        busy = false;
      }
    };
    const id = setInterval(refresh, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden && Date.now() - last >= REFRESH_MS) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [code, active]);
}
