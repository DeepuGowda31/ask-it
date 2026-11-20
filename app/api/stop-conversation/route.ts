import { NextRequest, NextResponse } from 'next/server';
import { agoraClient, isAgentAlreadyStoppingOrStopped } from '@/lib/agent/agent';
import { deferDelivery } from '@/lib/server/deliveries';
import { logCallFixes } from '@/lib/server/fixes';
import { getStore } from '@/lib/server/store';
import { isValidSessionCode, normalizeSessionCode, updateSession } from '@/lib/server/session';
import type { StopConversationRequest } from '@/types/conversation';

export const dynamic = 'force-dynamic';

// Stops the agent (idempotent) and marks the call as ended. Accepts sendBeacon text bodies.
export async function POST(request: NextRequest) {
  let body: StopConversationRequest;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const code = normalizeSessionCode(body.session);
  if (!body.agent_id && !isValidSessionCode(code)) {
    return NextResponse.json({ error: 'agent_id or session is required' }, { status: 400 });
  }

  let state: 'stopped' | 'already-stopping' | 'not-running' = 'not-running';
  if (body.agent_id) {
    if (!process.env.NEXT_PUBLIC_AGORA_APP_ID || !process.env.NEXT_AGORA_APP_CERTIFICATE) {
      return NextResponse.json({ error: 'Missing Agora configuration' }, { status: 503 });
    }
    try {
      await agoraClient().stopAgent(body.agent_id);
      state = 'stopped';
    } catch (error) {
      if (!isAgentAlreadyStoppingOrStopped(error)) {
        console.error('Error stopping agent:', error);
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to stop agent' }, { status: 500 });
      }
      state = 'already-stopping';
    }
  }

  if (isValidSessionCode(code)) {
    const now = Date.now();
    await updateSession(getStore(), code, (s) => {
      // A stop for an earlier agent (a call that was taken over) leaves the current call alone.
      if (body.agent_id && s.call.agentId !== body.agent_id) return { state: s };
      const next = structuredClone(s);
      const reason = String(body.reason ?? 'ended').slice(0, 80);
      if (next.call.active) {
        next.seq += 1;
        next.events.push({ id: next.seq, at: now, kind: 'call', ok: true, title: `Call ended (${reason})` });
      }
      next.call = { ...next.call, active: false, endedAt: now, endReason: reason };
      return { state: next };
    }).catch(() => {});
    // A fix made on the call still gets its resolved record, after the response.
    deferDelivery(() => logCallFixes(getStore(), code, now));
  }
  return NextResponse.json({ success: true, state });
}
