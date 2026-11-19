import { spokenDigits } from './tickets';
import { MINUTE } from './time';
import type { CardUpdate, Delivery } from '@/lib/integrations/types';
import type { ActionPayload, Alert, DocumentRecord, Notification, PendingAction, SessionState } from './types';

// Two-step commits: a prepare tool stores a PendingAction; confirmAction commits it once, cancelAction discards it.
export const ACTION_TTL_MS = 5 * MINUTE;
// A commit that has not finished after this long is treated as abandoned and can be claimed again.
export const CLAIM_TTL_MS = 15_000;
const MAX_PENDING = 50;

export function nextId(state: SessionState, prefix: string): string {
  state.counter += 1;
  return `${prefix}-${state.counter}`;
}

export function createPending(state: SessionState, now: number, payload: ActionPayload, summary: string, warnings: string[]): PendingAction {
  state.counter += 1;
  // 7919 is coprime with 9000, so codes never repeat within a session.
  const action: PendingAction = { code: String(1000 + ((state.counter * 7919) % 9000)), summary, warnings, payload, status: 'pending', createdAt: now, expiresAt: now + ACTION_TTL_MS };
  state.pending = [...state.pending, action].slice(-MAX_PENDING);
  return action;
}

export const findAction = (state: SessionState, code: string) => {
  const digits = spokenDigits(code);
  return digits ? state.pending.find((a) => a.code === digits) : undefined;
};

export function addDocument(state: SessionState, now: number, doc: Pick<DocumentRecord, 'kind' | 'title' | 'markdown'>): DocumentRecord {
  const record = { id: nextId(state, 'DOC'), createdAt: now, ...doc };
  state.documents = [...state.documents, record].slice(-30);
  return record;
}

// Queues an IT channel message; the server delivers it after the tool has answered.
export function queueAlert(state: SessionState, now: number, kind: Notification['kind'], text: string, card?: CardUpdate): Alert {
  const n: Notification = { id: nextId(state, 'NT'), kind, text, status: 'queued', channel: null, ok: false, at: now };
  state.notifications = [...state.notifications, n].slice(-50);
  return { id: n.id, text, ...(card ? { card } : {}) };
}

// Pure: records how a queued message went.
export function markDelivery(current: SessionState, id: string, delivery: Delivery): SessionState {
  if (!current.notifications.some((n) => n.id === id)) return current;
  const state = structuredClone(current);
  const n = state.notifications.find((x) => x.id === id)!;
  Object.assign(n, delivery.ok ? { status: 'sent', ok: true, channel: delivery.channel } : { status: 'failed', ok: false, error: delivery.error });
  return state;
}
