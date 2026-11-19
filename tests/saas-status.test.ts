import { describe, expect, it } from 'vitest';
import { createStatusChecker } from '@/lib/integrations/saas-status';
import { fakeFetch, hangingFetch, jsonResponse } from './fakes';

const GITHUB = { kind: 'statuspage', base: 'https://www.githubstatus.com' } as const;
const JIRA = { kind: 'statuspage', base: 'https://status.atlassian.com', match: 'Jira' } as const;
const CONFLUENCE = { kind: 'statuspage', base: 'https://status.atlassian.com', match: 'Confluence' } as const;

const summary = (indicator: string, incidents: unknown[] = [], components: unknown[] = []) => ({
  status: { indicator, description: indicator === 'none' ? 'All Systems Operational' : 'Partial System Outage' },
  components,
  incidents,
});

function checker(handler: Parameters<typeof fakeFetch>[0], clock = () => 0) {
  const f = fakeFetch(handler);
  return { status: createStatusChecker({ fetch: f.fetch }, clock), calls: f.calls };
}

describe('Statuspage feeds', () => {
  it('reads the page indicator and open incidents', async () => {
    const { status, calls } = checker(() => jsonResponse(summary('major', [{ name: 'Actions delayed', impact: 'major', status: 'investigating', components: [] }])));
    expect(await status.check(GITHUB)).toEqual({ level: 'outage', summary: 'Partial System Outage', incidents: ['Actions delayed'] });
    expect(calls[0].url).toBe('https://www.githubstatus.com/api/v2/summary.json');
  });
  it.each([
    ['none', 'operational'],
    ['minor', 'degraded'],
    ['critical', 'outage'],
    ['maintenance', 'maintenance'],
  ])('maps indicator %s to %s', async (indicator, level) => {
    const { status } = checker(() => jsonResponse(summary(indicator)));
    expect((await status.check(GITHUB)).level).toBe(level);
  });
  it('filters a shared page down to one product', async () => {
    const page = summary('minor', [
      { name: 'Bitbucket pipelines slow', impact: 'minor', components: [{ name: 'Bitbucket Pipelines' }] },
      { name: 'Jira search errors', impact: 'major', components: [{ name: 'Jira' }] },
    ]);
    const { status, calls } = checker(() => jsonResponse(page));
    expect(await status.check(JIRA)).toEqual({ level: 'outage', summary: 'Jira has an active incident.', incidents: ['Jira search errors'] });
    expect(await status.check(CONFLUENCE)).toEqual({ level: 'operational', summary: 'No reported issues for Confluence.', incidents: [] });
    expect(calls).toHaveLength(1);
  });
  it('uses matching component status when a page lists components', async () => {
    const { status } = checker(() => jsonResponse(summary('minor', [], [{ name: 'Jira Software', status: 'degraded_performance' }, { name: 'Confluence', status: 'operational' }])));
    expect((await status.check(JIRA)).level).toBe('degraded');
    expect((await status.check(CONFLUENCE)).level).toBe('operational');
  });
});

describe('Slack feed', () => {
  it('maps ok and active incidents', async () => {
    const ok = checker(() => jsonResponse({ status: 'ok', active_incidents: [] }));
    expect(await ok.status.check({ kind: 'slack' })).toEqual({ level: 'operational', summary: 'No reported issues for Slack.', incidents: [] });
    expect(ok.calls[0].url).toBe('https://slack-status.com/api/v2.0.0/current');
    const bad = checker(() => jsonResponse({ status: 'active', active_incidents: [{ title: 'Messages failing to send', type: 'outage' }] }));
    expect(await bad.status.check({ kind: 'slack' })).toEqual({ level: 'outage', summary: 'Slack has an active incident.', incidents: ['Messages failing to send'] });
  });
});

describe('Google Workspace feed', () => {
  const incidents = [
    { begin: '2026-11-18T03:00:00+00:00', end: null, external_desc: '**Gmail** delivery delays\nmore text', status_impact: 'SERVICE_OUTAGE', affected_products: [{ title: 'Gmail' }] },
    { begin: '2026-11-10T03:00:00+00:00', end: '2026-11-10T05:00:00+00:00', external_desc: 'Old Gmail issue', status_impact: 'SERVICE_OUTAGE', affected_products: [{ title: 'Gmail' }] },
    { begin: '2026-11-18T04:00:00+00:00', external_desc: 'Meet audio drops', status_impact: 'SERVICE_DISRUPTION', affected_products: [{ title: 'Google Meet' }] },
  ];
  it('keeps only active incidents for the product', async () => {
    const { status, calls } = checker(() => jsonResponse(incidents));
    expect(await status.check({ kind: 'google', product: 'Gmail' })).toEqual({ level: 'outage', summary: 'Gmail has an active incident.', incidents: ['Gmail delivery delays'] });
    expect(await status.check({ kind: 'google', product: 'Google Meet' })).toMatchObject({ level: 'degraded', incidents: ['Meet audio drops'] });
    expect(await status.check({ kind: 'google', product: 'Google Drive' })).toMatchObject({ level: 'operational', incidents: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://www.google.com/appsstatus/dashboard/incidents.json');
  });
});

describe('failures are unknown, never operational', () => {
  it.each([
    ['HTTP 500', () => jsonResponse({}, 500)],
    ['malformed JSON', () => new Response('<html>', { status: 200 })],
    ['wrong shape', () => jsonResponse({ hello: 'world' })],
    ['network error', () => { throw new TypeError('fetch failed'); }],
  ])('%s', async (_label, handler) => {
    const { status } = checker(handler);
    const out = await status.check(GITHUB);
    expect(out.level).toBe('unknown');
    expect(out.summary).toMatch(/could not/i);
  });
  it('times out after the cap', async () => {
    const status = createStatusChecker({ fetch: hangingFetch() }, () => 0, 30);
    expect((await status.check({ kind: 'slack' })).level).toBe('unknown');
  });
});

describe('cache', () => {
  it('reuses a good answer for 60 seconds and never caches failures', async () => {
    let t = 0;
    let down = true;
    const { status, calls } = checker(() => (down ? jsonResponse({}, 503) : jsonResponse(summary('none'))), () => t);
    expect((await status.check(GITHUB)).level).toBe('unknown');
    down = false;
    expect((await status.check(GITHUB)).level).toBe('operational');
    t = 59_000;
    await status.check(GITHUB);
    expect(calls).toHaveLength(2);
    t = 61_000;
    await status.check(GITHUB);
    expect(calls).toHaveLength(3);
  });
});
