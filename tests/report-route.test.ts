import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import { POST as createSessionRoute } from '@/app/api/session/route';
import { POST as inviteRoute } from '@/app/api/invite-agent/route';
import { POST as toolRoute } from '@/app/api/tools/[name]/route';
import { POST as reportRoute } from '@/app/api/itdesk/report/route';
import { reportFailedLine, reportReadyLine } from '@/lib/domain/report';
import { getStore } from '@/lib/server/store';
import { loadSession, updateSession } from '@/lib/server/session';

const SECRET = 'test-tool-secret-value';
const ENV = {
  NEXT_PUBLIC_AGORA_APP_ID: '0123456789abcdef0123456789abcdef',
  NEXT_AGORA_APP_CERTIFICATE: 'fedcba9876543210fedcba9876543210',
  MURF_API_KEY: 'murf-test-key',
  TOOL_SECRET: SECRET,
  PUBLIC_BASE_URL: 'https://askit.example.com',
};
const LIVE = { SERVICENOW_INSTANCE_URL: 'https://acme.servicenow.example', SERVICENOW_USER: 'u', SERVICENOW_PASSWORD: 'p', SERVICENOW_CALLER_EMAIL: 'c@example.com' };

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'AUTH0_DOMAIN', 'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', ...Object.keys(LIVE)]) vi.stubEnv(k, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

// Agora answers join and speak; ServiceNow answers with `serviceNow`.
function network(serviceNow = 500) {
  const calls: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = input instanceof Request ? await input.clone().text() : typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, body: raw ? JSON.parse(raw) : null });
    if (url.includes('servicenow.example')) return new Response('{}', { status: serviceNow });
    if (url.includes('/join')) return new Response(JSON.stringify({ agent_id: 'agent-it' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { calls, speeches: () => calls.filter((c) => c.url.includes('/agents/agent-it/speak')).map((c) => (c.body as { text: string }).text) };
}

async function session(itCall = true) {
  const code = ((await (await createSessionRoute()).json()) as { code: string }).code;
  if (itCall) await inviteRoute(json('http://localhost/api/invite-agent', { requester_id: '1', channel_name: 'c', session: code, persona: 'itdesk' }));
  return code;
}

async function ask(code: string, period = 'last_7_days') {
  const res = await toolRoute(json('http://localhost/api/tools/generateReport', { session_id: code, persona: 'itdesk', args: { period } }, { 'x-tool-secret': SECRET }), { params: Promise.resolve({ name: 'generateReport' }) });
  expect(res.status).toBe(200);
  return (await loadSession(getStore(), code))!.state.itdesk.report!;
}

const post = (body: unknown) => reportRoute(json('http://localhost/api/itdesk/report', body));
const stateOf = async (code: string) => (await loadSession(getStore(), code))!.state;

describe('/api/itdesk/report', () => {
  it('rejects bad input, unknown sessions, and ids that are not the pending report', async () => {
    network();
    expect((await post('nope')).status).toBe(400);
    expect((await post({ session: 'bad', id: 'x' })).status).toBe(400);
    const code = await session(false);
    expect((await post({ session: code })).status).toBe(400);
    expect((await post({ session: code, id: 'x'.repeat(200) })).status).toBe(400);
    expect((await post({ session: 'ZZZ-ZZZ', id: 'x' })).status).toBe(404);
    const none = await post({ session: code, id: 'x' });
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: 'stale_report' });
    await ask(code);
    expect((await post({ session: code, id: 'someone-else' })).status).toBe(409);
  });
  it('builds the PDF from the desk, marks it ready and says the ready line once', async () => {
    const net = network();
    const code = await session();
    const report = await ask(code, 'this_month');
    const res = await post({ session: code, id: report.id });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="ASK IT Monthly Service Desk Report \d{1,2} [A-Z][a-z]{2} \d{4}\.pdf"/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()), { updateMetadata: false });
    expect(doc.getTitle()).toBe('Monthly IT Service Desk Report');
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    expect((await stateOf(code)).itdesk.report).toMatchObject({ id: report.id, status: 'ready', filename: expect.stringMatching(/^ASK IT Monthly/) });
    await vi.waitFor(() => expect(net.speeches()).toEqual([reportReadyLine('this_month')]));
    // Downloading it again rebuilds the file and says nothing.
    const again = await post({ session: code, id: report.id });
    expect(again.status).toBe(200);
    expect(again.headers.get('content-type')).toBe('application/pdf');
    await new Promise((r) => setTimeout(r, 20));
    expect(net.speeches()).toHaveLength(1);
  });
  it('stays quiet when no IT desk call is running', async () => {
    const net = network();
    const code = await session(false);
    const report = await ask(code);
    expect((await post({ session: code, id: report.id })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(net.speeches()).toEqual([]);
  });
  it('lets one request build it at a time, and takes over an abandoned build', async () => {
    network();
    const code = await session(false);
    const report = await ask(code);
    await updateSession(getStore(), code, (s) => ({ state: { ...s, itdesk: { ...s.itdesk, report: { ...s.itdesk.report!, startedAt: Date.now() } } } }));
    const busy = await post({ session: code, id: report.id });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'in_progress' });
    await updateSession(getStore(), code, (s) => ({ state: { ...s, itdesk: { ...s.itdesk, report: { ...s.itdesk.report!, startedAt: Date.now() - 60_000 } } } }));
    expect((await post({ session: code, id: report.id })).status).toBe(200);
  });
  it('marks the report failed when ServiceNow does not answer, and says so once', async () => {
    const net = network(500);
    const code = await session();
    const report = await ask(code, 'today');
    for (const [k, v] of Object.entries(LIVE)) vi.stubEnv(k, v);
    const res = await post({ session: code, id: report.id });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'report_unavailable' });
    expect(net.calls.some((c) => c.url.includes('servicenow.example'))).toBe(true);
    expect((await stateOf(code)).itdesk.report).toMatchObject({ id: report.id, status: 'failed' });
    await vi.waitFor(() => expect(net.speeches()).toEqual([reportFailedLine('today', true)]));
    const again = await post({ session: code, id: report.id });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'report_failed' });
    await new Promise((r) => setTimeout(r, 20));
    expect(net.speeches()).toHaveLength(1);
    // Asking again starts a fresh report.
    expect((await ask(code, 'today')).id).not.toBe(report.id);
  });
});
