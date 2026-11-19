import { requestJson, type Http } from './http';
import type { LiveStatus, StatusFeed, StatusLevel, StatusSource } from './types';

const TIMEOUT_MS = 3000;
const TTL_MS = 60_000;
const SLACK_URL = 'https://slack-status.com/api/v2.0.0/current';
const GOOGLE_URL = 'https://www.google.com/appsstatus/dashboard/incidents.json';

const RANK: StatusLevel[] = ['operational', 'maintenance', 'degraded', 'outage'];
const INDICATOR: Record<string, StatusLevel> = { none: 'operational', minor: 'degraded', major: 'outage', critical: 'outage', maintenance: 'maintenance' };
const COMPONENT: Record<string, StatusLevel> = {
  operational: 'operational',
  degraded_performance: 'degraded',
  partial_outage: 'degraded',
  major_outage: 'outage',
  under_maintenance: 'maintenance',
};

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const worst = (levels: StatusLevel[]) => levels.reduce<StatusLevel>((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), 'operational');
const has = (name: string, needle: string) => name.toLowerCase().includes(needle.toLowerCase());

const unknown = (): LiveStatus => ({ level: 'unknown', summary: 'The status page could not be checked right now.', incidents: [] });

function product(name: string, level: StatusLevel, incidents: string[]): LiveStatus {
  if (level === 'operational' && !incidents.length) return { level, summary: `No reported issues for ${name}.`, incidents };
  return { level: level === 'operational' ? 'degraded' : level, summary: `${name} has an active incident.`, incidents };
}

function fromStatuspage(body: unknown, match?: string): LiveStatus | null {
  if (!isRecord(body) || !isRecord(body.status)) return null;
  const incidents = list(body.incidents).filter((i) => !['resolved', 'postmortem'].includes(text(i.status)));
  if (!match) {
    const level = INDICATOR[text(body.status.indicator)];
    return level ? { level, summary: text(body.status.description), incidents: incidents.map((i) => text(i.name)) } : null;
  }
  const components = list(body.components).filter((c) => has(text(c.name), match));
  const hits = incidents.filter((i) => has(text(i.name), match) || list(i.components).some((c) => has(text(c.name), match)));
  const levels = [
    ...components.map((c) => COMPONENT[text(c.status)] ?? 'degraded'),
    ...hits.map((i) => (['major', 'critical'].includes(text(i.impact)) ? 'outage' : 'degraded') as StatusLevel),
  ];
  return product(match, worst(levels), hits.map((i) => text(i.name)));
}

function fromSlack(body: unknown): LiveStatus | null {
  if (!isRecord(body) || typeof body.status !== 'string') return null;
  const active = list(body.active_incidents);
  const levels = active.map((i): StatusLevel => (i.type === 'outage' ? 'outage' : i.type === 'maintenance' ? 'maintenance' : 'degraded'));
  return product('Slack', body.status === 'ok' && !active.length ? 'operational' : worst(levels.length ? levels : ['degraded']), active.map((i) => text(i.title)));
}

function fromGoogle(body: unknown, name: string): LiveStatus | null {
  if (!Array.isArray(body)) return null;
  const active = list(body).filter(
    (i) => !i.end && (has(text(i.service_name), name) || list(i.affected_products).some((p) => text(p.title).toLowerCase() === name.toLowerCase())),
  );
  const levels = active.map((i): StatusLevel => (i.status_impact === 'SERVICE_OUTAGE' ? 'outage' : 'degraded'));
  const titles = active.map((i) => text(i.external_desc).split('\n')[0].replace(/\*+/g, '').trim().slice(0, 140));
  return product(name, worst(levels), titles);
}

function feedUrl(feed: StatusFeed): string {
  if (feed.kind === 'slack') return SLACK_URL;
  if (feed.kind === 'google') return GOOGLE_URL;
  return `${feed.base}/api/v2/summary.json`;
}

function interpret(feed: StatusFeed, body: unknown): LiveStatus | null {
  if (feed.kind === 'slack') return fromSlack(body);
  if (feed.kind === 'google') return fromGoogle(body, feed.product);
  return fromStatuspage(body, feed.match);
}

// Public status pages: no keys, short timeout, good answers cached per URL for a minute.
export function createStatusChecker(http: Http, clock: () => number = Date.now, timeoutMs = TIMEOUT_MS): StatusSource {
  const cache = new Map<string, { at: number; body: unknown }>();
  return {
    async check(feed) {
      const url = feedUrl(feed);
      const hit = cache.get(url);
      if (hit && clock() - hit.at < TTL_MS) return interpret(feed, hit.body) ?? unknown();
      const res = await requestJson(http, url, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs);
      const status = res.ok ? interpret(feed, res.value) : null;
      if (!status) return unknown();
      cache.set(url, { at: clock(), body: res.ok ? res.value : null });
      return status;
    },
  };
}
