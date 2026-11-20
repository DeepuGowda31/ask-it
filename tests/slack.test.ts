import { describe, expect, it, vi } from 'vitest';
import { SlackClient, cardBlocks, slackConfig } from '@/lib/integrations/slack';
import type { CardUpdate } from '@/lib/integrations/types';
import { fakeFetch, hangingFetch, headerOf, jsonResponse } from './fakes';

const CFG = { token: 'xoxb-SECRET-token', channel: 'C0123ABC' };
const client = (handler: Parameters<typeof fakeFetch>[0], sleep = vi.fn(async () => {})) => {
  const f = fakeFetch(handler);
  return { slack: new SlackClient(CFG, { fetch: f.fetch }, sleep), calls: f.calls, sleep };
};

const CARD: CardUpdate = {
  key: 'NMB-7K2:ISS-101',
  status: 'ticket_raised',
  title: 'VPN <drops> & reconnects',
  person: 'Deepak Gowda',
  device: 'NB-2231',
  ticket: 'INC0012001',
  detail: 'Raised as INC0012001, high urgency',
  at: Date.UTC(2026, 10, 18, 4, 10),
};

describe('Slack config', () => {
  it('needs the bot token and channel', () => {
    expect(slackConfig({ SLACK_BOT_TOKEN: 'xoxb-1' })).toBeNull();
    expect(slackConfig({ SLACK_BOT_TOKEN: ' xoxb-1 ', SLACK_CHANNEL_ID: ' C1 ' })).toEqual({ token: 'xoxb-1', channel: 'C1' });
  });
});

describe('Slack Web API client', () => {
  it('posts a message and returns its ts', async () => {
    const { slack, calls } = client(() => jsonResponse({ ok: true, ts: '1700000000.0001' }));
    expect(await slack.post('hello', [{ type: 'section' }])).toEqual({ ok: true, value: '1700000000.0001' });
    expect(calls[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0].init.method).toBe('POST');
    expect(headerOf(calls[0].init, 'authorization')).toBe('Bearer xoxb-SECRET-token');
    expect(headerOf(calls[0].init, 'content-type')).toBe('application/json; charset=utf-8');
    expect(calls[0].body).toEqual({ channel: 'C0123ABC', text: 'hello', blocks: [{ type: 'section' }], unfurl_links: false, unfurl_media: false });
  });
  it('replies in a thread and updates in place', async () => {
    const { slack, calls } = client(() => jsonResponse({ ok: true, ts: '2.0' }));
    await slack.post('reply', undefined, '1.0');
    expect(calls[0].body).toMatchObject({ thread_ts: '1.0', text: 'reply' });
    expect(await slack.update('1.0', 'new text', [])).toEqual({ ok: true, value: null });
    expect(calls[1].url).toBe('https://slack.com/api/chat.update');
    expect(calls[1].body).toEqual({ channel: 'C0123ABC', ts: '1.0', text: 'new text', blocks: [] });
  });
  it.each([
    ['invalid_auth', 'unauthorized'],
    ['not_in_channel', 'rejected'],
    ['channel_not_found', 'rejected'],
    ['message_not_found', 'not_found'],
  ])('maps ok:false %s to %s', async (error, kind) => {
    const { slack } = client(() => jsonResponse({ ok: false, error }));
    expect(await slack.post('x')).toEqual({ ok: false, error: { kind, code: error } });
  });
  it('respects Retry-After once, then gives up', async () => {
    let n = 0;
    const once = client(() => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : jsonResponse({ ok: true, ts: '9.9' })));
    expect(await once.slack.post('x')).toEqual({ ok: true, value: '9.9' });
    expect(once.sleep).toHaveBeenCalledWith(2000);
    const always = client(() => new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    expect(await always.slack.post('x')).toEqual({ ok: false, error: { kind: 'unavailable', status: 429, retryAfter: 60 } });
    expect(always.sleep).toHaveBeenCalledWith(10_000);
    expect(always.calls).toHaveLength(2);
    const body = client(() => jsonResponse({ ok: false, error: 'ratelimited' }));
    expect(await body.slack.post('x')).toEqual({ ok: false, error: { kind: 'unavailable', code: 'ratelimited' } });
  });
  it('handles timeouts, bad JSON and network errors without leaking the token', async () => {
    const outs = [
      await new SlackClient(CFG, { fetch: hangingFetch() }, async () => {}, 30).post('x'),
      await client(() => new Response('<html>', { status: 200 })).slack.post('x'),
      await client(() => jsonResponse({ ok: true })).slack.post('x'),
      await client(() => {
        throw new TypeError(`fetch failed ${CFG.token}`);
      }).slack.post('x'),
    ];
    expect(outs).toEqual([
      { ok: false, error: { kind: 'timeout' } },
      { ok: false, error: { kind: 'bad_response' } },
      { ok: false, error: { kind: 'bad_response' } },
      { ok: false, error: { kind: 'network' } },
    ]);
    expect(JSON.stringify(outs)).not.toMatch(/SECRET/);
  });
});

describe('card blocks', () => {
  it('shows status, title and context, escaping user text', () => {
    const blocks = cardBlocks(CARD);
    expect(blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: ':ticket: *Ticket raised* · VPN &lt;drops&gt; &amp; reconnects' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Deepak Gowda · NB-2231 · INC0012001 · updated 9:40 AM' }] },
    ]);
  });
  it('neutralises mentions and leaves out missing parts', () => {
    const blocks = cardBlocks({ ...CARD, title: '<!channel> help @here', device: undefined, ticket: undefined, status: 'in_progress' });
    expect(JSON.stringify(blocks)).not.toMatch(/<!channel>/);
    expect(blocks[1]).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Deepak Gowda · no ticket yet · updated 9:40 AM' }] });
  });
});
