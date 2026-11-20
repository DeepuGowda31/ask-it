'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StateView } from './useSessionState';

type Report = NonNullable<StateView['itdesk']['report']>;
interface Saved {
  id: string;
  url: string;
  name: string;
}

const TIMEOUT_MS = 40_000;
const FALLBACK_NAME = 'ASK IT Service Desk Report.pdf';

// The quoted filename from Content-Disposition.
function filenameOf(header: string | null): string | null {
  const m = header?.match(/filename="([^"]+)"/);
  return m ? m[1] : null;
}

function save(file: Saved) {
  const a = document.createElement('a');
  a.href = file.url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function fetchReport(code: string, id: string): Promise<Saved | null> {
  try {
    const res = await fetch('/api/itdesk/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: code, id }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || res.headers.get('content-type') !== 'application/pdf') return null;
    const blob = await res.blob();
    return { id, url: URL.createObjectURL(blob), name: filenameOf(res.headers.get('content-disposition')) ?? FALLBACK_NAME };
  } catch {
    return null;
  }
}

// A pending report is built and downloaded once by this tab; the server lets only one tab build it.
// The file stays in memory so "Download again" works even when the browser blocked the first download.
export function useReport(code: string | null, report: Report | null) {
  const started = useRef(new Set<string>());
  const file = useRef<Saved | null>(null);
  const [busy, setBusy] = useState(false);
  const id = report?.id ?? null;
  const pending = report?.status === 'pending';

  const keep = useCallback((next: Saved) => {
    if (file.current) URL.revokeObjectURL(file.current.url);
    file.current = next;
    save(next);
  }, []);

  useEffect(() => {
    if (!code || !id || !pending || started.current.has(id)) return;
    started.current.add(id);
    fetchReport(code, id).then((got) => got && keep(got));
  }, [code, id, pending, keep]);

  useEffect(
    () => () => {
      if (file.current) URL.revokeObjectURL(file.current.url);
    },
    [],
  );

  const downloadAgain = useCallback(async () => {
    if (!code || !id) return;
    if (file.current?.id === id) return save(file.current);
    setBusy(true);
    const got = await fetchReport(code, id);
    setBusy(false);
    if (got) keep(got);
  }, [code, id, keep]);

  return { downloadAgain, busy };
}
