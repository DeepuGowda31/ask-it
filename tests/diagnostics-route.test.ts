import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createSessionRoute } from '@/app/api/session/route';
import { GET as stateRoute } from '@/app/api/state/route';
import { POST as toolRoute } from '@/app/api/tools/[name]/route';
import { POST as diagnosticsRoute } from '@/app/api/diagnostics/route';

const SECRET = 'test-tool-secret-value';

beforeEach(() => {
  vi.stubEnv('TOOL_SECRET', SECRET);
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'SERVICENOW_INSTANCE_URL', 'AUTH0_DOMAIN', 'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'SLACK_BOT_TOKEN']) vi.stubEnv(k, '');
});
afterEach(() => vi.unstubAllEnvs());

const post = (body: unknown, headers: Record<string, string> = {}) =>
  diagnosticsRoute(new NextRequest('http://localhost/api/diagnostics', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }));

const state = async (code: string) => (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();

async function newSession(): Promise<string> {
  return ((await (await createSessionRoute()).json()) as { code: string }).code;
}

// Starts runDiagnostics the way Agora does and returns once the request is visible to the page.
async function requestDiagnostics(code: string, focus = 'calls') {
  const tool = toolRoute(
    new NextRequest('http://localhost/api/tools/runDiagnostics', { method: 'POST', body: JSON.stringify({ session_id: code, args: { focus } }), headers: { 'content-type': 'application/json', 'x-tool-secret': SECRET } }),
    { params: Promise.resolve({ name: 'runDiagnostics' }) },
  );
  for (;;) {
    const d = (await state(code)).diagnostics;
    if (d?.status === 'requested') return { id: d.id as string, tool };
    await new Promise((r) => setTimeout(r, 20));
  }
}

const RESULTS = { online: true, lossUpPct: 14, rttMs: 80, sites: [{ site: 'slack', ok: true, ms: 120 }], micLevel: 0.3, outputs: 2 };

describe('/api/diagnostics', () => {
  it('takes the browser results, answers the waiting tool and shows the checks', async () => {
    const code = await newSession();
    const { id, tool } = await requestDiagnostics(code);
    const view = await state(code);
    expect(view.diagnostics).toEqual({ id, focus: 'calls', status: 'requested', requestedAt: expect.any(Number), findings: [] });
    const res = await post({ session: code.toLowerCase(), id, results: { ...RESULTS, junk: 'x' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const spoken = await (await tool).json();
    expect(spoken.say).toMatch(/^You're losing 14 percent of your call audio/);
    const after = await state(code);
    expect(after.diagnostics).toMatchObject({ id, status: 'done' });
    expect(after.diagnostics.findings[0]).toMatchObject({ key: 'loss', group: 'call', severity: 'bad' });
    expect(JSON.stringify(after.diagnostics)).not.toMatch(/junk|results/);
  });

  it('accepts only the first result for a request', async () => {
    const code = await newSession();
    const { id, tool } = await requestDiagnostics(code);
    const [a, b] = await Promise.all([post({ session: code, id, results: RESULTS }), post({ session: code, id, results: { lossUpPct: 0 } })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await (b.status === 409 ? b : a).json()).error).toBe('already_received');
    await tool;
    expect((await post({ session: code, id, results: RESULTS })).status).toBe(409);
  });

  it('rejects a wrong id and requests that are not running', async () => {
    const code = await newSession();
    const none = await post({ session: code, id: 'DX-101', results: RESULTS });
    expect(none.status).toBe(409);
    expect((await none.json()).error).toBe('unknown_request');
    const { id, tool } = await requestDiagnostics(code);
    const wrong = await post({ session: code, id: 'DX-999', results: RESULTS });
    expect(wrong.status).toBe(409);
    await post({ session: code, id, results: RESULTS });
    await tool;
  });

  it('validates the session, the body and its size', async () => {
    const code = await newSession();
    expect((await post({ session: 'nope', id: 'DX-1', results: {} })).status).toBe(400);
    expect((await post({ session: 'ZZZ-ZZZ', id: 'DX-1', results: {} })).status).toBe(404);
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ session: code, id: 'DX-1' })).status).toBe(400);
    expect((await post({ session: code, id: 'DX-1', results: [] })).status).toBe(400);
    expect((await post({ session: code, id: 'x'.repeat(100), results: {} })).status).toBe(400);
    expect((await post({ session: code, id: 42, results: {} })).status).toBe(400);
    const big = await post({ session: code, id: 'DX-1', results: { browser: 'x'.repeat(20_000) } });
    expect(big.status).toBe(413);
    expect((await post({ session: code, id: 'DX-1', results: {} }, { 'content-length': '999999' })).status).toBe(413);
  });
});
