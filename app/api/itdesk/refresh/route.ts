import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/server/store';
import { isValidSessionCode, normalizeSessionCode } from '@/lib/server/session';
import { syncDesk } from '@/lib/server/sync';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// Called by the IT page about every 15 s while it shows an incident or a board: edits made in ServiceNow reach the screen.
export async function POST(request: NextRequest) {
  let body: { session?: unknown };
  try {
    body = JSON.parse(await request.text());
  } catch {
    return reply({ error: 'Invalid JSON body' }, 400);
  }
  const code = normalizeSessionCode(body && typeof body === 'object' && typeof body.session === 'string' ? body.session : '');
  if (!isValidSessionCode(code)) return reply({ error: 'session is required' }, 400);
  try {
    const out = await syncDesk(getStore(), code, Date.now());
    return out ? reply({ outcome: out.outcome }) : reply({ error: 'session_not_found' }, 404);
  } catch (error) {
    console.error('IT desk refresh failed:', error instanceof Error ? error.name : 'unknown error');
    return reply({ error: 'refresh_unavailable' }, 503);
  }
}
