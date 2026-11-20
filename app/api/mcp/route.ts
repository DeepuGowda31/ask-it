import { NextRequest, NextResponse } from 'next/server';
import { getTool, parsePersona, toolJsonSchema, toolsFor } from '@/lib/domain/tools';
import { COMPANY, EMPLOYEE } from '@/lib/domain/company';
import type { Persona } from '@/lib/domain/types';
import { TOOL_SECRET_HEADER, isAuthorizedToolCall } from '@/lib/server/auth';
import { executeTool } from '@/lib/server/execute';
import { SessionNotFoundError, isValidSessionCode, normalizeSessionCode } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

// Minimal stateless MCP server with the same tools as /api/tools; ?session=CODE and ?persona=employee|itdesk (or headers).

const PROTOCOL_VERSION = '2025-03-26';

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const rpcResult = (id: RpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const textResult = (payload: unknown, isError: boolean) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError });

async function handle(msg: RpcRequest, session: string, persona: Persona) {
  switch (msg.method) {
    case 'initialize':
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ask-it', version: '1.0.0' },
        instructions: `ASK IT helpdesk tools for ${EMPLOYEE.name} at ${COMPANY}: service status and outages, guided fixes from the knowledge base, identity verification by email code, account unlock and resets, and ServiceNow tickets. Committing actions return a confirmation code for confirmAction.`,
      });
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, { tools: toolsFor(persona).map((t) => ({ name: t.name, description: t.description, inputSchema: toolJsonSchema(t) })) });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      if (!getTool(name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      if (!isValidSessionCode(session)) {
        return rpcResult(msg.id, textResult({ ok: false, error: 'session_not_found', say: 'No valid session code was provided.' }, true));
      }
      try {
        const out = await executeTool(session, name, msg.params?.arguments ?? {}, { persona });
        return rpcResult(msg.id, textResult(out.result, !out.result.ok));
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return rpcResult(msg.id, textResult({ ok: false, error: 'session_not_found', say: 'This session has expired.' }, true));
        }
        console.error('MCP tool call failed:', error);
        return rpcResult(msg.id, textResult({ ok: false, error: 'internal_error' }, true));
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function POST(request: NextRequest) {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!isAuthorizedToolCall(request.headers.get(TOOL_SECRET_HEADER) ?? bearer, process.env.TOOL_SECRET)) {
    return NextResponse.json(rpcError(null, -32001, 'Unauthorized'), { status: 401 });
  }
  let payload: RpcRequest | RpcRequest[];
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }
  const session = normalizeSessionCode(request.nextUrl.searchParams.get('session') ?? request.headers.get('x-session-id'));
  const messages = Array.isArray(payload) ? payload : [payload];
  // Notifications (no id) get no response body.
  const requests = messages.filter((m) => m && m.id !== undefined && m.id !== null);
  if (!requests.length) return new NextResponse(null, { status: 202 });
  const persona = parsePersona(request.nextUrl.searchParams.get('persona') ?? request.headers.get('x-persona'));
  const responses = await Promise.all(requests.map((m) => handle(m, session, persona)));
  return NextResponse.json(Array.isArray(payload) ? responses : responses[0], { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET() {
  // No server-initiated stream; clients use POST only.
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}
