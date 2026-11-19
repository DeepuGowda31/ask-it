import { randomUUID } from 'node:crypto';
import { markDelivery } from '@/lib/domain/actions';
import { beginTool, computeEffect, getTool, hasEffect, runTool, toolAllowed } from '@/lib/domain/tools';
import { fail } from '@/lib/domain/tools/shared';
import type { Alert, Persona } from '@/lib/domain/types';
import type { Delivery } from '@/lib/integrations/types';
import { alertDeliverer, deferDelivery } from './deliveries';
import { buildDeps, type DepsFactory } from './deps';
import { loadSession, updateSession } from './session';
import { getStore, type VersionedStore } from './store';

interface Options {
  makeDeps?: DepsFactory;
  store?: VersionedStore;
  deliver?: (alert: Alert) => Promise<Delivery>;
  persona?: Persona;
}

// Runs a tool: optional claim, outbound calls once, the pure state update, then alerts after the response.
export async function executeTool(code: string, name: string, args: unknown, { makeDeps = buildDeps, store = getStore(), deliver, persona = 'employee' }: Options = {}) {
  // Each call only reaches the tools of its persona; unknown tools fall through to a 404.
  if (getTool(name) && !toolAllowed(name, persona)) return { status: 403, result: fail('not_available', "I can't do that in this call.") };
  const now = Date.now();
  const claim = randomUUID();
  let effect: unknown;
  if (hasEffect(name)) {
    const { state } = await updateSession(store, code, (s) => ({ state: beginTool(name, s, args, now, claim, persona) ?? s }));
    effect = await computeEffect(name, state, args, now, makeDeps(state, now), claim, async () => (await loadSession(store, code))?.state ?? null);
  }
  const out = await updateSession(store, code, (state) => runTool(name, state, args, now, effect, claim, persona));
  const send = deliver ?? alertDeliverer(store);
  for (const alert of out.alerts) {
    deferDelivery(async () => {
      const delivery = await send(alert);
      await updateSession(store, code, (s) => ({ state: markDelivery(s, alert.id, delivery) }));
    });
  }
  return { status: out.status, result: out.result };
}
