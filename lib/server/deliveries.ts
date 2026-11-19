import { after } from 'next/server';
import type { Alert } from '@/lib/domain/types';
import { describeFailure } from '@/lib/integrations/http';
import { notifyChannel } from '@/lib/integrations/notify';
import { SlackClient, slackConfig, slackEscape } from '@/lib/integrations/slack';
import type { Delivery } from '@/lib/integrations/types';
import { deliverCard } from './slack-cards';
import type { VersionedStore } from './store';

type Env = Record<string, string | undefined>;

const inflight = new Set<Promise<void>>();
// Deliveries run one at a time, so a card's milestones reach Slack in order.
let tail: Promise<void> = Promise.resolve();

// Runs `task` after the response is sent, after every earlier delivery; outside a request it starts at once.
export function deferDelivery(task: () => Promise<void>) {
  const run = () => {
    const p: Promise<void> = tail
      .then(task)
      .catch((e: unknown) => console.error('IT channel delivery could not be recorded:', e instanceof Error ? e.name : 'unknown error'))
      .finally(() => inflight.delete(p));
    tail = p;
    inflight.add(p);
    return p;
  };
  try {
    after(run);
  } catch {
    void run();
  }
}

// Test seam: waits for every delivery started so far.
export async function settleDeliveries() {
  while (inflight.size) await Promise.all([...inflight]);
}

// Slack Web API cards when the bot is configured, else the webhook (one message per milestone), else simulated.
export function alertDeliverer(store: VersionedStore, env: Env = process.env, fetchImpl: typeof fetch = fetch): (alert: Alert) => Promise<Delivery> {
  const cfg = slackConfig(env);
  if (!cfg) return (alert) => notifyChannel(alert.text, env, fetchImpl);
  const slack = new SlackClient(cfg, { fetch: fetchImpl });
  return async (alert) => {
    if (alert.card) return deliverCard(store, slack, alert.card, alert.text);
    const posted = await slack.post(slackEscape(alert.text));
    return posted.ok ? { ok: true, channel: 'slack' } : { ok: false, error: describeFailure('Slack', posted.error) };
  };
}
