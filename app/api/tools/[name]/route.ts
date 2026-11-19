import { NextRequest, NextResponse } from 'next/server';
import { getTool, parsePersona } from '@/lib/domain/tools';
import { TOOL_SECRET_HEADER, isAuthorizedToolCall } from '@/lib/server/auth';
import { executeTool } from '@/lib/server/execute';
import { SessionNotFoundError, isValidSessionCode, normalizeSessionCode } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const reply = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// Called by Agora for each tool call. Body, from the tool's server.body template: { session_id, tool_call_id, args }.
export async function POST(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!isAuthorizedToolCall(request.headers.get(TOOL_SECRET_HEADER), process.env.TOOL_SECRET)) {
    return reply(401, { ok: false, error: 'unauthorized' });
  }
  const { name } = await params;
  if (!getTool(name)) return reply(404, { ok: false, error: 'unknown_tool', say: `There is no tool called ${name}.` });

  let body: { session_id?: string; persona?: string; args?: unknown };
  try {
    body = await request.json();
  } catch {
    return reply(400, { ok: false, error: 'invalid_json', say: 'The tool request was malformed.' });
  }
  if (!body || typeof body !== 'object') return reply(400, { ok: false, error: 'invalid_json', say: 'The tool request was malformed.' });
  const code = normalizeSessionCode(body.session_id ?? request.headers.get('x-session-id'));
  const expired = { ok: false, error: 'session_not_found', say: 'This ASK IT session has expired. Please end the call and start a new session.' };
  if (!isValidSessionCode(code)) return reply(404, expired);

  try {
    const out = await executeTool(code, name, body.args ?? {}, { persona: parsePersona(body.persona) });
    return reply(out.status, { ...out.result });
  } catch (error) {
    if (error instanceof SessionNotFoundError) return reply(404, expired);
    console.error(`Tool ${name} failed:`, error);
    return reply(500, { ok: false, error: 'internal_error', say: 'The system had a problem with that request. Please try again.' });
  }
}
