import { CARD_STATUS } from '@/lib/domain/cards';
import { formatTime } from '@/lib/domain/time';
import { failure, requestText, success, type Failure, type Http, type Result } from './http';
import type { CardUpdate } from './types';

type Env = Record<string, string | undefined>;

interface SlackConfig {
  token: string;
  channel: string;
}

const API = 'https://slack.com/api';
const TIMEOUT_MS = 5000;
const MAX_RETRY_WAIT_MS = 10_000;
const AUTH_ERRORS = ['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired'];

export function slackConfig(env: Env): SlackConfig | null {
  const token = env.SLACK_BOT_TOKEN?.trim();
  const channel = env.SLACK_CHANNEL_ID?.trim();
  return token && channel ? { token, channel } : null;
}

// Slack reads <...> as mentions and links, so user text is escaped.
export const slackEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Slack answers HTTP 200 with { ok: false, error } for most failures.
function slackFailure(error: unknown): Failure {
  const code = typeof error === 'string' && /^[a-z_]+$/.test(error) ? error : undefined;
  const kind = code && AUTH_ERRORS.includes(code) ? 'unauthorized' : code === 'message_not_found' ? 'not_found' : code === 'ratelimited' ? 'unavailable' : 'rejected';
  return { kind, ...(code ? { code } : {}) };
}

export class SlackClient {
  constructor(
    private cfg: SlackConfig,
    private http: Http,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private timeoutMs = TIMEOUT_MS,
  ) {}

  private async call(method: string, body: Json, retried = false): Promise<Result<Json>> {
    const init = { method: 'POST', headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) };
    const res = await requestText(this.http, `${API}/${method}`, init, this.timeoutMs);
    if (!res.ok) {
      // Rate limited: wait as asked, once.
      if (res.error.status === 429 && !retried) {
        await this.sleep(Math.min((res.error.retryAfter ?? 1) * 1000, MAX_RETRY_WAIT_MS));
        return this.call(method, body, true);
      }
      return res;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.value);
    } catch {
      return failure({ kind: 'bad_response' });
    }
    if (!isRecord(parsed)) return failure({ kind: 'bad_response' });
    return parsed.ok === true ? success(parsed) : failure(slackFailure(parsed.error));
  }

  // New message, or a thread reply when `threadTs` is given; returns its ts.
  async post(text: string, blocks?: unknown[], threadTs?: string): Promise<Result<string>> {
    const res = await this.call('chat.postMessage', {
      channel: this.cfg.channel,
      text,
      ...(blocks ? { blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!res.ok) return res;
    return typeof res.value.ts === 'string' ? success(res.value.ts) : failure({ kind: 'bad_response' });
  }

  async update(ts: string, text: string, blocks: unknown[]): Promise<Result<null>> {
    const res = await this.call('chat.update', { channel: this.cfg.channel, ts, text, blocks });
    return res.ok ? success(null) : res;
  }
}

// Status line, then who, device, ticket and when.
export function cardBlocks(card: CardUpdate): unknown[] {
  const s = CARD_STATUS[card.status];
  const context = [card.person, card.device, card.ticket ?? 'no ticket yet', `updated ${formatTime(card.at)}`].filter(Boolean).map((x) => slackEscape(String(x)));
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `${s.emoji} *${s.label}* · ${slackEscape(card.title)}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: context.join(' · ') }] },
  ];
}
