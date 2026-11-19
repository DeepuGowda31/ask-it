import { NextRequest, NextResponse } from 'next/server';
import { speakWhenIdle } from '@/lib/agent/agent';
import { IT_INTRO } from '@/lib/agent/config';
import { getStore } from '@/lib/server/store';
import { SessionNotFoundError, isValidSessionCode, normalizeSessionCode, updateSession } from '@/lib/server/session';
import type { SessionState } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

// The IT desk intro, sent by the page when the engineer stays quiet after the greeting. Claimed first, so it is said once.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const raw = (body as { session?: unknown }).session;
  const code = normalizeSessionCode(typeof raw === 'string' ? raw : null);
  if (!isValidSessionCode(code)) return NextResponse.json({ error: 'session is required' }, { status: 400 });

  const now = Date.now();
  type Claim = { state: SessionState; outcome: 'claimed' | 'already' | 'no_call'; agentId: string };
  let claim: Claim;
  try {
    claim = await updateSession(getStore(), code, (s): Claim => {
      const call = s.call;
      if (!call.active || call.persona !== 'itdesk' || !call.agentId) return { state: s, outcome: 'no_call', agentId: '' };
      if (call.introAt) return { state: s, outcome: 'already', agentId: '' };
      return { state: { ...s, call: { ...call, introAt: now } }, outcome: 'claimed', agentId: call.agentId };
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    return NextResponse.json({ error: 'Session busy, try again.' }, { status: 503 });
  }
  if (claim.outcome === 'no_call') return NextResponse.json({ error: 'no_call' }, { status: 409 });
  if (claim.outcome === 'already') return NextResponse.json({ state: 'already' });
  try {
    await speakWhenIdle(claim.agentId, IT_INTRO);
    return NextResponse.json({ state: 'sent' });
  } catch {
    return NextResponse.json({ error: 'The intro could not be sent.' }, { status: 502 });
  }
}
