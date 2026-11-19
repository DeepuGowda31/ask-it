import { NextRequest, NextResponse } from 'next/server';
import { agoraClient, createAskItSession, isAgentAlreadyStoppingOrStopped } from '@/lib/agent/agent';
import { SESSION_MAX_SECONDS, missingEnv, resolvePublicBaseUrl } from '@/lib/agent/config';
import { getStore } from '@/lib/server/store';
import { SessionNotFoundError, isValidSessionCode, loadSession, normalizeSessionCode, updateSession } from '@/lib/server/session';
import { answerFollowUp, isRinging, ringId } from '@/lib/domain/followup';
import { refreshTickets } from '@/lib/server/followup';
import type { SessionState } from '@/lib/domain/types';
import type { AgentResponse, ClientStartRequest } from '@/types/conversation';

export const dynamic = 'force-dynamic';

const error = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: message, ...extra }, { status });

function addCallEvent(state: SessionState, now: number, ok: boolean, title: string, detail?: string): SessionState {
  const next = structuredClone(state);
  next.seq += 1;
  next.events.push({ id: next.seq, at: now, kind: 'call', ok, title, detail });
  return next;
}

// A call that started longer ago than the session cap is stale (e.g. the tab was closed).
const isLive = (call: SessionState['call'], now: number) =>
  call.active && !!call.startedAt && now - call.startedAt < (SESSION_MAX_SECONDS + 120) * 1000;

export async function POST(request: NextRequest) {
  const missing = missingEnv();
  if (missing.length) return error(503, `Server is missing configuration: ${missing.join(', ')}.`, { missing });
  const base = resolvePublicBaseUrl();
  if (!base.ok) return error(400, base.reason, { code: 'public_base_url' });

  let body: ClientStartRequest;
  try {
    body = await request.json();
  } catch {
    return error(400, 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object') return error(400, 'Invalid JSON body');
  const code = normalizeSessionCode(body.session);
  if (!body.channel_name || !body.requester_id || !isValidSessionCode(code)) {
    return error(400, 'channel_name, requester_id and a valid session code are required');
  }
  const persona = body.persona ?? 'employee';
  if (persona !== 'employee' && persona !== 'itdesk') return error(400, 'persona must be employee or itdesk');

  const store = getStore();
  const current = await loadSession(store, code);
  if (!current) return error(404, 'This session has expired. Reload the page to start a new one.', { code: 'session_not_found' });

  const now = Date.now();
  const client = agoraClient();
  if (isLive(current.state.call, now)) {
    if (!body.takeover) {
      return error(409, 'An ASK IT call is already running for this session, maybe in another tab.', { code: 'call_active' });
    }
    try {
      if (current.state.call.agentId) await client.stopAgent(current.state.call.agentId);
    } catch (e) {
      if (!isAgentAlreadyStoppingOrStopped(e)) console.warn('Could not stop previous agent:', e);
    }
  }

  // Answering the incoming call: only while that ticket or reminder is still ringing, else an ordinary call.
  const ringing = current.state.followUp;
  const callBack = persona === 'employee' && body.followUp && ringing && ringId(ringing) === body.followUp && isRinging(ringing, now) ? ringing : null;
  // The greeting and prompt name her tickets, so they are refreshed first when stale.
  const state = persona === 'employee' ? ((await refreshTickets(store, code, now)) ?? current.state) : current.state;

  try {
    const session = createAskItSession({ client, channel: body.channel_name, requesterId: body.requester_id, state, baseUrl: base.url, now, persona, callBack });
    const agentId = await session.start();
    await updateSession(store, code, (s) => {
      const title = !callBack ? 'Call started' : callBack.reminder ? `Reminder call started: ${callBack.summary}` : `Follow-up call about ${callBack.number} started`;
      const next = addCallEvent(s, now, true, title);
      next.call = { active: true, agentId, startedAt: now, persona };
      if (callBack) answerFollowUp(next, ringId(callBack));
      return { state: next };
    });
    return NextResponse.json({ agent_id: agentId, create_ts: Math.floor(now / 1000), state: 'RUNNING', max_seconds: SESSION_MAX_SECONDS } satisfies AgentResponse);
  } catch (e) {
    if (e instanceof SessionNotFoundError) return error(404, 'This session has expired.');
    const detail = (e as { body?: { detail?: string } })?.body?.detail;
    const message = detail || (e instanceof Error ? e.message : 'Failed to start the voice agent');
    console.error('Error starting agent:', message);
    await updateSession(store, code, (s) => ({ state: addCallEvent(s, now, false, 'Call failed to start', message) })).catch(() => {});
    return error(502, `The voice agent could not start: ${message}`);
  }
}
