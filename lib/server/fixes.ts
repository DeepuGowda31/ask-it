import { randomUUID } from 'node:crypto';
import { applyFixes, claimFixes, fixesEffect } from '@/lib/domain/fixes';
import { buildDeps, type DepsFactory } from './deps';
import { updateSession } from './session';
import type { VersionedStore } from './store';

// When the call ends: logs an account fix markResolved never logged, and retries once a record ServiceNow did not take.
// Claimed first, so a markResolved or wrap up in flight is never logged twice. Failures stay on the session as a local record.
export async function logCallFixes(store: VersionedStore, code: string, now: number, makeDeps: DepsFactory = buildDeps) {
  const claim = randomUUID();
  const { state, claimed } = await updateSession(store, code, (s) => {
    // A stop for an earlier agent leaves the call that took over to log its own fixes.
    if (s.call.active) return { state: s, claimed: false };
    const next = structuredClone(s);
    return claimFixes(next, claim, now) ? { state: next, claimed: true } : { state: s, claimed: false };
  });
  if (!claimed) return;
  const effect = await fixesEffect(state, makeDeps(state, now), claim, now);
  if ((effect.account && !effect.account.created.ok) || (effect.retry && !effect.retry.ok)) console.warn('A fix made on the call was not saved in ServiceNow; it is kept on the session.');
  await updateSession(store, code, (s) => {
    const next = structuredClone(s);
    applyFixes(next, effect, claim, now);
    return { state: next };
  });
}
