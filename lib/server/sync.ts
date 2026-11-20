import { applyAccountRead, applyDeskRead, applyOutageRead } from '@/lib/domain/sync';
import { readBoard } from '@/lib/domain/tools/itdesk';
import type { SessionState } from '@/lib/domain/types';
import type { Result } from '@/lib/integrations/http';
import type { AccountInfo, DeskAdapter, DeskIncident } from '@/lib/integrations/types';
import { buildDeps, outageIncident } from './deps';
import { refreshTickets } from './followup';
import { loadSession, updateSession } from './session';
import type { VersionedStore } from './store';

const READ_TIMEOUT_MS = 2500;
const DESK_TIMEOUT_MS = 4000;
const DESK_SYNC_SECONDS = 10;

// The live systems to read; a simulated backend is the session itself, so it has none.
export interface LiveSources {
  account?: () => Promise<Result<AccountInfo>>;
  outage?: { number: string; read: () => Promise<Result<DeskIncident | null>> };
}

function liveSources(state: SessionState, now: number): LiveSources {
  const deps = buildDeps(state, now);
  const number = outageIncident();
  return {
    ...(deps.identity.mode === 'live' ? { account: () => deps.identity.getUser() } : {}),
    ...(deps.desk.mode === 'live' && number ? { outage: { number, read: () => deps.desk.get(number) } } : {}),
  };
}

// null when the read throws or takes longer than the timeout.
async function within<T>(read: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Reads her Auth0 account and the outage's ServiceNow incident in parallel, waiting at most 2.5 s.
// What fails keeps what the session knew; nothing is invented.
export async function syncLive(store: VersionedStore, code: string, now: number, sources: (state: SessionState) => LiveSources = (s) => liveSources(s, now)): Promise<SessionState | null> {
  const hit = await loadSession(store, code);
  if (!hit) return null;
  const { account, outage } = sources(hit.state);
  if (!account && !outage) return hit.state;
  const [user, incident] = await Promise.all([account ? within(account, READ_TIMEOUT_MS) : null, outage ? within(outage.read, READ_TIMEOUT_MS) : null]);
  try {
    return (
      await updateSession(store, code, (s) => {
        const read = account ? applyAccountRead(s, user, now) : s;
        return { state: outage ? applyOutageRead(read, outage.number, incident) : read };
      })
    ).state;
  } catch {
    return hit.state;
  }
}

// Before an employee call: her tickets, account and outage, read in parallel.
export async function refreshForCall(store: VersionedStore, code: string, now: number): Promise<SessionState | null> {
  await Promise.all([refreshTickets(store, code, now), syncLive(store, code, now)]);
  return (await loadSession(store, code))?.state ?? null;
}

// Expires by itself, so claiming it is one atomic write that every tab and instance shares.
const deskSyncKey = (code: string) => `askit:desksync:${code}`;

type DeskSync = 'synced' | 'idle' | 'simulated' | 'throttled' | 'unavailable';

// The IT page's open incident and its list, count or dashboard, read again from ServiceNow so edits made there show up.
// At most one read per session every 10 s, waiting at most 4 s; what fails keeps what is on screen.
export async function syncDesk(store: VersionedStore, code: string, now: number, makeDesk: (state: SessionState) => DeskAdapter = (s) => buildDeps(s, now).desk): Promise<{ state: SessionState; outcome: DeskSync } | null> {
  const hit = await loadSession(store, code);
  if (!hit) return null;
  const base = hit.state.itdesk;
  const current = base.current;
  const board = base.board && ['list', 'count', 'dashboard'].includes(base.board.kind) ? base.board : null;
  if (!current && !board) return { state: hit.state, outcome: 'idle' };
  const desk = makeDesk(hit.state);
  if (desk.mode !== 'live') return { state: hit.state, outcome: 'simulated' };
  if (!(await store.setIfVersion(deskSyncKey(code), String(now), 0, DESK_SYNC_SECONDS))) return { state: hit.state, outcome: 'throttled' };
  const [found, notes, boardRead] = await Promise.all([
    current ? within(() => desk.get(current.number), DESK_TIMEOUT_MS) : null,
    current ? within(() => desk.workNotes(current.sysId), DESK_TIMEOUT_MS) : null,
    board ? within(() => readBoard(desk, board, now), DESK_TIMEOUT_MS) : null,
  ]);
  if (!found?.ok && !boardRead?.rows.ok) return { state: hit.state, outcome: 'unavailable' };
  try {
    const read = { ...(current ? { incident: { number: current.number, found, notes } } : {}), board: boardRead };
    const { state } = await updateSession(store, code, (s) => ({ state: applyDeskRead(s, base, read, now) }));
    return { state, outcome: 'synced' };
  } catch {
    return { state: hit.state, outcome: 'unavailable' };
  }
}
