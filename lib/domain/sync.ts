import type { Result } from '@/lib/integrations/http';
import type { AccountInfo, DeskIncident, WorkNote } from '@/lib/integrations/types';
import { internalServiceIn } from './services';
import { echo } from './tickets';
import { refreshBoard, type BoardRead } from './tools/itdesk';
import type { Outage, SessionState } from './types';

// Pure reducers for what the live systems said; `read` is null when they did not answer in time. Unchanged input returns the same state.

// Her account as Auth0 reads it. A failed read keeps the last real one, or marks a never-read account unreadable.
export function applyAccountRead(state: SessionState, read: Result<AccountInfo> | null, now: number): SessionState {
  if (read?.ok) return { ...state, account: { ...read.value, source: 'live', checkedAt: now } };
  if (state.account.locked !== null || state.account.readFailed) return state;
  return { ...state, account: { ...state.account, readFailed: true } };
}

const OPEN = new Set(['1', '2', '3']);

// The outage as its ServiceNow master incident says: title, start and service from its text, no affected count.
// A closed or missing incident ends it unless she follows it; a failed read keeps what was known.
export function applyOutageRead(state: SessionState, number: string, read: Result<DeskIncident | null> | null): SessionState {
  if (!read?.ok) return state;
  const known = state.outages.find((o) => o.incident === number);
  const others = state.outages.filter((o) => o.incident !== number);
  const i = read.value;
  if (!i || !OPEN.has(i.state)) return !known || known.followed ? state : { ...state, outages: others };
  const title = echo(i.summary, 100) || number;
  const outage: Outage = { ...known, id: known?.id ?? 'OUT-1', service: internalServiceIn(i.summary), title, incident: number, affected: known?.affected ?? null, since: i.openedAt, followed: known?.followed ?? false };
  return JSON.stringify(outage) === JSON.stringify(known) ? state : { ...state, outages: [outage, ...others] };
}

// What the IT desk reads from ServiceNow for the screen: the open incident with its notes, and the board's own query.
interface DeskRead {
  incident?: { number: string; found: Result<DeskIncident | null> | null; notes: Result<WorkNote[]> | null };
  board?: BoardRead | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// `base` is the desk as it was when the reads began: a part a tool changed since is left alone, and pending confirmations are never touched.
// A failed read keeps what is on screen.
export function applyDeskRead(state: SessionState, base: SessionState['itdesk'], read: DeskRead, now: number): SessionState {
  let desk = state.itdesk;
  const fresh = read.board && same(desk.board, base.board) && same(desk.queue, base.queue) ? refreshBoard(desk, read.board, now) : null;
  if (fresh) desk = { ...desk, ...fresh };
  const r = read.incident;
  const found = r?.found?.ok ? r.found.value : null;
  if (r && found && found.number === r.number && desk.current?.number === r.number && same(state.itdesk.current, base.current)) {
    const notes = r.notes?.ok ? r.notes.value : desk.current.notes;
    desk = { ...desk, current: { ...found, notes }, queue: desk.queue.map((i) => (i.number === found.number ? found : i)) };
  }
  return same(desk, state.itdesk) ? state : { ...state, itdesk: desk };
}
