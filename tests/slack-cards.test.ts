import { describe, expect, it, vi } from 'vitest';
import { SlackClient } from '@/lib/integrations/slack';
import type { CardUpdate } from '@/lib/integrations/types';
import { MemoryStore } from '@/lib/server/store';
import { deliverCard } from '@/lib/server/slack-cards';
import { fakeFetch, jsonResponse } from './fakes';

const CARD: CardUpdate = { key: 'NMB-7K2:ISS-101', status: 'in_progress', title: 'VPN keeps dropping', person: 'Deepak Gowda', device: 'NB-2231', detail: 'Guided fix started', at: 0 };

function slackFake(handler?: (method: string, body: Record<string, unknown>) => Response | Promise<Response> | undefined) {
  let n = 0;
  const f = fakeFetch((url, init) => {
    const method = url.split('/').pop()!;
    const body = JSON.parse(String(init.body));
    return handler?.(method, body) ?? jsonResponse({ ok: true, ts: `ts-${++n}` });
  });
  const slack = new SlackClient({ token: 'xoxb-SECRET', channel: 'C1' }, { fetch: f.fetch }, async () => {});
  const cards = () => f.calls.filter((c) => c.url.endsWith('chat.postMessage') && !(c.body as { thread_ts?: string }).thread_ts);
  const replies = () => f.calls.filter((c) => (c.body as { thread_ts?: string }).thread_ts);
  const updates = () => f.calls.filter((c) => c.url.endsWith('chat.update'));
  return { slack, calls: f.calls, cards, replies, updates };
}

const opts = { sleep: async () => {}, waitMs: 1000 };

describe('Slack status cards', () => {
  it('posts one card, keeps its ts for 7 days, then updates it in place with a thread reply', async () => {
    const store = new MemoryStore();
    const set = vi.spyOn(store, 'setIfVersion');
    const s = slackFake();
    expect(await deliverCard(store, s.slack, CARD, 'fallback', opts)).toEqual({ ok: true, channel: 'slack' });
    expect(s.cards()).toHaveLength(1);
    expect(s.cards()[0].body).toMatchObject({ text: 'fallback', blocks: expect.any(Array) });
    expect(JSON.parse((await store.get('askit:slack:NMB-7K2:ISS-101'))!.value)).toEqual({ ts: 'ts-1' });
    expect(set.mock.calls.every((c) => c[3] === 7 * 24 * 3600)).toBe(true);
    await deliverCard(store, s.slack, { ...CARD, status: 'waiting_employee', detail: 'Verification code sent' }, 'fallback 2', opts);
    expect(s.cards()).toHaveLength(1);
    expect(s.updates()[0].body).toMatchObject({ ts: 'ts-1', text: 'fallback 2' });
    expect(s.replies()[0].body).toMatchObject({ thread_ts: 'ts-1', text: ':hourglass_flowing_sand: Waiting for employee: Verification code sent' });
  });
  it('never creates two cards when deliveries race', async () => {
    const store = new MemoryStore();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let posted = 0;
    const s = slackFake((method, body) => {
      if (method === 'chat.postMessage' && !body.thread_ts && ++posted === 1) return gate.then(() => jsonResponse({ ok: true, ts: 'card-ts' })) as unknown as Response;
      return undefined;
    });
    const sleep = () => new Promise<void>((r) => setTimeout(r, 5));
    const both = Promise.all([deliverCard(store, s.slack, CARD, 'a', { sleep, waitMs: 2000 }), deliverCard(store, s.slack, { ...CARD, status: 'waiting_employee' }, 'b', { sleep, waitMs: 2000 })]);
    setTimeout(release, 30);
    expect(await both).toEqual([{ ok: true, channel: 'slack' }, { ok: true, channel: 'slack' }]);
    expect(s.cards()).toHaveLength(1);
    expect(s.updates()[0].body).toMatchObject({ ts: 'card-ts' });
  });
  it('gives up rather than posting a second card while another is being created', async () => {
    const store = new MemoryStore();
    await store.setIfVersion('askit:slack:NMB-7K2:ISS-101', JSON.stringify({ posting: Date.now() }), 0, 60);
    const s = slackFake();
    const out = await deliverCard(store, s.slack, CARD, 'x', { sleep: async () => {}, waitMs: 50 });
    expect(out).toEqual({ ok: false, error: 'The Slack card is still being created.' });
    expect(s.calls).toHaveLength(0);
  });
  it('takes over an abandoned claim', async () => {
    const store = new MemoryStore();
    await store.setIfVersion('askit:slack:NMB-7K2:ISS-101', JSON.stringify({ posting: Date.now() - 60_000 }), 0, 60);
    const s = slackFake();
    expect(await deliverCard(store, s.slack, CARD, 'x', opts)).toMatchObject({ ok: true });
    expect(s.cards()).toHaveLength(1);
  });
  it('re-posts the card when Slack lost the message', async () => {
    const store = new MemoryStore();
    await store.setIfVersion('askit:slack:NMB-7K2:ISS-101', JSON.stringify({ ts: 'gone' }), 0, 60);
    const s = slackFake((method) => (method === 'chat.update' ? jsonResponse({ ok: false, error: 'message_not_found' }) : undefined));
    expect(await deliverCard(store, s.slack, CARD, 'x', opts)).toMatchObject({ ok: true });
    expect(s.cards()).toHaveLength(1);
    expect(JSON.parse((await store.get('askit:slack:NMB-7K2:ISS-101'))!.value)).toEqual({ ts: 'ts-1' });
  });
  it('makes the card findable by ticket number once one is raised', async () => {
    const store = new MemoryStore();
    const s = slackFake();
    await deliverCard(store, s.slack, CARD, 'x', opts);
    await deliverCard(store, s.slack, { ...CARD, status: 'ticket_raised', alias: 'INC0012001', ticket: 'INC0012001' }, 'x', opts);
    expect(JSON.parse((await store.get('askit:slack:INC0012001'))!.value)).toEqual({ ts: 'ts-1' });
    await deliverCard(store, s.slack, { ...CARD, key: 'INC0012001', status: 'assigned', detail: 'David Dan' }, 'x', opts);
    expect(s.cards()).toHaveLength(1);
    expect(s.updates().map((u) => (u.body as { ts: string }).ts)).toEqual(['ts-1', 'ts-1']);
  });
  it('releases the claim when posting fails, and explains Slack errors', async () => {
    const store = new MemoryStore();
    const broken = slackFake(() => jsonResponse({ ok: false, error: 'not_in_channel' }));
    expect(await deliverCard(store, broken.slack, CARD, 'x', opts)).toEqual({ ok: false, error: 'The Slack bot is not in the channel.' });
    const s = slackFake();
    expect(await deliverCard(store, s.slack, CARD, 'x', opts)).toMatchObject({ ok: true });
    const auth = slackFake(() => jsonResponse({ ok: false, error: 'invalid_auth' }));
    const out = await deliverCard(new MemoryStore(), auth.slack, CARD, 'x', opts);
    expect(out).toEqual({ ok: false, error: 'Slack refused our credentials.' });
    expect(JSON.stringify(out)).not.toMatch(/SECRET/);
  });
});
