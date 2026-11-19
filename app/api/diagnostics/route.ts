import { NextRequest, NextResponse } from 'next/server';
import { parseResults } from '@/lib/domain/diagnose';
import { recordDiagnostics } from '@/lib/domain/tools/diagnostics';
import { getStore } from '@/lib/server/store';
import { SessionNotFoundError, isValidSessionCode, normalizeSessionCode, updateSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 8 * 1024;
const ID_RE = /^[A-Z]{2}-\d{1,9}$/;
const REFUSED = { duplicate: 'already_received', unknown: 'unknown_request', expired: 'expired' } as const;

const reply = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// Reads at most `max` bytes; null when the body is larger.
async function readCapped(request: NextRequest, max: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The employee's browser posts its laptop check here. The session code is the credential, as for /api/state.
export async function POST(request: NextRequest) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return reply(413, { ok: false, error: 'too_large' });
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, { ok: false, error: 'too_large' });
  let body: { session?: unknown; id?: unknown; results?: unknown } | null;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { ok: false, error: 'invalid_json' });
  }
  if (!body || typeof body !== 'object') return reply(400, { ok: false, error: 'invalid_body' });
  const code = normalizeSessionCode(typeof body.session === 'string' ? body.session : '');
  if (!isValidSessionCode(code)) return reply(400, { ok: false, error: 'invalid_session_code' });
  const id = typeof body.id === 'string' && ID_RE.test(body.id) ? body.id : null;
  const results = parseResults(body.results);
  if (!id || !results) return reply(400, { ok: false, error: 'invalid_body' });
  try {
    const out = await updateSession(getStore(), code, (s) => recordDiagnostics(s, id, results, Date.now()));
    return out.outcome === 'accepted' ? reply(200, { ok: true }) : reply(409, { ok: false, error: REFUSED[out.outcome] });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return reply(404, { ok: false, error: 'session_not_found' });
    console.error('Failed to record diagnostics:', error);
    return reply(503, { ok: false, error: 'state_unavailable' });
  }
}
