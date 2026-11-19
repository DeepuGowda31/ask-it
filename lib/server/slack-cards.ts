import { CARD_STATUS } from '@/lib/domain/cards';
import { describeFailure, type Failure, type Result } from '@/lib/integrations/http';
import { cardBlocks, slackEscape, type SlackClient } from '@/lib/integrations/slack';
import type { CardUpdate, Delivery } from '@/lib/integrations/types';
import type { VersionedStore } from './store';

const CARD_TTL_SECONDS = 7 * 24 * 3600;
const CLAIM_TTL_MS = 30_000;
const POLL_MS = 200;

interface CardRecord {
  ts?: string;
  // Set while one delivery is creating the card.
  posting?: number;
}

interface Options {
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  now?: () => number;
}

const storeKey = (key: string) => `askit:slack:${key}`;

async function read(store: VersionedStore, key: string): Promise<{ record: CardRecord; version: number }> {
  const hit = await store.get(storeKey(key));
  if (!hit) return { record: {}, version: 0 };
  try {
    return { record: JSON.parse(hit.value) as CardRecord, version: hit.version };
  } catch {
    return { record: {}, version: hit.version };
  }
}

const write = (store: VersionedStore, key: string, record: CardRecord, version: number) => store.setIfVersion(storeKey(key), JSON.stringify(record), version, CARD_TTL_SECONDS);

function explain(error: Failure): string {
  if (error.code === 'not_in_channel') return 'The Slack bot is not in the channel.';
  if (error.code === 'channel_not_found') return 'The Slack channel was not found.';
  return describeFailure('Slack', error);
}

const failed = (error: Failure): Delivery => ({ ok: false, error: explain(error) });

// Posts a new card under a claim, so racing deliveries never create two.
async function create(store: VersionedStore, slack: SlackClient, card: CardUpdate, text: string, version: number, now: number): Promise<Result<string> | 'lost'> {
  if (!(await write(store, card.key, { posting: now }, version))) return 'lost';
  const posted = await slack.post(text, cardBlocks(card));
  await write(store, card.key, posted.ok ? { ts: posted.value } : {}, version + 1);
  return posted;
}

// Waits for another delivery to finish creating the card.
async function waitForTs(store: VersionedStore, key: string, o: Required<Options>): Promise<string | null> {
  for (let waited = 0; waited < o.waitMs; waited += POLL_MS) {
    await o.sleep(POLL_MS);
    const { record } = await read(store, key);
    if (record.ts) return record.ts;
    if (!record.posting) return null;
  }
  return null;
}

async function cardTs(store: VersionedStore, slack: SlackClient, card: CardUpdate, text: string, o: Required<Options>): Promise<{ ts: string; created: boolean } | Delivery> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { record, version } = await read(store, card.key);
    if (record.ts) return { ts: record.ts, created: false };
    if (record.posting && o.now() - record.posting < CLAIM_TTL_MS) {
      const ts = await waitForTs(store, card.key, o);
      return ts ? { ts, created: false } : { ok: false, error: 'The Slack card is still being created.' };
    }
    const made = await create(store, slack, card, text, version, o.now());
    if (made === 'lost') continue;
    return made.ok ? { ts: made.value, created: true } : failed(made.error);
  }
  return { ok: false, error: 'The Slack card is still being created.' };
}

// One live card per key: created once, then updated in place with each milestone as a thread reply.
export async function deliverCard(store: VersionedStore, slack: SlackClient, card: CardUpdate, fallback: string, options: Options = {}): Promise<Delivery> {
  const o: Required<Options> = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), waitMs: 5000, now: Date.now, ...options };
  const text = slackEscape(fallback);
  const found = await cardTs(store, slack, card, text, o);
  if ('ok' in found) return found;
  let ts = found.ts;
  if (!found.created) {
    const updated = await slack.update(ts, text, cardBlocks(card));
    if (!updated.ok && updated.error.kind === 'not_found') {
      // The message is gone: post a fresh card and remember it.
      const posted = await slack.post(text, cardBlocks(card));
      if (!posted.ok) return failed(posted.error);
      ts = posted.value;
      const { version } = await read(store, card.key);
      await write(store, card.key, { ts }, version);
    } else if (!updated.ok) {
      return failed(updated.error);
    } else {
      const s = CARD_STATUS[card.status];
      await slack.post(`${s.emoji} ${s.label}: ${slackEscape(card.detail)}`, undefined, ts);
    }
  }
  if (card.alias) {
    const alias = await read(store, card.alias);
    if (!alias.record.ts) await write(store, card.alias, { ts }, alias.version);
  }
  return { ok: true, channel: 'slack' };
}
