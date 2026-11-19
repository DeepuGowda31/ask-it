import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, type VersionedStore } from '@/lib/server/store';
import { createSession, loadSession } from '@/lib/server/session';
import { executeTool } from '@/lib/server/execute';
import { alertDeliverer, settleDeliveries } from '@/lib/server/deliveries';
import type { Alert } from '@/lib/domain/types';
import type { Delivery } from '@/lib/integrations/types';
import { notifyChannel } from '@/lib/integrations/notify';
import { buildDeps, integrationModes, seedOptions } from '@/lib/server/deps';
import { success } from '@/lib/integrations/http';
import { ServiceNowTickets } from '@/lib/integrations/servicenow';
import { ServiceNowKnowledge, SimulatedKnowledge } from '@/lib/integrations/servicenow-kb';
import { Auth0Identity } from '@/lib/integrations/auth0';
import { SimulatedIdentity, SimulatedTickets } from '@/lib/integrations/simulated';
import { NOW, freshState, makeDeps } from './helpers';

afterEach(() => vi.restoreAllMocks());

// Fails the first N writes, as if another request got there first.
class ContendedStore extends MemoryStore {
  constructor(private conflicts: number) {
    super();
  }
  override async setIfVersion(key: string, value: string, expected: number, ttl: number) {
    if (expected > 0 && this.conflicts > 0) {
      this.conflicts -= 1;
      return false;
    }
    return super.setIfVersion(key, value, expected, ttl);
  }
}

describe('executeTool', () => {
  it('runs the outbound call once even when the state update retries', async () => {
    const store: VersionedStore = new ContendedStore(2);
    const code = await createSession(store, NOW);
    const listMine = vi.fn(async () => success([]));
    const out = await executeTool(code, 'listMyTickets', { status: 'all' }, { makeDeps: (s, now) => makeDeps(s, now, { tickets: { listMine } }), store });
    expect(out.status).toBe(200);
    expect(listMine).toHaveBeenCalledTimes(1);
    expect((await loadSession(store, code))!.state.events).toHaveLength(1);
  });
  it('commits a confirmation once when two calls race', async () => {
    const store = new MemoryStore();
    const code = await createSession(store, NOW);
    const prep = await executeTool(code, 'prepareTicket', { summary: 'Dock broken', urgency: 'low', details: '' }, { makeDeps, store });
    const confirmation = (prep.result.data as { confirmationCode: string }).confirmationCode;
    const create = vi.fn(async () => success({ number: 'INC0012001', sysId: 's1' }));
    const deps = (s: Parameters<typeof makeDeps>[0], now: number) => makeDeps(s, now, { tickets: { create } });
    const results = await Promise.all([executeTool(code, 'confirmAction', { code: confirmation }, { makeDeps: deps, store }), executeTool(code, 'confirmAction', { code: confirmation }, { makeDeps: deps, store })]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 200)).not.toHaveLength(0);
    const loser = results.find((r) => !(r.result.data as { number?: string } | undefined)?.number);
    expect(['in_progress', undefined]).toContain(loser?.result.error);
    const { state } = (await loadSession(store, code))!;
    expect(state.tickets.filter((t) => t.raisedHere)).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({ status: 'done' });
  });
  it('runs unrelated concurrent tools without losing any', async () => {
    const store = new MemoryStore();
    const code = await createSession(store, NOW);
    await Promise.all([
      executeTool(code, 'followOutage', { incident: '' }, { makeDeps, store }),
      executeTool(code, 'startTroubleshooting', { articleId: 'vpn', issue: '' }, { makeDeps, store }),
      executeTool(code, 'checkServiceStatus', { service: 'vpn' }, { makeDeps, store }),
      executeTool(code, 'verifyIdentity', {}, { makeDeps, store }),
    ]);
    const { state } = (await loadSession(store, code))!;
    expect(state.events).toHaveLength(4);
    expect(state.pending.map((p) => p.payload)).toEqual([{ kind: 'outage', incident: 'INC0011950' }]);
    expect(state.troubleshooting?.articleId).toBe('vpn');
    expect(state.verification.status).toBe('pending');
  });
});

describe('IT channel alerts', () => {
  it('are queued in the tool result and delivered after it, in order, outside the time budget', async () => {
    const store = new MemoryStore();
    const code = await createSession(store, NOW);
    const started: string[] = [];
    const gates: (() => void)[] = [];
    const deliver = vi.fn((alert: Alert) => {
      started.push(alert.card?.status ?? alert.text);
      return new Promise<Delivery>((r) => gates.push(() => r({ ok: true, channel: 'slack' })));
    });
    const prep = await executeTool(code, 'prepareTicket', { summary: 'Dock broken', urgency: 'low', details: '' }, { makeDeps, store, deliver });
    const confirmation = (prep.result.data as { confirmationCode: string }).confirmationCode;
    const done = await executeTool(code, 'confirmAction', { code: confirmation }, { makeDeps, store, deliver });
    expect(done.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(['waiting_employee']);
    expect((await loadSession(store, code))!.state.notifications.map((n) => n.status)).toEqual(['queued', 'queued']);
    gates[0]();
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(['waiting_employee', 'ticket_raised']);
    gates[1]();
    await settleDeliveries();
    const raised = deliver.mock.calls[1][0];
    expect(raised).toMatchObject({ text: expect.stringMatching(/INC0012001.*Dock broken/), card: { status: 'ticket_raised', alias: 'INC0012001' } });
    expect((await loadSession(store, code))!.state.notifications.map((n) => [n.status, n.channel])).toEqual([
      ['sent', 'slack'],
      ['sent', 'slack'],
    ]);
  });
  it('record a failed delivery honestly', async () => {
    const store = new MemoryStore();
    const code = await createSession(store, NOW);
    const deliver = async () => ({ ok: false as const, error: 'The Slack webhook did not answer in time.' });
    await executeTool(code, 'wrapUpCall', {}, { makeDeps, store, deliver });
    await settleDeliveries();
    expect((await loadSession(store, code))!.state.notifications[0]).toMatchObject({ status: 'failed', ok: false, error: 'The Slack webhook did not answer in time.' });
  });
});

describe('alert delivery routes', () => {
  const card = { key: 'NMB-7K2:ISS-101', status: 'in_progress' as const, title: 'VPN <drops>', person: 'Priya Sharma', device: 'NB-2231', detail: 'Guided fix started', at: NOW };
  it('updates Slack cards through the Web API when the bot is configured', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, ts: '1.1' }));
    }) as typeof fetch;
    const store = new MemoryStore();
    const deliver = alertDeliverer(store, { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_CHANNEL_ID: 'C1', SLACK_WEBHOOK_URL: 'https://hooks.example/x' }, f);
    expect(await deliver({ id: 'NT-1', text: 'In progress: VPN <drops>', card })).toEqual({ ok: true, channel: 'slack' });
    expect(calls[0]).toMatchObject({ url: 'https://slack.com/api/chat.postMessage', body: { channel: 'C1', text: 'In progress: VPN &lt;drops&gt;' } });
    expect(await store.get('askit:slack:NMB-7K2:ISS-101')).not.toBeNull();
    expect(await deliver({ id: 'NT-2', text: 'Call summary <!here>' })).toEqual({ ok: true, channel: 'slack' });
    expect(calls[1]).toMatchObject({ url: 'https://slack.com/api/chat.postMessage', body: { text: 'Call summary &lt;!here&gt;' } });
    expect(calls.some((c) => c.url.includes('hooks.example'))).toBe(false);
  });
  it('falls back to one webhook message per milestone, then to simulated', async () => {
    const posted: unknown[] = [];
    const f = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const webhook = alertDeliverer(new MemoryStore(), { SLACK_WEBHOOK_URL: 'https://hooks.example/x' }, f);
    expect(await webhook({ id: 'NT-1', text: 'In progress: VPN', card })).toEqual({ ok: true, channel: 'slack' });
    expect(posted).toEqual([{ text: 'In progress: VPN' }]);
    expect(await alertDeliverer(new MemoryStore(), {}, f)({ id: 'NT-2', text: 'x', card })).toEqual({ ok: true, channel: 'simulated' });
  });
});

describe('secrets', () => {
  const ENV = {
    SERVICENOW_INSTANCE_URL: 'https://nimbus.service-now.example',
    SERVICENOW_USER: 'askit',
    SERVICENOW_PASSWORD: 'SN-PASSWORD-SECRET',
    SERVICENOW_CALLER_EMAIL: 'priya@x.example',
    AUTH0_DOMAIN: 'https://nimbus.auth0.example',
    AUTH0_CLIENT_ID: 'm2m',
    AUTH0_CLIENT_SECRET: 'M2M-CLIENT-SECRET',
    AUTH0_OTP_CLIENT_ID: 'otp',
    AUTH0_OTP_CLIENT_SECRET: 'OTP-CLIENT-SECRET',
    AUTH0_USER_EMAIL: 'priya@x.example',
    SLACK_WEBHOOK_URL: 'https://hooks.slack.example/SECRET-HOOK',
  };
  it('never reach tool results or state when live systems fail', async () => {
    const echo = (async (input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify({ error: `bad ${String(input)} ${String(init?.body)} ${JSON.stringify(init?.headers)}` }), { status: 500 })) as typeof fetch;
    const store = new MemoryStore();
    const code = await createSession(store, NOW);
    const deps = (s: Parameters<typeof makeDeps>[0], now: number) => buildDeps(s, now, ENV, echo);
    const deliver = (alert: Alert) => notifyChannel(alert.text, ENV, echo);
    const results = [];
    for (const [name, args] of [
      ['getAccountStatus', {}],
      ['verifyIdentity', {}],
      ['listMyTickets', { status: '' }],
      ['addTicketNote', { ticket: '11994', note: 'x' }],
      ['followOutage', { incident: '' }],
      ['searchKnowledge', { query: 'parking pass' }],
      ['markResolved', { summary: 'fixed' }],
      ['wrapUpCall', {}],
    ] as const) {
      const out = await executeTool(code, name, args, { makeDeps: deps, store, deliver });
      results.push(out);
      const confirmation = (out.result.data as { confirmationCode?: string } | undefined)?.confirmationCode;
      if (confirmation) results.push(await executeTool(code, 'confirmAction', { code: confirmation }, { makeDeps: deps, store, deliver }));
    }
    const prep = await executeTool(code, 'prepareTicket', { summary: 'Dock', urgency: 'low', details: '' }, { makeDeps: deps, store, deliver });
    results.push(await executeTool(code, 'confirmAction', { code: (prep.result.data as { confirmationCode: string }).confirmationCode }, { makeDeps: deps, store, deliver }));
    await settleDeliveries();
    const visible = JSON.stringify([results, (await loadSession(store, code))!.state]);
    expect(visible).not.toMatch(/SECRET|service-now\.example|auth0\.example|hooks\.slack/);
    expect(results.map((r) => r.result.say).join(' ')).toMatch(/Auth0 is having problems right now/);
    expect(results.map((r) => r.result.error)).toEqual(expect.arrayContaining(['note_not_synced', 'follow_not_synced']));
  });
});

describe('deps', () => {
  const SN = { SERVICENOW_INSTANCE_URL: 'https://x.example', SERVICENOW_USER: 'u', SERVICENOW_PASSWORD: 'p', SERVICENOW_CALLER_EMAIL: 'e@x' };
  const A0 = { AUTH0_DOMAIN: 'x.auth0.example', AUTH0_CLIENT_ID: 'a', AUTH0_CLIENT_SECRET: 'b', AUTH0_OTP_CLIENT_ID: 'c', AUTH0_OTP_CLIENT_SECRET: 'd', AUTH0_USER_EMAIL: 'e@x' };
  it('is simulated until credentials are set', () => {
    expect(integrationModes({})).toEqual({ tickets: 'simulated', identity: 'simulated', notify: 'simulated', status: 'live' });
    expect(integrationModes({ ...SN, ...A0, SLACK_WEBHOOK_URL: 'https://hooks.example/x' })).toEqual({ tickets: 'live', identity: 'live', notify: 'live', status: 'live' });
    expect(integrationModes({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_CHANNEL_ID: 'C1' }).notify).toBe('live');
    expect(buildDeps(freshState(), NOW, { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_CHANNEL_ID: 'C1' }).notifyMode).toBe('live');
    const sim = buildDeps(freshState(), NOW, {});
    expect(sim.tickets).toBeInstanceOf(SimulatedTickets);
    expect(sim.identity).toBeInstanceOf(SimulatedIdentity);
    const live = buildDeps(freshState(), NOW, { ...SN, ...A0 });
    expect(live.tickets).toBeInstanceOf(ServiceNowTickets);
    expect(live.identity).toBeInstanceOf(Auth0Identity);
    expect(sim.knowledge).toBeInstanceOf(SimulatedKnowledge);
    expect(buildDeps(freshState(), NOW, SN).knowledge).toBeInstanceOf(ServiceNowKnowledge);
  });
  it('seeds live sessions without simulated data', async () => {
    expect(seedOptions({})).toEqual({ tickets: 'simulated', outageIncident: undefined });
    expect(seedOptions({ ...SN, SERVICENOW_OUTAGE_INCIDENT: ' INC0020001 ' })).toEqual({ tickets: 'live', outageIncident: 'INC0020001' });
    const store = new MemoryStore();
    const code = await createSession(store, NOW, seedOptions(SN));
    const { state } = (await loadSession(store, code))!;
    expect(state.tickets).toEqual([]);
    expect(state.outages).toEqual([]);
  });
  it('gives every outbound call in one tool run a shared deadline well under 10 s', async () => {
    const f = vi.fn(async () => new Response('{}'));
    const deps = buildDeps(freshState(), Date.now() - 7000, SN, f as unknown as typeof fetch);
    expect(await deps.tickets.listMine()).toEqual({ ok: false, error: { kind: 'timeout' } });
    expect(f).not.toHaveBeenCalled();
  });
});
