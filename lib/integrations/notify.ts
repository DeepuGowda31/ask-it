import { describeFailure, requestText } from './http';
import type { Delivery } from './types';

type Env = Record<string, string | undefined>;

// Slack reads <...> as mentions and links, so user text is escaped.
const slackEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Posts to Discord ({content}) if DISCORD_WEBHOOK_URL is set, else Slack ({text}), else simulated.
export async function notifyChannel(
  text: string,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
  clock: { deadline?: number; now?: () => number } = {},
): Promise<Delivery> {
  const discord = env.DISCORD_WEBHOOK_URL?.trim();
  const slack = env.SLACK_WEBHOOK_URL?.trim();
  const url = discord || slack;
  if (!url) return { ok: true, channel: 'simulated' };
  const res = await requestText(
    { fetch: fetchImpl, ...clock },
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(discord ? { content: text, allowed_mentions: { parse: [] } } : { text: slackEscape(text) }) },
    timeoutMs,
  );
  if (res.ok) return { ok: true, channel: discord ? 'discord' : 'slack' };
  return { ok: false, error: describeFailure(`The ${discord ? 'Discord' : 'Slack'} webhook`, res.error) };
}
