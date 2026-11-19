import { NextRequest, NextResponse } from 'next/server';
import { snoozeFollowUp } from '@/lib/domain/followup';
import { checkFollowUps } from '@/lib/server/followup';
import { getStore } from '@/lib/server/store';
import { SessionNotFoundError, isValidSessionCode, normalizeSessionCode, updateSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// Polled by the employee page every 20 s while no call is on; the session view carries the ring itself.
export async function GET(request: NextRequest) {
  const code = normalizeSessionCode(request.nextUrl.searchParams.get('session'));
  if (!isValidSessionCode(code)) return reply({ error: 'invalid_session_code' }, 400);
  try {
    const state = await checkFollowUps(getStore(), code, Date.now());
    if (!state) return reply({ error: 'session_not_found' }, 404);
    return reply({ followUp: state.followUp ?? null });
  } catch (error) {
    console.error('Follow-up check failed:', error instanceof Error ? error.name : 'unknown error');
    return reply({ error: 'followup_unavailable' }, 503);
  }
}

// "Not now" on the incoming call: rings again after ten minutes.
export async function POST(request: NextRequest) {
  let body: { session?: unknown; number?: unknown; action?: unknown };
  try {
    body = JSON.parse(await request.text());
  } catch {
    return reply({ error: 'Invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object') return reply({ error: 'Invalid JSON body' }, 400);
  const code = normalizeSessionCode(typeof body.session === 'string' ? body.session : '');
  if (!isValidSessionCode(code) || body.action !== 'snooze' || typeof body.number !== 'string') return reply({ error: 'session, number and action snooze are required' }, 400);
  const number = body.number;
  const now = Date.now();
  try {
    const out = await updateSession(getStore(), code, (s) => {
      const next = snoozeFollowUp(s, number, now);
      return { state: next ?? s, snoozed: next !== null };
    });
    return out.snoozed ? reply({ followUp: out.state.followUp }) : reply({ error: 'not_ringing' }, 409);
  } catch (error) {
    if (error instanceof SessionNotFoundError) return reply({ error: 'session_not_found' }, 404);
    console.error('Follow-up snooze failed:', error instanceof Error ? error.name : 'unknown error');
    return reply({ error: 'followup_unavailable' }, 503);
  }
}
