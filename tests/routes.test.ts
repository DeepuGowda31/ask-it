import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createSessionRoute } from '@/app/api/session/route';
import { GET as stateRoute } from '@/app/api/state/route';
import { POST as toolRoute } from '@/app/api/tools/[name]/route';
import { POST as mcpRoute, GET as mcpGet } from '@/app/api/mcp/route';
import { POST as inviteRoute } from '@/app/api/invite-agent/route';
import { POST as stopRoute } from '@/app/api/stop-conversation/route';
import { POST as introRoute } from '@/app/api/intro/route';
import { POST as followUpPost } from '@/app/api/followup/route';
import { GET as tokenRoute } from '@/app/api/generate-agora-token/route';
import { toolsFor } from '@/lib/domain/tools';
import { IT_INTRO } from '@/lib/agent/config';
import { settleDeliveries } from '@/lib/server/deliveries';

const SECRET = 'test-tool-secret-value';
const ENV = {
  NEXT_PUBLIC_AGORA_APP_ID: '0123456789abcdef0123456789abcdef',
  NEXT_AGORA_APP_CERTIFICATE: 'fedcba9876543210fedcba9876543210',
  MURF_API_KEY: 'murf-test-key',
  TOOL_SECRET: SECRET,
  PUBLIC_BASE_URL: 'https://askit.example.com',
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NEXT_LLM_URL', 'NEXT_LLM_API_KEY', 'VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'SERVICENOW_INSTANCE_URL', 'AUTH0_DOMAIN', 'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL']) {
    vi.stubEnv(k, '');
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

async function newSession(): Promise<string> {
  const res = await createSessionRoute();
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

const tool = (name: string, body: unknown, secret: string | null = SECRET) =>
  toolRoute(json(`http://localhost/api/tools/${name}`, body, secret === null ? {} : { 'x-tool-secret': secret }), { params: Promise.resolve({ name }) });

describe('/api/state', () => {
  it('serves the session with an ETag and 304s when unchanged', async () => {
    const code = await newSession();
    const res = await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`));
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag')!;
    expect(etag).toBe('"v1"');
    const body = await res.json();
    expect(body.session.id).toBe(code);
    expect(body.call.active).toBe(false);
    expect(body.integrations).toEqual({ tickets: 'simulated', identity: 'simulated', notify: 'simulated', status: 'live' });
    expect(body.tickets).toHaveLength(2);
    expect(body.itdesk).toEqual({ queue: [], current: null, lastUpdate: null, pending: null, board: null, updateRequest: null, report: null, stage: { incident: false, board: false } });
    expect(body.employee.email).toBe('p***@nimbuslabs.example');
    expect(body.account.email).toBe('p***@nimbuslabs.example');
    expect(JSON.stringify(body)).not.toMatch(/priya\.sharma@/);
    const again = await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`, { headers: { 'if-none-match': etag } }));
    expect(again.status).toBe(304);
  });
  it('rejects bad and unknown codes', async () => {
    expect((await stateRoute(new NextRequest('http://localhost/api/state?session=nope'))).status).toBe(400);
    expect((await stateRoute(new NextRequest('http://localhost/api/state?session=ZZZ-ZZZ'))).status).toBe(404);
  });
});

describe('/api/session with a scanned asset', () => {
  const create = (body: unknown) => createSessionRoute(json('http://localhost/api/session', body));
  const view = async (code: string) => (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();

  it('starts a fresh session that knows the device and its open ticket', async () => {
    const res = await create({ asset: 'printer-3f' });
    expect(res.status).toBe(201);
    const { code } = await res.json();
    const body = await view(code);
    expect(body.asset).toMatchObject({ id: 'printer-3f', name: expect.stringMatching(/Printer/), ticket: { number: expect.stringMatching(/^INC\d{7}$/) } });
    const room = await view((await (await create({ asset: 'room-4b-display' })).json()).code);
    expect(room.asset).toMatchObject({ id: 'room-4b-display', ticket: null });
    expect(room.session.id).not.toBe(code);
  });
  it('rejects unknown or malformed asset ids', async () => {
    for (const asset of ['nope', '../printer-3f', 'printer-3f^ORactive=true', 'x'.repeat(500), 42, null]) {
      const res = await create({ asset });
      expect(res.status, String(asset)).toBe(400);
      expect((await res.json()).error).toBe('unknown_asset');
    }
    expect((await create('{nope')).status).toBe(400);
  });
  it('still starts the session when ServiceNow cannot be checked', async () => {
    vi.stubEnv('SERVICENOW_INSTANCE_URL', 'https://nimbus.service-now.example');
    vi.stubEnv('SERVICENOW_USER', 'u');
    vi.stubEnv('SERVICENOW_PASSWORD', 'p');
    vi.stubEnv('SERVICENOW_CALLER_EMAIL', 'priya@x.example');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    const res = await create({ asset: 'room-4b-display' });
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toMatch(/^https:\/\/nimbus\.service-now\.example\/api\/now\/table\/incident\?/);
    expect((await view((await res.json()).code)).asset).toMatchObject({ id: 'room-4b-display', ticket: null });
  });
});

describe('/api/tools/[name]', () => {
  it('requires the tool secret', async () => {
    const code = await newSession();
    expect((await tool('searchKnowledge', { session_id: code, args: { query: 'vpn' } }, null)).status).toBe(401);
    expect((await tool('searchKnowledge', { session_id: code, args: { query: 'vpn' } }, 'wrong')).status).toBe(401);
  });
  it('runs a tool with the Agora body shape and records the event', async () => {
    const code = await newSession();
    const res = await tool('searchKnowledge', { session_id: code, tool_call_id: 'call_1', args: { query: 'vpn keeps dropping' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.say).toMatch(/GlobalProtect/);
    const state = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(state.events[0]).toMatchObject({ tool: 'searchKnowledge', ok: true });
    expect(state.version).toBe(2);
  });
  it('returns business errors as 422 with a spoken hint', async () => {
    const code = await newSession();
    const res = await tool('checkServiceStatus', { session_id: code, args: { service: 'mainframe' } });
    expect(res.status).toBe(422);
    expect((await res.json()).say).toMatch(/status feed/);
  });
  it('treats missing arguments as malformed', async () => {
    const code = await newSession();
    const res = await tool('searchKnowledge', { session_id: code, args: {} });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('invalid_arguments');
  });
  it('alerts the IT channel once, after the ticket is confirmed', async () => {
    vi.stubEnv('DISCORD_WEBHOOK_URL', 'https://discord.example/api/webhooks/1/abc');
    const posted: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    });
    const code = await newSession();
    const prep = await (await tool('prepareTicket', { session_id: code, args: { summary: 'Dock not charging', urgency: 'low', details: '' } })).json();
    await settleDeliveries();
    expect(posted).toEqual([{ content: 'Waiting for employee: Dock not charging. Waiting for the employee to confirm a low-urgency ticket', allowed_mentions: { parse: [] } }]);
    const first = await tool('confirmAction', { session_id: code, args: { code: prep.data.confirmationCode } });
    expect(first.status).toBe(200);
    expect((await first.json()).say).toMatch(/I-N-C one two zero zero one.*alerting the IT channel/);
    await settleDeliveries();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual({ content: expect.stringMatching(/^New IT ticket INC0012001.*Dock not charging/), allowed_mentions: { parse: [] } });
    const again = await tool('confirmAction', { session_id: code, args: { code: prep.data.confirmationCode } });
    expect(again.status).toBe(200);
    await settleDeliveries();
    expect(posted).toHaveLength(2);
  });
  it('locks down a lost laptop once and shows the checklist, for employees only', async () => {
    vi.stubEnv('DISCORD_WEBHOOK_URL', 'https://discord.example/api/webhooks/1/abc');
    const posted: { content: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    });
    const code = await newSession();
    const args = { what: 'laptop left in an Uber', when: '' };
    expect((await tool('prepareSecurityLockdown', { session_id: code, persona: 'itdesk', args })).status).toBe(403);
    const prep = await (await tool('prepareSecurityLockdown', { session_id: code, args })).json();
    const first = await tool('confirmAction', { session_id: code, args: { code: prep.data.confirmationCode } });
    expect(first.status).toBe(200);
    expect((await first.json()).say).toMatch(/^Done\. Your account is blocked.*I-N-C one two zero zero one\. I'm alerting the IT channel now\./);
    expect((await (await tool('confirmAction', { session_id: code, args: { code: prep.data.confirmationCode } })).json()).data).toMatchObject({ alreadyDone: true });
    await settleDeliveries();
    expect(posted.map((p) => p.content)).toEqual([expect.stringMatching(/^Security lockdown for Priya Sharma .*P1 incident INC0012001\. All steps done/)]);
    const state = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(state.account).toMatchObject({ locked: true, factors: [] });
    expect(state.lockdown).toMatchObject({ incident: 'INC0012001', steps: expect.arrayContaining([{ step: 'alert', status: 'ok' }]) });
    expect(state.lockdown.steps.every((s: { status: string }) => s.status === 'ok')).toBe(true);
  });
  it('records a failed IT channel alert without leaking the webhook', async () => {
    vi.stubEnv('SLACK_WEBHOOK_URL', 'https://hooks.slack.example/services/T/B/x');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('down', { status: 503 }));
    const code = await newSession();
    const prep = await (await tool('prepareTicket', { session_id: code, args: { summary: 'Dock', urgency: 'low', details: '' } })).json();
    const res = await tool('confirmAction', { session_id: code, args: { code: prep.data.confirmationCode } });
    expect(res.status).toBe(200);
    await settleDeliveries();
    const state = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(state.notifications.map((n: { status: string }) => n.status)).toEqual(['failed', 'failed']);
    expect(state.notifications[0]).toMatchObject({ error: 'The Slack webhook is having problems right now.' });
    expect(JSON.stringify(state)).not.toMatch(/hooks\.slack/);
  });
  it('handles concurrent calls on one session without losing any', async () => {
    const code = await newSession();
    const calls = [
      tool('followOutage', { session_id: code, args: { incident: '' } }),
      tool('startTroubleshooting', { session_id: code, args: { articleId: 'vpn', issue: '' } }),
      tool('verifyIdentity', { session_id: code, args: {} }),
      tool('searchKnowledge', { session_id: code, args: { query: 'printer' } }),
    ];
    expect((await Promise.all(calls)).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const state = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(state.events).toHaveLength(4);
    expect(state.verification.simulatedInbox.code).toMatch(/^\d{6}$/);
  });
  it('gates tools by the persona the call was started with', async () => {
    const code = await newSession();
    const args = { priority: 'critical', state: '', assignee: '', group: '', category: '', opened: '', keyword: '', sort: '', limit: '' };
    expect((await tool('listQueue', { session_id: code, args })).status).toBe(403);
    const blocked = await tool('listQueue', { session_id: code, persona: 'employee', args });
    expect(await blocked.json()).toMatchObject({ ok: false, error: 'not_available', say: "I can't do that in this call." });
    const ok = await tool('listQueue', { session_id: code, persona: 'itdesk', args });
    expect(ok.status).toBe(200);
    expect((await ok.json()).say).toBe("Here are 3 critical incidents, 2 unassigned. They're on your screen. Want details on any of them?");
    expect((await tool('checkServiceStatus', { session_id: code, persona: 'itdesk', args: { service: 'vpn' } })).status).toBe(403);
    const state = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(state.itdesk.queue).toHaveLength(3);
    expect(JSON.stringify(state.itdesk)).not.toMatch(/sysId|sim-/);
  });
  it('handles unknown sessions, unknown tools and bad JSON', async () => {
    const code = await newSession();
    const gone = await tool('searchKnowledge', { session_id: 'ZZZ-ZZZ', args: { query: 'vpn' } });
    expect(gone.status).toBe(404);
    expect((await gone.json()).say).toMatch(/session/i);
    expect((await tool('launchRocket', { session_id: code, args: {} })).status).toBe(404);
    expect((await tool('searchKnowledge', '{not json')).status).toBe(400);
  });
  it('answers 400 to a JSON body that is not an object on every session route', async () => {
    const code = await newSession();
    expect((await tool('searchKnowledge', 'null')).status).toBe(400);
    expect((await inviteRoute(json('http://localhost/api/invite-agent', 'null'))).status).toBe(400);
    expect((await stopRoute(json('http://localhost/api/stop-conversation', 'null'))).status).toBe(400);
    expect((await followUpPost(json('http://localhost/api/followup', 'null'))).status).toBe(400);
    const state = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(state.events).toEqual([]);
  });
});

describe('/api/mcp', () => {
  const rpc = (code: string, body: unknown, secret: string | null = SECRET) =>
    mcpRoute(json(`http://localhost/api/mcp?session=${code}`, body, secret === null ? {} : { 'x-tool-secret': secret }));

  it('speaks JSON-RPC: initialize, tools/list, tools/call with content', async () => {
    const code = await newSession();
    const init = await (await rpc(code, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.serverInfo.name).toBe('ask-it');
    expect((await rpc(code, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

    const list = await (await rpc(code, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    expect(list.result.tools).toHaveLength(toolsFor('employee').length);
    const desk = await (await mcpRoute(json(`http://localhost/api/mcp?session=${code}&persona=itdesk`, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, { 'x-tool-secret': SECRET }))).json();
    expect(desk.result.tools.map((t: { name: string }) => t.name)).toContain('listQueue');
    expect(desk.result.tools).toHaveLength(12);
    expect(list.result.tools[0]).toHaveProperty('inputSchema');

    const call = await (await rpc(code, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'listMyTickets', arguments: { status: '' } } })).json();
    expect(call.result.isError).toBe(false);
    expect(call.result.content[0].type).toBe('text');
    expect(JSON.parse(call.result.content[0].text).ok).toBe(true);

    const bad = await (await rpc(code, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'addTicketNote', arguments: { ticket: 'ticket 99999', note: 'x' } } })).json();
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/can't find ticket/);

    const unknown = await (await rpc(code, { jsonrpc: '2.0', id: 5, method: 'resources/list' })).json();
    expect(unknown.error.code).toBe(-32601);
  });
  it('requires the secret and a session', async () => {
    const code = await newSession();
    expect((await rpc(code, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)).status).toBe(401);
    const noSession = await (await rpc('ZZZ-ZZZ', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'listMyTickets', arguments: { status: '' } } })).json();
    expect(noSession.result.isError).toBe(true);
    expect((await mcpGet()).status).toBe(405);
  });
});

describe('/api/invite-agent', () => {
  function mockAgora() {
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      if (url.includes('/join')) {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ agent_id: 'agent-abc', create_ts: 1, status: 'RUNNING' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { bodies, urls };
  }
  const invite = (code: string, extra: Record<string, unknown> = {}) =>
    inviteRoute(json('http://localhost/api/invite-agent', { requester_id: '4321', channel_name: 'ch-1', session: code, ...extra }));

  it('starts the agent with Murf Falcon, managed gpt-4o-mini and HTTP tools', async () => {
    const { bodies } = mockAgora();
    const code = await newSession();
    const res = await invite(code);
    expect(res.status).toBe(200);
    expect((await res.json()).agent_id).toBe('agent-abc');
    const sent = bodies[0] as { preset?: string; properties: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const p = sent.properties;
    expect(p.tts).toMatchObject({ vendor: 'murf', params: { api_key: 'murf-test-key', model: 'FALCON', voiceId: 'Aarav', locale: 'en-IN', sample_rate: 24000 }, skip_patterns: [4, 5] });
    expect(sent.preset).toMatch(/openai_gpt_4o_mini/);
    expect(p.llm.api_key).toBeUndefined();
    expect(p.llm.template_variables).toEqual({ session_id: code, persona: 'employee' });
    expect(p.llm.tools).toHaveLength(toolsFor('employee').length);
    expect(p.llm.tools[0].server.url).toMatch(/^https:\/\/askit\.example\.com\/api\/tools\//);
    expect(p.llm.greeting_message).toMatch(/^Hi Priya, this is ASK IT.*SAP Concur/);
    expect(p.llm.system_messages[0].content).toMatch(/^You are ASK IT/);
    expect(p.llm.failure_message).toBeTruthy();
    expect(p.advanced_features).toMatchObject({ enable_rtm: true, enable_tools: true });
    expect(p.remote_rtc_uids).toEqual(['4321']);
    expect(p.idle_timeout).toBe(30);
    expect(p.turn_detection.config.start_of_speech.vad_config.speaking_interrupt_duration_ms).toBe(600);
    expect(p.interruption).toBeUndefined();
    expect(p.sal).toBeUndefined();
    // Off by default: with Murf, a filler phrase during a tool call left the answer after the tool unspoken.
    expect(p.filler_words).toBeUndefined();

    const state = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(state.call).toMatchObject({ active: true, agentId: 'agent-abc' });
  });
  it('starts the IT desk persona with its own prompt, tools and template variable', async () => {
    const { bodies } = mockAgora();
    const code = await newSession();
    expect((await invite(code, { persona: 'itdesk' })).status).toBe(200);
    const p = (bodies[0] as { properties: Record<string, any> }).properties; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(p.llm.template_variables).toEqual({ session_id: code, persona: 'itdesk' });
    expect(p.llm.tools.map((t: { function: { name: string } }) => t.function.name).sort()).toEqual(['cancelAction', 'confirmAction', 'countIncidents', 'generateReport', 'listQueue', 'listResources', 'openIncident', 'prepareIncidentUpdate', 'requestUpdate', 'showDashboard', 'showImpact', 'showResource']);
    expect(p.llm.tools[0].server.body.persona).toBe('{{template_variables.persona}}');
    expect(p.llm.system_messages[0].content).toMatch(/^You are ASK IT on the Nimbus Labs IT desk/);
    expect(p.llm.greeting_message).toMatch(/^Hi, I'm your IT Admin voice agent/);
    const state = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(state.call).toMatchObject({ active: true, persona: 'itdesk' });
  });
  it('greets a scanned device with its context', async () => {
    const { bodies } = mockAgora();
    const code = ((await (await createSessionRoute(json('http://localhost/api/session', { asset: 'room-4b-display' }))).json()) as { code: string }).code;
    expect((await invite(code)).status).toBe(200);
    const p = (bodies[0] as { properties: Record<string, any> }).properties; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(p.llm.greeting_message).toBe("Hi Priya, this is ASK IT. You're at meeting room 4B's display. What's going wrong?");
    expect(p.llm.system_messages[0].content).toMatch(/This call\n- Priya scanned the QR sticker on Meeting room 4B display/);
  });
  it('refuses an unknown persona', async () => {
    mockAgora();
    const code = await newSession();
    const res = await invite(code, { persona: 'admin' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/persona/);
  });
  it('blocks a second concurrent call unless taking over', async () => {
    mockAgora();
    const code = await newSession();
    expect((await invite(code)).status).toBe(200);
    const second = await invite(code);
    expect(second.status).toBe(409);
    expect((await invite(code, { takeover: true })).status).toBe(200);
  });
  it('refuses without a public https base URL', async () => {
    const { urls } = mockAgora();
    vi.stubEnv('PUBLIC_BASE_URL', 'http://localhost:3000');
    const code = await newSession();
    const res = await invite(code);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/https/i);
    expect(urls).toHaveLength(0);
  });
  it('explains missing configuration', async () => {
    vi.stubEnv('MURF_API_KEY', '');
    const code = await newSession();
    const res = await invite(code);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.missing).toEqual(['MURF_API_KEY']);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
  it('validates input and session', async () => {
    mockAgora();
    expect((await inviteRoute(json('http://localhost/api/invite-agent', { session: 'ZZZ-ZZZ' }))).status).toBe(400);
    expect((await invite('ZZZ-ZZZ')).status).toBe(404);
  });
  it('reports agent start failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ detail: 'bad tts', reason: 'InvalidRequest' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const code = await newSession();
    const res = await invite(code);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBeTruthy();
    const state = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(state.call.active).toBe(false);
  });
});

describe('/api/intro', () => {
  function agora(speakStatus = 200) {
    const calls: { url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const raw = input instanceof Request ? await input.clone().text() : typeof init?.body === 'string' ? init.body : '';
      calls.push({ url, body: raw ? JSON.parse(raw) : null });
      if (url.includes('/join')) return new Response(JSON.stringify({ agent_id: 'agent-it' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: speakStatus, headers: { 'content-type': 'application/json' } });
    });
    return calls;
  }
  const intro = (session: string) => introRoute(json('http://localhost/api/intro', { session }));

  it('has the IT desk agent say the intro once, only while nothing else is being said', async () => {
    const calls = agora();
    const code = await newSession();
    await inviteRoute(json('http://localhost/api/invite-agent', { requester_id: '1', channel_name: 'c', session: code, persona: 'itdesk' }));
    const res = await intro(code);
    expect(res.status).toBe(200);
    const speak = calls.filter((c) => c.url.includes('/agents/agent-it/speak'));
    expect(speak).toHaveLength(1);
    expect(speak[0].body).toMatchObject({ text: IT_INTRO, priority: 'IGNORE', interruptable: true });
    expect(await (await intro(code)).json()).toMatchObject({ state: 'already' });
    expect(calls.filter((c) => c.url.includes('/speak'))).toHaveLength(1);
  });
  it('does nothing without a live IT desk call', async () => {
    const calls = agora();
    const code = await newSession();
    expect((await intro(code)).status).toBe(409);
    await inviteRoute(json('http://localhost/api/invite-agent', { requester_id: '1', channel_name: 'c', session: code }));
    expect((await intro(code)).status).toBe(409);
    expect(calls.some((c) => c.url.includes('/speak'))).toBe(false);
  });
  it('rejects bad input and unknown sessions', async () => {
    agora();
    expect((await introRoute(json('http://localhost/api/intro', 'null'))).status).toBe(400);
    expect((await intro('nope')).status).toBe(400);
    expect((await intro('ZZZ-ZZZ')).status).toBe(404);
  });
  it('reports a failed broadcast and never retries it', async () => {
    const calls = agora(500);
    const code = await newSession();
    await inviteRoute(json('http://localhost/api/invite-agent', { requester_id: '1', channel_name: 'c', session: code, persona: 'itdesk' }));
    expect((await intro(code)).status).toBe(502);
    expect(await (await intro(code)).json()).toMatchObject({ state: 'already' });
    expect(calls.filter((c) => c.url.includes('/speak')).length).toBeGreaterThanOrEqual(1);
  });
});

describe('/api/stop-conversation', () => {
  it('stops the agent and marks the call ended (idempotent)', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.includes('/join')) return new Response(JSON.stringify({ agent_id: 'agent-xyz' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ detail: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    });
    const code = await newSession();
    await inviteRoute(json('http://localhost/api/invite-agent', { requester_id: '1', channel_name: 'c', session: code }));
    const res = await stopRoute(json('http://localhost/api/stop-conversation', { agent_id: 'agent-xyz', session: code, reason: 'user ended' }));
    expect(res.status).toBe(200);
    expect(calls.some((u) => u.includes('agent-xyz'))).toBe(true);
    const state = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(state.call).toMatchObject({ active: false, endReason: 'user ended' });
    // sendBeacon posts text/plain
    const beacon = await stopRoute(new NextRequest('http://localhost/api/stop-conversation', { method: 'POST', body: JSON.stringify({ session: code }), headers: { 'content-type': 'text/plain' } }));
    expect(beacon.status).toBe(200);
  });
  it('leaves a call that took over alone when the old tab stops its own agent', async () => {
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/join')) return new Response(JSON.stringify({ agent_id: `agent-${++n}` }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ detail: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    });
    const code = await newSession();
    const start = (takeover: boolean) => inviteRoute(json('http://localhost/api/invite-agent', { requester_id: '1', channel_name: 'c', session: code, takeover }));
    expect((await start(false)).status).toBe(200);
    expect((await start(true)).status).toBe(200);
    // The first tab sees its agent leave and stops it.
    expect((await stopRoute(json('http://localhost/api/stop-conversation', { agent_id: 'agent-1', session: code, reason: 'agent left' }))).status).toBe(200);
    const state = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(state.call).toMatchObject({ active: true, agentId: 'agent-2' });
    await stopRoute(json('http://localhost/api/stop-conversation', { agent_id: 'agent-2', session: code, reason: 'user ended' }));
    const ended = await (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
    expect(ended.call).toMatchObject({ active: false, endReason: 'user ended' });
  });
});

describe('/api/generate-agora-token', () => {
  it('issues an RTC+RTM token', async () => {
    const res = await tokenRoute(new NextRequest('http://localhost/api/generate-agora-token?uid=4321&channel=test-channel'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ uid: '4321', channel: 'test-channel', token: expect.any(String) });
  });
});

describe('/api/invite-agent interruption options', () => {
  it('sends keyword interruption when configured', async () => {
    const bodies: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes('/join')) bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ agent_id: 'agent-k' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubEnv('AGENT_INTERRUPT_KEYWORDS', 'stop,wait');
    vi.stubEnv('AGENT_INTERRUPT_MS', '900');
    vi.stubEnv('AGENT_SPEAKER_LOCK', 'true');
    const code = await newSession();
    expect((await inviteRoute(json('http://localhost/api/invite-agent', { requester_id: '1', channel_name: 'c', session: code }))).status).toBe(200);
    const p = bodies[0].properties;
    expect(p.interruption).toEqual({ enable: true, mode: 'keywords', keywords_config: { trigger_keywords: ['stop', 'wait'] } });
    expect(p.turn_detection.config.start_of_speech.vad_config.speaking_interrupt_duration_ms).toBe(900);
    expect(p.sal).toEqual({ sal_mode: 'locking' });
    expect(p.advanced_features.enable_sal).toBe(true);
  });

  it('sends filler words only when AGENT_FILLER_WORDS=on', async () => {
    const bodies: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes('/join')) bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ agent_id: 'agent-f' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubEnv('AGENT_FILLER_WORDS', 'on');
    const code = await newSession();
    expect((await inviteRoute(json('http://localhost/api/invite-agent', { requester_id: '1', channel_name: 'c', session: code }))).status).toBe(200);
    expect(bodies[0].properties.filler_words).toMatchObject({
      enable: true,
      trigger: { mode: 'fixed_time', fixed_time_config: { response_wait_ms: 1500 } },
      content: { mode: 'static', static_config: { phrases: ['One moment.', 'Checking that now.', 'Let me look that up.'] } },
    });
  });
});
