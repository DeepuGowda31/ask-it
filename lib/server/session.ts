import { randomInt } from 'node:crypto';
import { createSessionState, withCurrentEmployee, type SeedOptions } from '@/lib/domain/seed';
import type { AssetVisit, SessionState } from '@/lib/domain/types';
import type { VersionedStore } from './store';

export const SESSION_TTL_SECONDS = 4 * 60 * 60;
// No 0/O or 1/I: codes are read aloud and typed.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/;

export function generateSessionCode(randomIndex: (n: number) => number = randomInt): string {
  const pick = () => ALPHABET[randomIndex(ALPHABET.length)];
  return `${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}`;
}

export const normalizeSessionCode = (code: string | null | undefined) => String(code ?? '').trim().toUpperCase();
export const isValidSessionCode = (code: string) => CODE_RE.test(code);

const key = (code: string) => `askit:session:${code}`;

export class SessionNotFoundError extends Error {
  constructor(code: string) {
    super(`Session ${code} was not found or has expired`);
  }
}

// `asset` must already be validated against the catalog.
export async function createSession(store: VersionedStore, now: number, seed?: SeedOptions, asset: AssetVisit | null = null): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = generateSessionCode();
    const state = { ...createSessionState(code, now, seed), asset };
    if (await store.setIfVersion(key(code), JSON.stringify(state), 0, SESSION_TTL_SECONDS)) return code;
  }
  throw new Error('Could not allocate a session code');
}

export async function loadSession(store: VersionedStore, code: string): Promise<{ state: SessionState; version: number } | null> {
  const hit = await store.get(key(code));
  return hit ? { state: withCurrentEmployee(JSON.parse(hit.value) as SessionState), version: hit.version } : null;
}

// Optimistic read-modify-write; `fn` must be pure (it may rerun), and returning the same state skips the write.
export async function updateSession<T extends { state: SessionState }>(
  store: VersionedStore,
  code: string,
  fn: (state: SessionState) => T,
  retries = 10,
): Promise<T & { version: number }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const current = await loadSession(store, code);
    if (!current) throw new SessionNotFoundError(code);
    const out = fn(current.state);
    if (out.state === current.state) return { ...out, version: current.version };
    if (await store.setIfVersion(key(code), JSON.stringify(out.state), current.version, SESSION_TTL_SECONDS)) {
      return { ...out, version: current.version + 1 };
    }
    await new Promise((r) => setTimeout(r, Math.random() * 15 * (attempt + 1)));
  }
  throw new Error('Session is busy, please retry');
}
