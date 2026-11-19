import { describe, expect, it, vi } from 'vitest';
import { failure, success } from '@/lib/integrations/http';
import type { KbArticle } from '@/lib/integrations/servicenow-kb';
import type { LiveStatus, NewTicket } from '@/lib/integrations/types';
import { beginTool, runTool } from '@/lib/domain/tools';
import { MINUTE } from '@/lib/domain/time';
import { NOW, call, codeOf, confirmed, freshState } from './helpers';

const statusOf = (live: LiveStatus) => ({ check: vi.fn(async () => live) });
const ARTICLE: KbArticle = { number: 'KB0020001', title: 'Submit an expense report', summary: 'Open SAP Concur and choose Expense.' };

describe('checkServiceStatus', () => {
  it('reports the seeded internal outage and offers to follow it, without any outbound call', async () => {
    const status = statusOf({ level: 'operational', summary: '', incidents: [] });
    const out = await call(freshState(), 'checkServiceStatus', { service: 'concur' }, { status });
    expect(out.status).toBe(200);
    expect(out.result.say).toMatch(/SAP Concur expense submissions failing/);
    expect(out.result.say).toMatch(/I-N-C one one nine five zero/);
    expect(out.result.say).toMatch(/14 people/);
    expect(out.result.data).toMatchObject({ level: 'outage', source: 'internal', incident: 'INC0011950' });
    expect(status.check).not.toHaveBeenCalled();
    expect(out.result.say).not.toMatch(/\?/);
    expect(out.result.next).toMatch(/followOutage/);
  });
  it('says the VPN has no outage, so troubleshooting is next', async () => {
    const out = await call(freshState(), 'checkServiceStatus', { service: 'GlobalProtect' });
    expect(out.result.data).toMatchObject({ level: 'operational', source: 'internal' });
    expect(out.result.say).toMatch(/no known issues/i);
  });
  it('uses the live status page for SaaS', async () => {
    const status = statusOf({ level: 'degraded', summary: 'GitHub has an active incident.', incidents: ['Actions delayed'] });
    const out = await call(freshState(), 'checkServiceStatus', { service: 'git hub' }, { status });
    expect(status.check).toHaveBeenCalledWith({ kind: 'statuspage', base: 'https://www.githubstatus.com' });
    expect(out.result.data).toMatchObject({ level: 'degraded', source: 'live', incidents: ['Actions delayed'] });
    expect(out.result.say).toMatch(/Actions delayed/);
  });
  it('never calls an unreachable status page operational', async () => {
    const out = await call(freshState(), 'checkServiceStatus', { service: 'Slack' }, { status: statusOf({ level: 'unknown', summary: 'x', incidents: [] }) });
    expect(out.result.data).toMatchObject({ level: 'unknown' });
    expect(out.result.say).toMatch(/couldn't reach/i);
    expect(out.result.say).not.toMatch(/operational|no reported issues|is up/i);
  });
  it('refuses unknown services with the list it can check', async () => {
    const out = await call(freshState(), 'checkServiceStatus', { service: 'mainframe' });
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('unknown_service');
    expect(out.result.suggestions).toContain('GitHub');
  });
});

describe('followOutage', () => {
  it('asks for a yes first and changes nothing until it comes', async () => {
    const addNote = vi.fn(async () => success(null));
    const prep = await call(freshState(), 'followOutage', { incident: 'I N C 11950' }, { tickets: { addNote } });
    expect(prep.status).toBe(200);
    expect(prep.result.say).toBe('Shall I add you to the SAP Concur outage, I-N-C one one nine five zero, as affected?');
    expect(prep.result.data).toMatchObject({ status: 'awaiting_confirmation', confirmationCode: expect.any(String) });
    expect(prep.result.next).toMatch(/confirmAction/);
    expect(prep.state.pending[0].payload).toEqual({ kind: 'outage', incident: 'INC0011950' });
    expect(addNote).not.toHaveBeenCalled();
    expect(prep.state.outages[0]).toMatchObject({ followed: false, affected: 14 });
    expect(prep.state.metrics).toMatchObject({ duplicatesAvoided: 0, minutesSaved: 0 });
    expect(prep.alerts).toEqual([]);
  });
  it('adds Priya to the master incident on her yes, instead of a duplicate ticket', async () => {
    const addNote = vi.fn(async () => success(null));
    const out = await confirmed(freshState(), 'followOutage', { incident: 'I N C 11950' }, { tickets: { addNote } });
    expect(out.status).toBe(200);
    expect(addNote).toHaveBeenCalledWith({ number: 'INC0011950', sysId: null }, expect.stringMatching(/Priya Sharma.*NB-2231/));
    expect(out.state.outages[0]).toMatchObject({ followed: true, affected: 15 });
    expect(out.state.metrics).toMatchObject({ duplicatesAvoided: 1, minutesSaved: 10 });
    expect(out.result.say).toMatch(/no duplicate ticket/i);
    const again = await call(out.state, 'followOutage', { incident: 'concur' }, { tickets: { addNote } });
    expect(again.result.say).toMatch(/already/i);
    expect(again.result.data).toEqual({ alreadyFollowing: true });
    expect(again.state.pending).toHaveLength(1);
    expect(addNote).toHaveBeenCalledTimes(1);
    expect(again.state.metrics.duplicatesAvoided).toBe(1);
  });
  it('accepts an empty incident when there is one outage', async () => {
    expect((await confirmed(freshState(), 'followOutage', { incident: '' })).state.outages[0].followed).toBe(true);
  });
  it('commits once: a second confirm and a second prepared follow change nothing', async () => {
    const addNote = vi.fn(async () => success(null));
    const a = await call(freshState(), 'followOutage', { incident: '' });
    const b = await call(a.state, 'followOutage', { incident: 'concur' });
    const first = await call(b.state, 'confirmAction', { code: codeOf(a.result) }, { tickets: { addNote } });
    const repeat = await call(first.state, 'confirmAction', { code: codeOf(a.result) }, { tickets: { addNote } });
    expect(repeat.result.data).toMatchObject({ alreadyDone: true });
    const other = await call(repeat.state, 'confirmAction', { code: codeOf(b.result) }, { tickets: { addNote } });
    expect(other.result.say).toMatch(/already on I-N-C one one nine five zero/);
    expect(addNote).toHaveBeenCalledTimes(1);
    expect(other.state.outages[0].affected).toBe(15);
    expect(other.state.metrics.duplicatesAvoided).toBe(1);
  });
  it('does nothing after a cancel or once the yes expired', async () => {
    const addNote = vi.fn(async () => success(null));
    const prep = await call(freshState(), 'followOutage', { incident: '' });
    const code = codeOf(prep.result);
    const late = await call(prep.state, 'confirmAction', { code }, { now: NOW + 5 * MINUTE + 1, tickets: { addNote } });
    expect(late.result.error).toBe('action_expired');
    const cancelled = await call(prep.state, 'cancelAction', { code });
    const after = await call(cancelled.state, 'confirmAction', { code }, { tickets: { addNote } });
    expect(after.result.error).toBe('action_cancelled');
    expect(addNote).not.toHaveBeenCalled();
    expect(after.state.outages[0].followed).toBe(false);
  });
  it('does not mark the outage followed when ServiceNow fails, so saying yes again retries', async () => {
    const prep = await call(freshState(), 'followOutage', { incident: 'INC0011950' });
    const code = codeOf(prep.result);
    const out = await call(prep.state, 'confirmAction', { code }, { tickets: { addNote: async () => failure({ kind: 'unavailable', status: 503 }) } });
    expect(out.result.error).toBe('follow_not_synced');
    expect(out.state.outages[0]).toMatchObject({ followed: false, syncFailed: true, affected: 14 });
    expect(out.state.metrics).toMatchObject({ duplicatesAvoided: 0, minutesSaved: 0 });
    expect(out.state.pending[0].status).toBe('pending');
    expect(out.alerts).toEqual([]);
    expect(out.result.say).toMatch(/couldn't add you in ServiceNow/);
    expect(out.result.next).toMatch(/confirmAction again with the same code/);
    const retry = await call(out.state, 'confirmAction', { code });
    expect(retry.state.outages[0]).toMatchObject({ followed: true, affected: 15 });
    expect(retry.state.outages[0].syncFailed).toBeUndefined();
    expect(retry.state.metrics.duplicatesAvoided).toBe(1);
  });
  it('rejects unknown outages, and an outage that ended before the yes', async () => {
    const out = await call(freshState(), 'followOutage', { incident: 'vpn' });
    expect(out.result.error).toBe('unknown_outage');
    const prep = await call(freshState(), 'followOutage', { incident: '' });
    const ended = { ...prep.state, outages: [] };
    const late = await call(ended, 'confirmAction', { code: codeOf(prep.result) });
    expect(late.result.error).toBe('unknown_outage');
    expect(late.state.pending[0].status).toBe('cancelled');
  });
});

describe('knowledge and guided fixes', () => {
  it('searches the knowledge base', async () => {
    const out = await call(freshState(), 'searchKnowledge', { query: 'vpn keeps dropping' });
    expect(out.result.data).toMatchObject({ articles: [expect.objectContaining({ id: 'vpn', steps: 5 })] });
    expect(out.result.next).toMatch(/startTroubleshooting/);
    expect((await call(freshState(), 'searchKnowledge', { query: 'banana smoothie' })).result.error).toBe('no_results');
  });
  it('does not ask ServiceNow when a local guide fits well', async () => {
    const search = vi.fn(async () => success([ARTICLE]));
    const out = await call(freshState(), 'searchKnowledge', { query: 'my external monitor is not detected' }, { knowledge: { search } });
    expect(search).not.toHaveBeenCalled();
    expect(out.result.data).toEqual({ articles: [expect.objectContaining({ id: 'external-monitor' }), expect.objectContaining({ id: 'external-webcam' })] });
  });
  it('adds up to two ServiceNow articles when the local guides fit poorly', async () => {
    const search = vi.fn(async () => success([ARTICLE, { number: 'KB0020002', title: 'Concur mobile app (iOS) [beta]', summary: 'Use the app.' }]));
    const out = await call(freshState(), 'searchKnowledge', { query: 'how do I submit an expense report in Concur?' }, { knowledge: { search } });
    expect(search).toHaveBeenCalledWith('submit expense report concur');
    expect(out.result.data).toMatchObject({
      articles: [expect.objectContaining({ id: 'phishing' })],
      serviceNow: [ARTICLE, { number: 'KB0020002', title: 'Concur mobile app (iOS) [beta]', summary: 'Use the app.' }],
    });
    expect(out.result.say).toMatch(/^ServiceNow has two articles that may fit: "Submit an expense report"; "Concur mobile app iOS beta"\. I also have a guide, "Report a phishing or suspicious email"\. Which sounds closer/);
    expect(out.result.next).toMatch(/startTroubleshooting/);
    expect(out.result.next).toMatch(/summary/);
  });
  it('offers a ServiceNow article when no local guide matches at all', async () => {
    const search = vi.fn(async () => success([ARTICLE]));
    const out = await call(freshState(), 'searchKnowledge', { query: 'parking pass' }, { knowledge: { search } });
    expect(out.status).toBe(200);
    expect(out.state.events.at(-1)?.title).toBe('Knowledge: ServiceNow KB0020001');
    expect(out.result.data).toEqual({ articles: [], serviceNow: [ARTICLE] });
    expect(out.result.say).toMatch(/don't have a guided fix.*ServiceNow has an article: "Submit an expense report"/);
    expect(out.result.next).toMatch(/prepareTicket/);
  });
  it('uses the simulated ServiceNow articles without credentials', async () => {
    const out = await call(freshState(), 'searchKnowledge', { query: 'how do I set up an email signature' });
    expect(out.result.data).toMatchObject({ serviceNow: [expect.objectContaining({ number: 'KB0010002' })] });
  });
  it('falls back to the local answer when ServiceNow fails or finds nothing', async () => {
    const timeout = { search: async () => failure<KbArticle[]>({ kind: 'timeout' }) };
    const weak = await call(freshState(), 'searchKnowledge', { query: 'excel macro error' }, { knowledge: timeout });
    expect(weak.result.data).toEqual({ articles: [expect.objectContaining({ id: 'app-frozen' }), expect.anything()] });
    expect(weak.result.say).toMatch(/^Best match/);
    const none = await call(freshState(), 'searchKnowledge', { query: 'parking pass' }, { knowledge: timeout });
    expect(none.result.error).toBe('no_results');
    const empty = await call(freshState(), 'searchKnowledge', { query: 'parking pass' }, { knowledge: { search: async () => success([]) } });
    expect(empty.result.error).toBe('no_results');
  });
  it('starts a guided fix at step 1', async () => {
    const out = await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: 'VPN drops every few minutes' });
    expect(out.result.say).toMatch(/^Step 1 of 5: Click the GlobalProtect globe/);
    expect(out.state.troubleshooting).toMatchObject({ articleId: 'vpn', stepIndex: 0, status: 'active', issue: 'VPN drops every few minutes', log: [] });
  });
  it('refuses an unknown article and suggests close ones', async () => {
    const out = await call(freshState(), 'startTroubleshooting', { articleId: 'vpn-advanced', issue: 'vpn drops' });
    expect(out.result.error).toBe('unknown_article');
    expect(out.result.suggestions).toContain('vpn');
    expect(out.state.troubleshooting).toBeNull();
  });
  it('needs an active fix before reporting a step', async () => {
    const out = await call(freshState(), 'reportStep', { outcome: 'done', note: '' });
    expect(out.result.error).toBe('no_troubleshooting');
  });
  it('walks the steps, logs each outcome, and stops past the last one', async () => {
    let s = (await call(freshState(), 'startTroubleshooting', { articleId: 'mfa-new-phone', issue: '' })).state;
    let out = await call(s, 'reportStep', { outcome: 'done', note: '' });
    expect(out.result.say).toMatch(/^Step 2 of 3/);
    out = await call(out.state, 'reportStep', { outcome: 'not_fixed', note: 'no option visible' });
    out = await call(out.state, 'reportStep', { outcome: 'skipped', note: '' });
    expect(out.result.data).toMatchObject({ exhausted: true });
    expect(out.result.say).toMatch(/last step/i);
    expect(out.result.next).toMatch(/prepareTicket/);
    expect(out.state.troubleshooting?.log.map((l) => l.outcome)).toEqual(['done', 'not_fixed', 'skipped']);
    s = out.state;
    const past = await call(s, 'reportStep', { outcome: 'not_fixed', note: '' });
    expect(past.status).toBe(422);
    expect(past.result.error).toBe('steps_finished');
    expect(past.state.troubleshooting?.log).toHaveLength(3);
  });
  it('marks the fix as working on "fixed"', async () => {
    const s = (await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: '' })).state;
    const out = await call(s, 'reportStep', { outcome: 'fixed', note: '' });
    expect(out.state.troubleshooting?.status).toBe('fixed');
    expect(out.result.next).toMatch(/markResolved/);
  });
});

describe('markResolved', () => {
  async function fixed() {
    const s = (await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: 'VPN drops' })).state;
    return (await call(s, 'reportStep', { outcome: 'fixed', note: 'reconnect worked' })).state;
  }
  it('asks for a yes before logging anything', async () => {
    const create = vi.fn();
    const prep = await call(await fixed(), 'markResolved', { summary: 'VPN fixed by reconnecting GlobalProtect' }, { tickets: { create } });
    expect(prep.result.say).toBe('Shall I log this as fixed on the call: VPN fixed by reconnecting GlobalProtect?');
    expect(prep.result.data).toMatchObject({ status: 'awaiting_confirmation' });
    expect(prep.state.pending[0].payload).toMatchObject({ kind: 'resolution', summary: 'VPN fixed by reconnecting GlobalProtect' });
    expect(create).not.toHaveBeenCalled();
    expect(prep.state.tickets).toHaveLength(2);
    expect(prep.state.metrics).toMatchObject({ resolvedByAgent: 0, minutesSaved: 0 });
    expect(prep.state.troubleshooting?.status).toBe('fixed');
    expect(prep.alerts).toEqual([]);
  });
  it('logs a resolved incident on her yes and counts the deflection once', async () => {
    const create = vi.fn(async (_t: NewTicket) => success({ number: 'INC0012001', sysId: 'sys-1' }));
    const resolve = vi.fn(async () => success(null));
    const out = await confirmed(await fixed(), 'markResolved', { summary: 'VPN fixed by reconnecting GlobalProtect' }, { tickets: { create, resolve } });
    expect(out.status).toBe(200);
    expect(create.mock.calls[0][0].correlationId).toMatch(/^askit:NMB-7K2:\d+$/);
    expect(create.mock.calls[0][0]).toMatchObject({ shortDescription: 'Resolved by ASK IT: VPN fixed by reconnecting GlobalProtect', category: 'network' });
    expect(create.mock.calls[0][0].description).toMatch(/1\. Click the GlobalProtect globe.*Result: fixed it/);
    expect(resolve).toHaveBeenCalledWith({ number: 'INC0012001', sysId: 'sys-1' }, expect.stringContaining('VPN fixed'));
    expect(out.state.tickets[0]).toMatchObject({ number: 'INC0012001', state: 'Resolved', raisedHere: true });
    expect(out.state.metrics).toMatchObject({ resolvedByAgent: 1, minutesSaved: 20 });
    expect(out.state.troubleshooting?.status).toBe('resolved');
    expect(out.result.next).toMatch(/scheduleReminder/);
    const again = await call(out.state, 'markResolved', { summary: 'again' }, { tickets: { create, resolve } });
    expect(again.result.say).toMatch(/already/i);
    expect(again.result.data).toMatchObject({ alreadyResolved: true, number: 'INC0012001' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(again.state.metrics.resolvedByAgent).toBe(1);
  });
  it('uses simulated numbers from INC0012001', async () => {
    const out = await confirmed(await fixed(), 'markResolved', { summary: 'VPN fixed' });
    expect(out.state.tickets[0]).toMatchObject({ number: 'INC0012001', source: 'simulated', state: 'Resolved' });
  });
  it('keeps a local record when ServiceNow refuses', async () => {
    const out = await confirmed(await fixed(), 'markResolved', { summary: 'VPN fixed' }, { tickets: { mode: 'live', create: async () => failure({ kind: 'rejected', status: 403 }) } });
    expect(out.state.tickets[0]).toMatchObject({ number: expect.stringMatching(/^LOCAL-/), syncFailed: true, state: 'Resolved' });
    expect(out.result.say).toMatch(/couldn't log it in ServiceNow: ServiceNow rejected the request/);
    expect(out.state.metrics.resolvedByAgent).toBe(1);
  });
  it('is honest when ServiceNow is down or only half done', async () => {
    const down = await confirmed(await fixed(), 'markResolved', { summary: 'VPN fixed' }, { tickets: { mode: 'live', create: async () => failure({ kind: 'unavailable', status: 503 }) } });
    expect(down.result.say).toMatch(/^Glad it's fixed\. I couldn't log it in ServiceNow: ServiceNow is having problems right now\./);
    expect(down.result.say).not.toMatch(/Logged as resolved/);
    const half = await confirmed(await fixed(), 'markResolved', { summary: 'VPN fixed' }, { tickets: { create: async () => success({ number: 'INC0012001', sysId: 's1' }), resolve: async () => failure({ kind: 'timeout' }) } });
    expect(half.result.say).toMatch(/logged it as I-N-C one two zero zero one, but couldn't close it in ServiceNow/);
    expect(half.state.tickets[0]).toMatchObject({ number: 'INC0012001', state: 'New', syncFailed: true });
  });
  it('does not claim failure when the outcome is unknown', async () => {
    const out = await confirmed(await fixed(), 'markResolved', { summary: 'VPN fixed' }, { tickets: { mode: 'live', create: async () => failure({ kind: 'timeout' }) } });
    expect(out.result.say).toMatch(/not sure ServiceNow logged it/);
    expect(out.result.say).not.toMatch(/couldn't log/);
  });
  it('discards a cancelled resolution without logging it', async () => {
    const create = vi.fn();
    const prep = await call(await fixed(), 'markResolved', { summary: 'VPN fixed' });
    const cancelled = await call(prep.state, 'cancelAction', { code: codeOf(prep.result) });
    const late = await call(cancelled.state, 'confirmAction', { code: codeOf(prep.result) }, { tickets: { create } });
    expect(late.result.error).toBe('action_cancelled');
    expect(create).not.toHaveBeenCalled();
    expect(late.state.metrics.resolvedByAgent).toBe(0);
  });
});

describe('markResolved commits', () => {
  it('lets only one of two parallel confirms create the incident', async () => {
    const prep = await call(freshState(), 'markResolved', { summary: 'Printer fixed' });
    const code = codeOf(prep.result);
    const a = beginTool('confirmAction', prep.state, { code }, NOW, 'A')!;
    expect(beginTool('confirmAction', a, { code }, NOW, 'B')).toBeNull();
    const loser = runTool('confirmAction', a, { code }, NOW, undefined, 'B');
    expect(loser.result.error).toBe('in_progress');
    const winner = await call(a, 'confirmAction', { code }, { claim: 'A' });
    expect(winner.state.metrics.resolvedByAgent).toBe(1);
  });
  it('does not log the same resolution twice, even when it was prepared twice', async () => {
    const create = vi.fn(async () => success({ number: 'INC0012001', sysId: 's1' }));
    const a = await call(freshState(), 'markResolved', { summary: 'Printer fixed after re-adding it' });
    const b = await call(a.state, 'markResolved', { summary: 'printer fixed after re-adding it.' });
    const once = await call(b.state, 'confirmAction', { code: codeOf(a.result) }, { tickets: { create } });
    const twice = await call(once.state, 'confirmAction', { code: codeOf(b.result) }, { tickets: { create } });
    expect(twice.result.say).toMatch(/already/i);
    expect(create).toHaveBeenCalledTimes(1);
    expect(twice.state.metrics.resolvedByAgent).toBe(1);
    const again = await call(twice.state, 'markResolved', { summary: 'Printer fixed after re-adding it' });
    expect(again.result.data).toMatchObject({ alreadyResolved: true });
    const other = await confirmed(again.state, 'markResolved', { summary: 'Outlook syncing again' });
    expect(other.state.metrics.resolvedByAgent).toBe(2);
  });
});

describe('wrapUpCall', () => {
  it('summarises the call, queues the post and stores a document', async () => {
    let s = (await confirmed(freshState(), 'followOutage', { incident: '' })).state;
    s = (await call(s, 'startTroubleshooting', { articleId: 'vpn', issue: 'VPN drops' })).state;
    s = (await call(s, 'reportStep', { outcome: 'fixed', note: '' })).state;
    s = (await confirmed(s, 'markResolved', { summary: 'VPN reconnect fixed it' })).state;
    const out = await call(s, 'wrapUpCall', {}, { notifyMode: 'live' });
    const posted = out.alerts[0].text;
    expect(posted).toMatch(/Priya Sharma/);
    expect(posted).toMatch(/INC0012001/);
    expect(posted).toMatch(/INC0011950/);
    expect(out.state.documents[0]).toMatchObject({ kind: 'callSummary' });
    expect(out.state.documents[0].markdown).toMatch(/Resolved without IT/);
    expect(out.state.notifications.at(-1)).toMatchObject({ kind: 'callSummary', status: 'queued' });
    expect(out.result.say).toMatch(/posting the summary to the IT channel/);
  });
  it('says the post is simulated without a webhook', async () => {
    const out = await call(freshState(), 'wrapUpCall', {});
    expect(out.result.say).toMatch(/simulated/);
  });
});
