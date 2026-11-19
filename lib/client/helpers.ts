// Small pure helpers used by the browser UI (kept here so they are unit-testable).

// Strips stray markdown so it never shows up as symbols in the transcript.
export function cleanSpokenText(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '') // headings
        .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '') // list markers
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,!?:;]|$)/g, '$1$2')
        .replace(/(^|[\s(])_(?!\s)([^_]+?)_(?=[\s).,!?:;]|$)/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1'),
    )
    .join('\n')
    .trim();
}

export function describeMicError(err: unknown): string {
  const e = (err ?? {}) as { name?: string; code?: string; message?: string };
  const name = e.name ?? '';
  const code = e.code ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || code === 'PERMISSION_DENIED') {
    return 'Microphone permission was denied. Allow microphone access for this site in your browser settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || code === 'DEVICE_NOT_FOUND') {
    return 'No microphone was found. Connect a headset or microphone and try again.';
  }
  if (name === 'NotReadableError' || name === 'AbortError' || code === 'NOT_READABLE') {
    return 'The microphone is busy or blocked by another app. Close other apps using it and try again.';
  }
  return 'Could not start the microphone. Check your audio device and browser permissions, then try again.';
}

export function capTranscript<T>(items: T[], max = 200): { visible: T[]; hidden: number } {
  return items.length > max ? { visible: items.slice(-max), hidden: items.length - max } : { visible: items, hidden: 0 };
}

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const formatRate = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

export const formatHours = (minutes: number) => String(Math.round(minutes / 6) / 10);

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

// Open tickets first (most urgent, then most recent), closed ones after by recency.
export function ticketQueue<T extends { open: boolean; urgency: number; updatedAt: number }>(tickets: T[]): T[] {
  const rank = (t: T) => (t.open ? t.urgency : 9);
  return [...tickets].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

const MINUTE_MS = 60_000;

export function ageLabel(openedAt: number | null, now: number): string {
  if (openedAt === null) return '—';
  const minutes = Math.floor((now - openedAt) / MINUTE_MS);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  return minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / (24 * 60))}d`;
}

// ServiceNow incident hold reason codes.
const HOLD: Record<string, string> = { '1': 'awaiting caller', '3': 'awaiting problem', '4': 'awaiting vendor', '5': 'awaiting change' };

export const holdLabel = (code: string | null) => (code && HOLD[code]) || null;

export const priorityTone = (priority: number): Tone => (priority === 1 ? 'bad' : priority === 2 ? 'warn' : 'muted');

// The Slack problem behind the header's red dot, only while the newest alert failed.
export function alertProblem(alerts: { status: 'queued' | 'sent' | 'failed'; error?: string }[]): { error: string; failed: number } | null {
  if (alerts[0]?.status !== 'failed') return null;
  const run = alerts.findIndex((a) => a.status !== 'failed');
  return { error: alerts[0].error ?? 'Slack did not accept the alert.', failed: run < 0 ? alerts.length : run };
}

// The IT desk intro is due when only the greeting has been said and the agent is waiting for the engineer.
export function introDue<T extends { role: 'agent' | 'user'; streaming: boolean }>(transcript: T[], signal: string): boolean {
  return transcript.length === 1 && transcript[0].role === 'agent' && !transcript[0].streaming && signal === 'listening';
}
