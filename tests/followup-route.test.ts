import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as followUpGet, POST as followUpPost } from '@/app/api/followup/route';
import { POST as createSessionRoute } from '@/app/api/session/route';
import { GET as stateRoute } from '@/app/api/state/route';
import { POST as inviteRoute } from '@/app/api/invite-agent/route';
import { SNOOZE_MS } from '@/lib/domain/followup';
import { MINUTE } from '@/lib/domain/time';
import type { FollowUp } from '@/lib/domain/types';
import { failure, success } from '@/lib/integrations/http';
import type { RemoteTicket, TicketAdapter } from '@/lib/integrations/types';
import { checkFollowUps, refreshTickets } from '@/lib/server/followup';
import { createSession, loadSession, updateSession } from '@/lib/server/session';
import { MemoryStore, getStore } from '@/lib/server/store';
import { NOW } from './helpers';

const VPN: RemoteTicket = { number: 'INC0010013', sysId: 'sn-13', summary: 'GlobalProtect VPN not connecting', state: 'In Progress', urgency: 2, createdAt: NOW - 60 * MINUTE, updatedAt: NOW - 50 * MINUTE };
const resolved = (t: RemoteTicket, at = NOW): RemoteTicket => ({ ...t, state: 'Resolved', updatedAt: at });

function fakeTickets(rows: () => RemoteTicket[] | 'down') {
  const listMine = vi.fn(async () => {
    const r = rows();
    return r === 'down' ? failure<RemoteTicket[]>({ kind: 'timeout' }) : success(r);
  });
  return { listMine, make: () => ({ mode: 'live', listMine }) as unknown as TicketAdapter };
}

async function liveSession() {
  let clock = NOW;
  const store = new MemoryStore(() => clock);
  const code = await createSession(store, NOW, { tickets: 'live' });
  return { store, code, tick: (ms: number) => (clock += ms), at: () => clock };
}

describe('follow-up check', () => {
  it('rings once ServiceNow shows a ticket it last saw open as resolved', async () => {
    const { store, code, tick, at } = await liveSession();
    let rows: RemoteTicket[] = [VPN];
    const t = fakeTickets(() => rows);
    expect((await checkFollowUps(store, code, at(), t.make))?.followUp).toBeNull();
    rows = [resolved(VPN)];
    tick(15_000);
    expect((await checkFollowUps(store, code, at(), t.make))?.followUp).toMatchObject({ number: 'INC0010013', summary: 'GlobalProtect VPN not connecting', status: 'ringing' });
    expect(t.listMine).toHaveBeenCalledTimes(2);
  });
  it('lists ServiceNow at most once per 15 seconds per session, shared by every tab', async () => {
    const { store, code, tick, at } = await liveSession();
    const t = fakeTickets(() => [VPN]);
    await Promise.all([checkFollowUps(store, code, at(), t.make), checkFollowUps(store, code, at(), t.make)]);
    expect(t.listMine).toHaveBeenCalledTimes(1);
    tick(14_000);
    await checkFollowUps(store, code, at(), t.make);
    expect(t.listMine).toHaveBeenCalledTimes(1);
    tick(1_000);
    await checkFollowUps(store, code, at(), t.make);
    expect(t.listMine).toHaveBeenCalledTimes(2);
  });
  it('writes nothing when nothing changed', async () => {
    const { store, code, tick, at } = await liveSession();
    const t = fakeTickets(() => [VPN]);
    await checkFollowUps(store, code, at(), t.make);
    const { version } = (await loadSession(store, code))!;
    tick(15_000);
    await checkFollowUps(store, code, at(), t.make);
    expect((await loadSession(store, code))!.version).toBe(version);
  });
  it('never lists or rings during a call', async () => {
    const { store, code, tick, at } = await liveSession();
    let rows: RemoteTicket[] = [VPN];
    const t = fakeTickets(() => rows);
    await checkFollowUps(store, code, at(), t.make);
    await updateSession(store, code, (s) => ({ state: { ...s, call: { active: true, persona: 'employee', startedAt: at() } } }));
    rows = [resolved(VPN)];
    tick(15_000);
    expect((await checkFollowUps(store, code, at(), t.make))?.followUp).toBeNull();
    expect(t.listMine).toHaveBeenCalledTimes(1);
  });
  it('stays quiet when ServiceNow fails, and still rings later', async () => {
    const { store, code, tick, at } = await liveSession();
    let rows: RemoteTicket[] | 'down' = [VPN];
    const t = fakeTickets(() => rows);
    await checkFollowUps(store, code, at(), t.make);
    rows = 'down';
    tick(15_000);
    const quiet = await checkFollowUps(store, code, at(), t.make);
    expect(quiet?.followUp).toBeNull();
    expect(quiet?.tickets).toHaveLength(1);
    rows = [resolved(VPN)];
    tick(15_000);
    expect((await checkFollowUps(store, code, at(), t.make))?.followUp?.number).toBe('INC0010013');
  });
  it('returns null for an unknown session', async () => {
    const t = fakeTickets(() => []);
    expect(await checkFollowUps(new MemoryStore(), 'ZZZ-ZZZ', NOW, t.make)).toBeNull();
    expect(t.listMine).not.toHaveBeenCalled();
  });
});

const ENV = {
  NEXT_PUBLIC_AGORA_APP_ID: '0123456789abcdef0123456789abcdef',
  NEXT_AGORA_APP_CERTIFICATE: 'fedcba9876543210fedcba9876543210',
  MURF_API_KEY: 'murf-test-key',
  TOOL_SECRET: 'test-tool-secret-value',
  PUBLIC_BASE_URL: 'https://askit.example.com',
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NEXT_LLM_URL', 'NEXT_LLM_API_KEY', 'SERVICENOW_INSTANCE_URL', 'AUTH0_DOMAIN', 'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL']) vi.stubEnv(k, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function newSession(): Promise<string> {
  return ((await (await createSessionRoute()).json()) as { code: string }).code;
}

// IT resolved her Figma ticket, so its follow-up rings.
const ringFor = (code: string, f: Partial<FollowUp> = {}) =>
  updateSession(getStore(), code, (s) => ({
    state: {
      ...s,
      tickets: s.tickets.map((t) => (t.number === 'INC0011994' ? { ...t, state: 'Resolved' } : t)),
      followUp: { number: 'INC0011994', summary: 'Figma licence request', resolvedAt: Date.now(), status: 'ringing', ...f },
    },
  }));

const get = (code: string) => followUpGet(new NextRequest(`http://localhost/api/followup?session=${code}`));
const post = (body: unknown) => followUpPost(new NextRequest('http://localhost/api/followup', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
const view = async (code: string) => (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();

describe('/api/followup', () => {
  it('checks a session by its code', async () => {
    expect((await followUpGet(new NextRequest('http://localhost/api/followup?session=nope'))).status).toBe(400);
    expect((await get('ZZZ-ZZZ')).status).toBe(404);
    const code = await newSession();
    const res = await get(code);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ followUp: null });
  });
  it('shows the ringing ticket in the session view, and snoozes it for ten minutes', async () => {
    const code = await newSession();
    await ringFor(code);
    expect((await view(code)).followUp).toMatchObject({ number: 'INC0011994', summary: 'Figma licence request', status: 'ringing' });
    const res = await post({ session: code, number: 'INC0011994', action: 'snooze' });
    expect(res.status).toBe(200);
    const f = (await view(code)).followUp;
    expect(f.status).toBe('snoozed');
    expect(f.snoozedUntil - Date.now()).toBeGreaterThan(SNOOZE_MS - 5000);
  });
  it('refuses to snooze what is not ringing, and bad input', async () => {
    const code = await newSession();
    expect((await post({ session: code, number: 'INC0011994', action: 'snooze' })).status).toBe(409);
    expect((await post({ session: code, number: 'INC0011994', action: 'answer' })).status).toBe(400);
    expect((await post({ session: 'nope', number: 'INC0011994', action: 'snooze' })).status).toBe(400);
    expect((await post({ session: 'ZZZ-ZZZ', number: 'INC0011994', action: 'snooze' })).status).toBe(404);
    const bad = await followUpPost(new NextRequest('http://localhost/api/followup', { method: 'POST', body: '{nope' }));
    expect(bad.status).toBe(400);
  });
});

describe('answering a follow-up call', () => {
  function mockAgora() {
    const bodies: { properties: { llm: { greeting_message: string; system_messages: { content: string }[] } } }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/join')) {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ agent_id: 'agent-abc', create_ts: 1, status: 'RUNNING' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return bodies;
  }
  const invite = (code: string, extra: Record<string, unknown> = {}) =>
    inviteRoute(new NextRequest('http://localhost/api/invite-agent', { method: 'POST', body: JSON.stringify({ requester_id: '4321', channel_name: 'ch-1', session: code, ...extra }), headers: { 'content-type': 'application/json' } }));

  it('greets with the ticket, briefs the agent, and never rings again', async () => {
    const bodies = mockAgora();
    const code = await newSession();
    await ringFor(code);
    expect((await invite(code, { followUp: 'INC0011994' })).status).toBe(200);
    const llm = bodies[0].properties.llm;
    expect(llm.greeting_message).toBe('Hi Priya, this is ASK IT calling about I-N-C one one nine nine four, Figma licence request. IT marked it resolved. Is it working for you now?');
    expect(llm.system_messages[0].content).toMatch(/call confirmFix with ticket INC0011994/);
    const state = await view(code);
    expect(state.followUp).toMatchObject({ number: 'INC0011994', status: 'answered' });
    expect(state.call.active).toBe(true);
  });
  it('starts a normal call when that ticket is no longer ringing', async () => {
    const bodies = mockAgora();
    const code = await newSession();
    await ringFor(code, { status: 'snoozed', snoozedUntil: Date.now() + MINUTE });
    expect((await invite(code, { followUp: 'INC0011994' })).status).toBe(200);
    expect(bodies[0].properties.llm.greeting_message).toMatch(/What can I help you with\?$/);
    expect(bodies[0].properties.llm.system_messages[0].content).not.toMatch(/This call/);
    expect((await view(code)).followUp.status).toBe('snoozed');
  });
  it('keeps it ringing when the agent fails to start', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ detail: 'bad tts' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await newSession();
    await ringFor(code);
    expect((await invite(code, { followUp: 'INC0011994' })).status).toBe(502);
    expect((await view(code)).followUp.status).toBe('ringing');
  });
});

const dueReminder = (code: string, store = getStore(), at = Date.now() - 1000) =>
  updateSession(store, code, (s) => ({ state: { ...s, reminders: [{ id: 'RM-7', at, about: 'the Figma licence', ticket: 'INC0011994', createdAt: at - MINUTE, status: 'pending' as const }] } }));

describe('reminder calls', () => {
  it('rings a due reminder on the next check, even when ServiceNow is down or was just asked', async () => {
    const { store, code, tick, at } = await liveSession();
    const t = fakeTickets(() => 'down');
    await checkFollowUps(store, code, at(), t.make);
    await dueReminder(code, store, at() + 1000);
    tick(1000);
    const rung = await checkFollowUps(store, code, at(), t.make);
    expect(t.listMine).toHaveBeenCalledTimes(1);
    expect(rung?.followUp).toMatchObject({ reminder: 'RM-7', number: 'INC0011994', summary: 'the Figma licence', status: 'ringing' });
    expect(rung?.reminders?.[0].status).toBe('rung');
  });
  it('never rings during a call, and rings after it', async () => {
    const { store, code, tick, at } = await liveSession();
    const t = fakeTickets(() => []);
    await updateSession(store, code, (s) => ({ state: { ...s, call: { active: true, persona: 'employee', startedAt: at() } } }));
    await dueReminder(code, store, at());
    tick(1000);
    expect((await checkFollowUps(store, code, at(), t.make))?.followUp).toBeNull();
    await updateSession(store, code, (s) => ({ state: { ...s, call: { active: false, endedAt: at() } } }));
    expect((await checkFollowUps(store, code, at(), t.make))?.followUp?.reminder).toBe('RM-7');
  });
  it('writes nothing while no reminder is due', async () => {
    const { store, code, tick, at } = await liveSession();
    const t = fakeTickets(() => [VPN]);
    await dueReminder(code, store, at() + 60 * MINUTE);
    await checkFollowUps(store, code, at(), t.make);
    const { version } = (await loadSession(store, code))!;
    tick(15_000);
    await checkFollowUps(store, code, at(), t.make);
    expect((await loadSession(store, code))!.version).toBe(version);
  });
  it('snoozes a ringing reminder by its id through the route', async () => {
    const code = await newSession();
    await dueReminder(code);
    expect((await (await get(code)).json()).followUp).toMatchObject({ reminder: 'RM-7', status: 'ringing' });
    expect((await post({ session: code, number: 'INC0011994', action: 'snooze' })).status).toBe(409);
    const res = await post({ session: code, number: 'RM-7', action: 'snooze' });
    expect(res.status).toBe(200);
    expect((await view(code)).followUp).toMatchObject({ reminder: 'RM-7', status: 'snoozed' });
  });
});

describe('ticket refresh before a call', () => {
  const NEW_ONE: RemoteTicket = { number: 'INC0010020', sysId: 'sn-20', summary: 'Teams audio drops', state: 'New', urgency: 2, createdAt: NOW - 5 * MINUTE, updatedAt: NOW - 5 * MINUTE };

  it('lists her tickets when the session has not seen them for 30 seconds', async () => {
    const { store, code, at } = await liveSession();
    const t = fakeTickets(() => [VPN, NEW_ONE]);
    const s = await refreshTickets(store, code, at(), t.make);
    expect(t.listMine).toHaveBeenCalledTimes(1);
    expect(s?.tickets.map((x) => x.number)).toEqual(['INC0010020', 'INC0010013']);
    expect((await loadSession(store, code))!.state.tickets).toHaveLength(2);
  });
  it('skips the list while it is fresh, from a follow-up check or an earlier refresh', async () => {
    const { store, code, tick, at } = await liveSession();
    const t = fakeTickets(() => [VPN]);
    await checkFollowUps(store, code, at(), t.make);
    tick(29_000);
    expect((await refreshTickets(store, code, at(), t.make))?.tickets).toHaveLength(1);
    expect(t.listMine).toHaveBeenCalledTimes(1);
    tick(1_000);
    await refreshTickets(store, code, at(), t.make);
    expect(t.listMine).toHaveBeenCalledTimes(2);
    tick(10_000);
    await refreshTickets(store, code, at(), t.make);
    expect(t.listMine).toHaveBeenCalledTimes(2);
  });
  it('falls back to what the session knows when ServiceNow fails', async () => {
    const { store, code, at } = await liveSession();
    await updateSession(store, code, (s) => ({ state: { ...s, tickets: [{ ...VPN, source: 'live', createdAt: VPN.createdAt!, updatedAt: VPN.updatedAt! }] } }));
    const t = fakeTickets(() => 'down');
    const s = await refreshTickets(store, code, at(), t.make);
    expect(s?.tickets.map((x) => x.number)).toEqual(['INC0010013']);
    expect(t.listMine).toHaveBeenCalledTimes(1);
    expect(await refreshTickets(store, 'ZZZ-ZZZ', at(), t.make)).toBeNull();
  });
  it('gives up after two seconds and keeps what the session knows', async () => {
    vi.useFakeTimers();
    try {
      const { store, code, at } = await liveSession();
      const listMine = vi.fn(() => new Promise<never>(() => {}));
      const pending = refreshTickets(store, code, at(), () => ({ mode: 'live', listMine }) as unknown as TicketAdapter);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(1_900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);
      expect((await pending)?.tickets).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('greeting at call start', () => {
  function mockAgora() {
    const bodies: { properties: { llm: { greeting_message: string; system_messages: { content: string }[] } } }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/join')) {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ agent_id: 'agent-abc', create_ts: 1, status: 'RUNNING' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return bodies;
  }
  const invite = (code: string, extra: Record<string, unknown> = {}) =>
    inviteRoute(new NextRequest('http://localhost/api/invite-agent', { method: 'POST', body: JSON.stringify({ requester_id: '4321', channel_name: 'ch-1', session: code, ...extra }), headers: { 'content-type': 'application/json' } }));

  it('names her open ticket and briefs the agent with her tickets', async () => {
    const bodies = mockAgora();
    const code = await newSession();
    expect((await invite(code)).status).toBe(200);
    const llm = bodies[0].properties.llm;
    expect(llm.greeting_message).toMatch(/I see your ticket I-N-C one one nine nine four, Figma licence request, is still in progress\. Is this about that, or something new\?$/);
    expect(llm.system_messages[0].content).toMatch(/Her open tickets\n- INC0011994, Figma licence request: in progress, low urgency\./);
  });
  it('greets an answered reminder about what she asked to check', async () => {
    const bodies = mockAgora();
    const code = await newSession();
    await dueReminder(code);
    await get(code);
    expect((await invite(code, { followUp: 'RM-7' })).status).toBe(200);
    const llm = bodies[0].properties.llm;
    expect(llm.greeting_message).toBe("Hi Priya, it's ASK IT checking back about the Figma licence, I-N-C one one nine nine four. Is it working now?");
    expect(llm.system_messages[0].content).toMatch(/This call\n- Priya asked you to check back about the Figma licence, ticket INC0011994/);
    const state = await view(code);
    expect(state.followUp).toMatchObject({ reminder: 'RM-7', status: 'answered' });
    expect(state.events.at(0).title).toBe('Reminder call started: the Figma licence');
  });
});
