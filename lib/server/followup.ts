import { applyTicketList, settleRings } from '@/lib/domain/followup';
import type { SessionState } from '@/lib/domain/types';
import type { TicketAdapter } from '@/lib/integrations/types';
import { buildDeps } from './deps';
import { loadSession, updateSession } from './session';
import type { VersionedStore } from './store';

const CHECK_SECONDS = 15;
const FRESH_SECONDS = 30;
const REFRESH_TIMEOUT_MS = 2000;

type MakeTickets = (state: SessionState) => TicketAdapter;
const defaultTickets = (now: number): MakeTickets => (s) => buildDeps(s, now).tickets;

// Expires by itself, so claiming it is one atomic write that every tab and instance shares.
const checkKey = (code: string) => `askit:followup:${code}`;
// Set after each good list; while it lives, the session's tickets count as fresh.
const freshKey = (code: string) => `askit:tickets:${code}`;

async function markFresh(store: VersionedStore, code: string, now: number) {
  const hit = await store.get(freshKey(code));
  await store.setIfVersion(freshKey(code), String(now), hit?.version ?? 0, FRESH_SECONDS);
}

// Lists the employee's tickets and applies the list; a failed or, with a timeout, slow list leaves the state as it was.
async function listAndApply(store: VersionedStore, code: string, state: SessionState, now: number, makeTickets: MakeTickets, timeoutMs?: number): Promise<SessionState> {
  const tickets = makeTickets(state);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listed = await Promise.race([tickets.listMine(), ...(timeoutMs ? [new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)))] : [])]);
  clearTimeout(timer);
  if (!listed?.ok) return state;
  await markFresh(store, code, now);
  return (await updateSession(store, code, (s) => ({ state: applyTicketList(s, listed.value, tickets.mode, now) }))).state;
}

// Looks for tickets IT resolved outside ASK IT: at most one ServiceNow list per session every 15 s, never during a call.
// Due reminders ring on every check. Failures stay quiet: no ring, the last known state is returned.
export async function checkFollowUps(store: VersionedStore, code: string, now: number, makeTickets: MakeTickets = defaultTickets(now)): Promise<SessionState | null> {
  const hit = await loadSession(store, code);
  if (!hit) return null;
  if (hit.state.call.active) return hit.state;
  let state = hit.state;
  if (await store.setIfVersion(checkKey(code), String(now), 0, CHECK_SECONDS)) state = await listAndApply(store, code, state, now, makeTickets);
  if (settleRings(state, now) === state) return state;
  return (await updateSession(store, code, (s) => ({ state: settleRings(s, now) }))).state;
}

// Before a call: the employee's tickets from ServiceNow unless listed in the last 30 s, waiting at most 2 s. Any failure keeps what the session knows.
export async function refreshTickets(store: VersionedStore, code: string, now: number, makeTickets: MakeTickets = defaultTickets(now)): Promise<SessionState | null> {
  const hit = await loadSession(store, code);
  if (!hit) return null;
  try {
    if (await store.get(freshKey(code))) return hit.state;
    return await listAndApply(store, code, hit.state, now, makeTickets, REFRESH_TIMEOUT_MS);
  } catch {
    return hit.state;
  }
}
