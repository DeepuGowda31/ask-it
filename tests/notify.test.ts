import { describe, expect, it, vi } from 'vitest';
import { notifyChannel } from '@/lib/integrations/notify';
import { hangingFetch } from './fakes';

describe('IT channel webhook', () => {
  const ok = () => vi.fn(async () => new Response(null, { status: 204 }));

  it('is simulated when no webhook is configured', async () => {
    const f = ok();
    expect(await notifyChannel('hi', {}, f as unknown as typeof fetch)).toEqual({ ok: true, channel: 'simulated' });
    expect(f).not.toHaveBeenCalled();
  });
  it('posts the Discord and Slack payload shapes', async () => {
    const f = ok();
    expect(await notifyChannel('hi', { DISCORD_WEBHOOK_URL: 'https://discord.example/hook' }, f as unknown as typeof fetch)).toEqual({ ok: true, channel: 'discord' });
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ content: 'hi', allowed_mentions: { parse: [] } });
    const g = ok();
    expect(await notifyChannel('hi', { SLACK_WEBHOOK_URL: 'https://slack.example/hook' }, g as unknown as typeof fetch)).toEqual({ ok: true, channel: 'slack' });
    expect(JSON.parse(String((g.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ text: 'hi' });
  });
  it('neutralises mentions and markup from user text', async () => {
    const g = ok();
    await notifyChannel('<!channel> ping <@U123> & <https://x|y>', { SLACK_WEBHOOK_URL: 'https://slack.example/hook' }, g as unknown as typeof fetch);
    expect(JSON.parse(String((g.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ text: '&lt;!channel&gt; ping &lt;@U123&gt; &amp; &lt;https://x|y&gt;' });
    const d = ok();
    await notifyChannel('@everyone look', { DISCORD_WEBHOOK_URL: 'https://discord.example/hook' }, d as unknown as typeof fetch);
    expect(JSON.parse(String((d.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ content: '@everyone look', allowed_mentions: { parse: [] } });
  });
  it('accepts Slack\'s plain-text "ok" answer', async () => {
    const f = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    expect(await notifyChannel('hi', { SLACK_WEBHOOK_URL: 'https://slack.example/hook' }, f)).toEqual({ ok: true, channel: 'slack' });
  });
  it('reports non-2xx, timeouts and network errors without leaking the URL', async () => {
    const env = { SLACK_WEBHOOK_URL: 'https://hooks.example/secret-path' };
    const bad = await notifyChannel('hi', env, (async () => new Response('no', { status: 500 })) as unknown as typeof fetch);
    expect(bad).toMatchObject({ ok: false });
    expect(bad).toEqual({ ok: false, error: 'The Slack webhook is having problems right now.' });
    expect(JSON.stringify(bad)).not.toMatch(/secret-path/);
    const slow = await notifyChannel('hi', env, hangingFetch(), 50);
    expect(slow).toEqual({ ok: false, error: 'The Slack webhook did not answer in time.' });
    const down = await notifyChannel('hi', env, (async () => { throw new TypeError('fetch failed https://hooks.example/secret-path'); }) as unknown as typeof fetch);
    expect(JSON.stringify(down)).not.toMatch(/secret-path/);
  });
  it('respects the shared deadline', async () => {
    const f = ok();
    const out = await notifyChannel('hi', { SLACK_WEBHOOK_URL: 'https://slack.example/hook' }, f as unknown as typeof fetch, 3000, { deadline: 10, now: () => 20 });
    expect(out).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });
});
