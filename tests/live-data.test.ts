import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as createSessionRoute } from '@/app/api/session/route';
import { GET as stateRoute } from '@/app/api/state/route';
import { POST as inviteRoute } from '@/app/api/invite-agent/route';
import { applyAccountRead, applyOutageRead } from '@/lib/domain/sync';
import { buildSessionView } from '@/lib/domain/view';
import { MINUTE } from '@/lib/domain/time';
import type { SessionState } from '@/lib/domain/types';
import { failure, success } from '@/lib/integrations/http';
import type { AccountInfo, DeskIncident } from '@/lib/integrations/types';
import { seedOptions } from '@/lib/server/deps';
import { createSession, loadSession, updateSession } from '@/lib/server/session';
import { MemoryStore } from '@/lib/server/store';
import { syncLive, type LiveSources } from '@/lib/server/sync';
import { NOW, call, confirmed, freshState } from './helpers';

const LIVE_SEED = { tickets: 'live', liveIdentity: { email: 'priya@nimbus.example' } } as const;
const LIVE_MODES = { tickets: 'live', identity: 'live', notify: 'live', status: 'live' } as const;
// Ids and texts that only exist in the simulated seed.
const DEMO = /INC00119\d\d|INC00130\d\d|sim-|Figma licence|Outlook calendar not syncing|SAP Concur expense submissions failing|"affected":14|auth0\|sim/;

const AUTH0_USER: AccountInfo = { userId: 'auth0|priya', email: 'priya@nimbus.example', locked: false, lastPasswordReset: NOW - 10 * 86_400_000, factors: ['email'], factorsKnown: true };
const INCIDENT: DeskIncident = {
  number: 'INC0010002',
  sysId: '0123456789abcdef0123456789abcdef',
  summary: 'SAP Concur outage',
  priority: 1,
  priorityLabel: 'Critical',
  state: '2',
  stateLabel: 'In Progress',
  holdReason: null,
  assignee: null,
  group: null,
  caller: 'Fred Luddy',
  category: 'software',
  urgency: 1,
  impact: 1,
  openedAt: NOW - 3 * 60 * MINUTE,
};

describe('live seed', () => {
  it('starts with no invented account facts, tickets, backlog or outage', () => {
    const s = freshState(NOW, LIVE_SEED);
    expect(s.account).toEqual({ email: 'priya@nimbus.example', userId: null, locked: null, lastPasswordReset: null, factors: [], factorsKnown: false, source: 'live', checkedAt: null });
    expect(s.tickets).toEqual([]);
    expect(s.itdesk.backlog).toEqual([]);
    expect(s.outages).toEqual([]);
  });
  it('shows no simulated ids, numbers or texts anywhere in the session view', () => {
    const v = buildSessionView(freshState(NOW, LIVE_SEED), NOW, 1, LIVE_MODES);
    expect(JSON.stringify(v)).not.toMatch(DEMO);
    expect(v.topIssues).toEqual([]);
    expect(v.kpis).toMatchObject({ resolvedByAgent: 0, ticketsRaised: 0, duplicatesAvoided: 0, toolCalls: 0, deflectionRate: null });
  });
  it('keeps the simulated seed unchanged without credentials', () => {
    const s = freshState();
    expect(s.account).toMatchObject({ userId: 'auth0|sim-priya', locked: true, factors: ['otp'], factorsKnown: true, source: 'simulated' });
    expect(s.outages).toEqual([expect.objectContaining({ incident: 'INC0011950', title: 'SAP Concur expense submissions failing', affected: 14 })]);
  });
  it('takes the live account address from the Auth0 settings', () => {
    const A0 = { AUTH0_DOMAIN: 'x.auth0.example', AUTH0_CLIENT_ID: 'a', AUTH0_CLIENT_SECRET: 'b', AUTH0_OTP_CLIENT_ID: 'c', AUTH0_OTP_CLIENT_SECRET: 'd', AUTH0_USER_EMAIL: ' priya@nimbus.example ' };
    expect(seedOptions(A0)).toEqual({ tickets: 'simulated', liveIdentity: { email: 'priya@nimbus.example' } });
    expect(seedOptions({})).toEqual({ tickets: 'simulated' });
  });
});

describe('account read from Auth0', () => {
  const unknown = () => freshState(NOW, LIVE_SEED);
  it('applies what Auth0 says', () => {
    const s = applyAccountRead(unknown(), success(AUTH0_USER), NOW);
    expect(s.account).toEqual({ ...AUTH0_USER, source: 'live', checkedAt: NOW });
  });
  it('marks a failed or slow first read as unreadable, inventing nothing', () => {
    for (const read of [failure<AccountInfo>({ kind: 'timeout' }), null]) {
      const s = applyAccountRead(unknown(), read, NOW);
      expect(s.account).toMatchObject({ locked: null, factors: [], factorsKnown: false, lastPasswordReset: null, readFailed: true, checkedAt: null });
    }
  });
  it('keeps the last real read when a later one fails, and writes nothing twice', () => {
    const known = applyAccountRead(unknown(), success(AUTH0_USER), NOW);
    expect(applyAccountRead(known, failure({ kind: 'unavailable' }), NOW + MINUTE)).toBe(known);
    const failed = applyAccountRead(unknown(), null, NOW);
    expect(applyAccountRead(failed, null, NOW + MINUTE)).toBe(failed);
  });
});

describe('outage read from ServiceNow', () => {
  const live = () => freshState(NOW, LIVE_SEED);
  it('takes the title and start time from the incident, and claims no affected count', () => {
    const s = applyOutageRead(live(), 'INC0010002', success(INCIDENT));
    expect(s.outages).toEqual([{ id: 'OUT-1', service: 'concur', title: 'SAP Concur outage', incident: 'INC0010002', affected: null, since: INCIDENT.openedAt, followed: false }]);
  });
  it('keeps an incident whose text names no internal service, tied to no service', () => {
    const s = applyOutageRead(live(), 'INC0010002', success({ ...INCIDENT, summary: 'Payroll export failing' }));
    expect(s.outages[0]).toMatchObject({ service: '', title: 'Payroll export failing' });
  });
  it('has no outage when the incident is closed or missing, unless she already follows it', () => {
    const open = applyOutageRead(live(), 'INC0010002', success(INCIDENT));
    expect(applyOutageRead(open, 'INC0010002', success({ ...INCIDENT, state: '6' })).outages).toEqual([]);
    expect(applyOutageRead(open, 'INC0010002', success(null)).outages).toEqual([]);
    const followed = structuredClone(open);
    followed.outages[0].followed = true;
    expect(applyOutageRead(followed, 'INC0010002', success({ ...INCIDENT, state: '7' })).outages).toEqual(followed.outages);
  });
  it('invents nothing when ServiceNow is down, and keeps what it said last', () => {
    expect(applyOutageRead(live(), 'INC0010002', failure({ kind: 'unavailable' })).outages).toEqual([]);
    expect(applyOutageRead(live(), 'INC0010002', null).outages).toEqual([]);
    const open = applyOutageRead(live(), 'INC0010002', success(INCIDENT));
    expect(applyOutageRead(open, 'INC0010002', failure({ kind: 'timeout' }))).toBe(open);
    expect(applyOutageRead(open, 'INC0010002', success(INCIDENT))).toBe(open);
  });
  it('updates the title and keeps her follow when the incident changes', () => {
    const open = applyOutageRead(live(), 'INC0010002', success(INCIDENT));
    open.outages[0].followed = true;
    const s = applyOutageRead(open, 'INC0010002', success({ ...INCIDENT, summary: 'SAP Concur outage, fix rolling out' }));
    expect(s.outages[0]).toMatchObject({ title: 'SAP Concur outage, fix rolling out', followed: true });
  });
});

describe('tools with live outage and account', () => {
  const withOutage = () => applyOutageRead(freshState(NOW, LIVE_SEED), 'INC0010002', success(INCIDENT));
  it('says the ServiceNow title and never a made-up affected count', async () => {
    const out = await call(withOutage(), 'checkServiceStatus', { service: 'concur' });
    expect(out.result.say).toBe("Yes, there's a known outage: SAP Concur outage. IT is tracking it as I-N-C one zero zero zero two. I can add you to that incident instead of raising a duplicate ticket.");
    expect(out.result.data).toMatchObject({ incident: 'INC0010002', affected: null });
  });
  it('joins the outage without counting people it cannot count', async () => {
    const out = await confirmed(withOutage(), 'followOutage', { incident: '' }, { tickets: { addNote: async () => success(null) } });
    expect(out.state.outages[0]).toMatchObject({ followed: true, affected: null });
    const wrap = await call(out.state, 'wrapUpCall');
    expect(JSON.stringify(wrap.state.documents)).not.toMatch(/null affected|undefined/);
  });
  it('names an outage tied to no service by its title', async () => {
    const s = applyOutageRead(freshState(NOW, LIVE_SEED), 'INC0010002', success({ ...INCIDENT, summary: 'Payroll export failing' }));
    const prep = await call(s, 'followOutage', { incident: '' });
    expect(prep.result.say).toBe('Shall I add you to the Payroll export failing outage, I-N-C one zero zero zero two, as affected?');
  });
  it('reads the account from Auth0 when the session does not know it yet', async () => {
    const getUser = vi.fn(async () => success(AUTH0_USER));
    const out = await call(freshState(NOW, LIVE_SEED), 'getAccountStatus', {}, { identity: { mode: 'live', getUser } });
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(out.result.say).toMatch(/^Your account is active and not locked\./);
    expect(out.state.account).toMatchObject({ locked: false, source: 'live', checkedAt: NOW });
  });
  it('says plainly that it could not read an unknown account, without guessing', async () => {
    const out = await call(freshState(NOW, LIVE_SEED), 'getAccountStatus', {}, { identity: { mode: 'live', getUser: async () => failure({ kind: 'timeout' }) } });
    expect(out.result.ok).toBe(false);
    expect(out.result.say).not.toMatch(/locked|active/i);
    expect(out.state.account.locked).toBeNull();
  });
});

describe('syncLive', () => {
  async function liveSession(seed: Parameters<typeof createSession>[2] = LIVE_SEED) {
    const store = new MemoryStore();
    return { store, code: await createSession(store, NOW, seed) };
  }
  const sources = (o: Partial<LiveSources>) => () => o as LiveSources;

  it('reads her account and the outage incident in parallel and stores them', async () => {
    const { store, code } = await liveSession();
    const read = vi.fn(async () => success(INCIDENT));
    const s = await syncLive(store, code, NOW, sources({ account: async () => success(AUTH0_USER), outage: { number: 'INC0010002', read } }));
    expect(s?.account).toMatchObject({ locked: false, factors: ['email'], source: 'live' });
    expect(s?.outages.map((o) => o.title)).toEqual(['SAP Concur outage']);
    expect((await loadSession(store, code))!.state).toEqual(s);
  });
  it('records an unreadable account and no outage when both systems fail', async () => {
    const { store, code } = await liveSession();
    const s = await syncLive(store, code, NOW, sources({ account: async () => failure({ kind: 'unavailable' }), outage: { number: 'INC0010002', read: async () => failure({ kind: 'unavailable' }) } }));
    expect(s?.account).toMatchObject({ locked: null, readFailed: true });
    expect(s?.outages).toEqual([]);
    expect(JSON.stringify(buildSessionView(s!, NOW, 2, LIVE_MODES))).not.toMatch(DEMO);
  });
  it('gives up after 2.5 seconds and marks the account unreadable', async () => {
    vi.useFakeTimers();
    try {
      const { store, code } = await liveSession();
      const pending = syncLive(store, code, NOW, sources({ account: () => new Promise<never>(() => {}), outage: { number: 'INC0010002', read: () => new Promise<never>(() => {}) } }));
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(2_400);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect((await pending)?.account).toMatchObject({ locked: null, readFailed: true });
    } finally {
      vi.useRealTimers();
    }
  });
  it('treats a throwing reader as a failed read', async () => {
    const { store, code } = await liveSession();
    const s = await syncLive(store, code, NOW, sources({ account: async () => Promise.reject(new Error('boom')) }));
    expect(s?.account).toMatchObject({ locked: null, readFailed: true });
  });
  it('reads nothing in simulated mode and leaves the session as it was', async () => {
    const { store, code } = await liveSession({ tickets: 'simulated' });
    const before = await loadSession(store, code);
    const s = await syncLive(store, code, NOW, sources({}));
    expect(s).toEqual(before!.state);
    expect((await loadSession(store, code))!.version).toBe(before!.version);
    expect(await syncLive(store, 'ZZZ-ZZZ', NOW, sources({}))).toBeNull();
  });
  it('keeps the last known account when a later read fails', async () => {
    const { store, code } = await liveSession();
    await syncLive(store, code, NOW, sources({ account: async () => success({ ...AUTH0_USER, locked: true }) }));
    await updateSession(store, code, (s: SessionState) => ({ state: { ...s, account: { ...s.account, factors: [] } } }));
    const s = await syncLive(store, code, NOW + MINUTE, sources({ account: async () => failure({ kind: 'timeout' }) }));
    expect(s?.account).toMatchObject({ locked: true, factors: [] });
    expect(s?.account.readFailed).toBeUndefined();
  });
});

describe('live routes', () => {
  const ENV = {
    NEXT_PUBLIC_AGORA_APP_ID: '0123456789abcdef0123456789abcdef',
    NEXT_AGORA_APP_CERTIFICATE: 'fedcba9876543210fedcba9876543210',
    MURF_API_KEY: 'murf-test-key',
    TOOL_SECRET: 'test-tool-secret-value',
    PUBLIC_BASE_URL: 'https://askit.example.com',
    SERVICENOW_INSTANCE_URL: 'https://nimbus.service-now.example',
    SERVICENOW_USER: 'u',
    SERVICENOW_PASSWORD: 'p',
    SERVICENOW_CALLER_EMAIL: 'priya@nimbus.example',
    SERVICENOW_OUTAGE_INCIDENT: 'INC0010002',
    AUTH0_CLIENT_ID: 'a',
    AUTH0_CLIENT_SECRET: 'b',
    AUTH0_OTP_CLIENT_ID: 'c',
    AUTH0_OTP_CLIENT_SECRET: 'd',
    AUTH0_USER_EMAIL: 'priya@nimbus.example',
  };
  let domain = 0;
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    // A fresh Auth0 domain per test, so no management token is cached between them.
    vi.stubEnv('AUTH0_DOMAIN', `t${++domain}.auth0.example`);
    for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'SLACK_BOT_TOKEN']) vi.stubEnv(k, '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const cell = (value: string, display = value) => ({ value, display_value: display });
  const row = (i: DeskIncident) => ({
    number: cell(i.number),
    sys_id: cell(i.sysId),
    short_description: cell(i.summary),
    priority: cell(String(i.priority), '1 - Critical'),
    state: cell(i.state, i.stateLabel),
    urgency: cell('1'),
    impact: cell('1'),
    opened_at: cell(new Date(i.openedAt!).toISOString().slice(0, 19).replace('T', ' ')),
  });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  // Auth0 and ServiceNow as the session sees them; `blocked` and `summary` can change between reads.
  function systems(o: { auth0?: 'down'; servicenow?: 'down' } = {}) {
    const live = { blocked: false, summary: INCIDENT.summary };
    const urls: string[] = [];
    const bodies: { properties: { llm: { greeting_message: string } } }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      if (url.includes('/join')) {
        bodies.push(JSON.parse(String(init?.body)));
        return ok({ agent_id: 'agent-abc', create_ts: 1, status: 'RUNNING' });
      }
      if (url.includes('auth0.example')) {
        if (o.auth0 === 'down') return new Response('{}', { status: 503 });
        if (url.endsWith('/oauth/token')) return ok({ access_token: 'mgmt', expires_in: 86400 });
        if (url.includes('/users-by-email')) return ok([{ user_id: 'auth0|priya', email: 'priya@nimbus.example', blocked: live.blocked, identities: [{ connection: 'Username-Password-Authentication' }] }]);
        if (url.includes('/authentication-methods')) return ok([{ type: 'email' }]);
        if (url.includes('/user-blocks/')) return ok({ blocked_for: [] });
      }
      if (url.includes('service-now.example')) {
        if (o.servicenow === 'down') return new Response('{}', { status: 503 });
        if (url.includes('/api/now/table/incident?') && url.includes('INC0010002')) return ok({ result: [row({ ...INCIDENT, summary: live.summary })] });
        return ok({ result: [] });
      }
      return ok({});
    });
    return { live, urls, bodies };
  }

  const newSession = async () => {
    const res = await createSessionRoute();
    expect(res.status).toBe(201);
    return ((await res.json()) as { code: string }).code;
  };
  const view = async (code: string) => (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
  const invite = (code: string) =>
    inviteRoute(new NextRequest('http://localhost/api/invite-agent', { method: 'POST', body: JSON.stringify({ requester_id: '4321', channel_name: 'ch-1', session: code }), headers: { 'content-type': 'application/json' } }));

  it('loads the account from Auth0 and the outage from ServiceNow when the session is created', async () => {
    const { urls } = systems();
    const body = await view(await newSession());
    expect(urls.some((u) => u.includes('/users-by-email'))).toBe(true);
    expect(body.account).toMatchObject({ locked: false, factors: ['email'], factorsKnown: true, source: 'live', checkedAt: expect.any(Number) });
    expect(body.outages).toEqual([expect.objectContaining({ incident: 'INC0010002', title: 'SAP Concur outage', affected: null })]);
    expect(body.integrations).toMatchObject({ tickets: 'live', identity: 'live' });
    expect(JSON.stringify(body)).not.toMatch(DEMO);
  });
  it('still creates the session when both systems are down, showing nothing invented', async () => {
    systems({ auth0: 'down', servicenow: 'down' });
    const body = await view(await newSession());
    expect(body.account).toMatchObject({ locked: null, factors: [], factorsKnown: false, lastPasswordReset: null, readFailed: true, source: 'live' });
    expect(body.outages).toEqual([]);
    expect(body.tickets).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(DEMO);
  });
  it('reads both again right before a call, so the greeting and the account are current', async () => {
    const sys = systems();
    const code = await newSession();
    sys.live.blocked = true;
    sys.live.summary = 'SAP Concur outage, fix rolling out';
    expect((await invite(code)).status).toBe(200);
    expect(sys.bodies[0].properties.llm.greeting_message).toMatch(/Heads-up: SAP Concur outage, fix rolling out right now/);
    const body = await view(code);
    expect(body.account.locked).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(DEMO);
  });
});
