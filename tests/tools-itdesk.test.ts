import { describe, expect, it, vi } from 'vitest';
import { failure, success } from '@/lib/integrations/http';
import type { DeskAdapter, DeskIncident } from '@/lib/integrations/types';
import { MemoryStore } from '@/lib/server/store';
import { createSession, loadSession } from '@/lib/server/session';
import { executeTool } from '@/lib/server/execute';
import { toolsFor } from '@/lib/domain/tools';
import { incidentAge } from '@/lib/domain/tools/itdesk';
import { DAY, MINUTE, zonedTime } from '@/lib/domain/time';
import type { SessionState } from '@/lib/domain/types';
import { NOW, call, codeOf, freshState, makeDeps } from './helpers';

type QueueItem = { position: number; number: string; summary: string; assignee: string | null };
const items = (data: unknown) => (data as { incidents: QueueItem[] }).incidents;

async function opened(ticket: string, state = freshState()) {
  return call(state, 'openIncident', { ticket });
}

const NO_CHANGES = { assignedTo: '', assignmentGroup: '', state: '', holdReason: '', priority: '', urgency: '', impact: '', category: '', workNote: '', comment: '', resolutionNotes: '' };
const update = (state: SessionState, changes: Partial<typeof NO_CHANGES> & { ticket?: string }, o: Parameters<typeof call>[3] = {}) =>
  call(state, 'prepareIncidentUpdate', { ticket: '', ...NO_CHANGES, ...changes }, o);

describe('IT desk persona tools', () => {
  it('are separate from the employee tools', () => {
    expect(toolsFor('itdesk').map((t) => t.name).sort()).toEqual(['cancelAction', 'confirmAction', 'countIncidents', 'listQueue', 'listResources', 'openIncident', 'prepareIncidentUpdate', 'requestUpdate', 'showDashboard', 'showImpact', 'showResource']);
    const employee = toolsFor('employee').map((t) => t.name);
    expect(employee).toHaveLength(21);
    expect(employee).not.toContain('listQueue');
  });
});

const Q = { priority: '', state: '', assignee: '', group: '', category: '', opened: '', keyword: '', sort: '' };
const list = (args: Partial<typeof Q>, state = freshState(), o: Parameters<typeof call>[3] = {}) => call(state, 'listQueue', { ...Q, ...args }, o);
const C = { priority: '', state: '', assignee: '', group: '', category: '', opened: '', keyword: '', groupBy: '' };
const count = (args: Partial<typeof C>, state = freshState(), o: Parameters<typeof call>[3] = {}) => call(state, 'countIncidents', { ...C, ...args }, o);
const TODAY = NOW - 570 * MINUTE;

describe('listQueue', () => {
  it('sums up the open queue instead of reading it, and puts all of it on screen', async () => {
    const out = await list({});
    expect(out.status).toBe(200);
    expect(out.result.say).toBe("Here are 14 open incidents, 3 critical and 4 unassigned. They're on your screen. Want details on any of them?");
    expect(out.result.say).not.toMatch(/I-N-C|First/);
    expect(items(out.result.data).map((i) => i.number).slice(0, 5)).toEqual(['INC0013002', 'INC0013003', 'INC0013001', 'INC0013004', 'INC0013006']);
    expect(items(out.result.data)).toHaveLength(14);
    expect(out.result.data).toMatchObject({ onScreen: 14, critical: 3, unassigned: 4 });
    expect(out.state.itdesk.queue).toHaveLength(14);
    expect(out.state.itdesk.board).toEqual({ kind: 'list', title: 'Open incidents', total: 14, more: false, at: NOW, query: {} });
    expect(out.result.next).toMatch(/openIncident/);
    expect(out.result.next).toMatch(/not read/i);
  });
  it('combines filters and asks ServiceNow for one more than the screen holds', async () => {
    const listOpen = vi.fn(async () => success([] as DeskIncident[]));
    const out = await list({ priority: 'critical', assignee: 'unassigned', opened: 'today', sort: 'newest' }, freshState(), { desk: { listOpen } });
    expect(listOpen).toHaveBeenCalledWith({ priority: 'critical', assignee: { kind: 'none' }, opened: 'today', since: TODAY, sort: 'newest' }, 26);
    expect(out.state.itdesk.board).toMatchObject({ query: { priority: 'critical', assignee: 'unassigned', opened: 'today', sort: 'newest' } });
  });
  it.each([
    [{ opened: 'today' }, ['13003', '13001', '13007'], "Here are 3 incidents opened today, 2 critical and 3 unassigned. They're on your screen. Want details on any of them?"],
    [{ priority: 'critical', opened: 'today' }, ['13003', '13001'], "Here are 2 critical incidents opened today, 2 unassigned. They're on your screen. Want details on any of them?"],
    [{ assignee: 'unassigned' }, ['13003', '13001', '13007', '13005'], "Here are 4 unassigned incidents, 2 critical. They're on your screen. Want details on any of them?"],
    [{ group: 'software', state: 'in_progress' }, ['13002', '13004'], "Here are 2 in-progress incidents in the software group, 1 critical. They're on your screen. Want details on any of them?"],
    [{ priority: 'moderate', assignee: 'assigned' }, ['13006', '13009', '13012'], "Here are 3 moderate-priority incidents assigned to someone. They're on your screen. Want details on any of them?"],
  ])('%j', async (args, numbers, say) => {
    const out = await list(args);
    expect(out.state.itdesk.queue.map((i) => i.number.slice(-5))).toEqual(numbers);
    expect(out.result.say).toBe(say);
  });
  it('names a single match briefly and offers the details', async () => {
    const out = await list({ assignee: 'David Loo' });
    expect(out.state.itdesk.queue.map((i) => i.number)).toEqual(['INC0013006']);
    expect(out.result.say).toBe("There's one incident assigned to David Loo, I-N-C one three zero zero six, Laptop battery swelling on NB-1877. Want the details?");
    expect((await list({ keyword: 'the backup issue' })).result.say).toBe("There's one incident about “backup”, I-N-C one three zero zero seven, Database backup job running slow. Want the details?");
  });
  it('lists resolved incidents without open-queue breakdowns', async () => {
    const s = freshState();
    s.itdesk.backlog = s.itdesk.backlog.map((i, n) => (n < 3 ? { ...i, state: '6', stateLabel: 'Resolved', assignee: null } : i));
    const out = await list({ state: 'resolved' }, s);
    expect(out.state.itdesk.queue.map((i) => i.number)).toEqual(['INC0013002', 'INC0013003', 'INC0013001']);
    expect(out.result.say).toBe("Here are 3 resolved incidents. They're on your screen. Want details on any of them?");
    expect((await list({ state: 'closed' }, s)).result.say).toBe('There are no closed incidents. Want me to widen the filter?');
    expect((await list({}, s)).state.itdesk.queue.map((i) => i.number)).not.toContain('INC0013001');
  });
  it('says how many are shown when more match than the screen holds', async () => {
    const rows = Array.from({ length: 26 }, () => freshState().itdesk.backlog[0]);
    const out = await list({}, freshState(), { desk: { listOpen: async () => success(rows) } });
    expect(out.state.itdesk.queue).toHaveLength(25);
    expect(out.state.itdesk.board).toMatchObject({ total: 25, more: true });
    expect(out.result.say).toBe("There are more than 25 open incidents. The top 25 by priority are on your screen. Want details on any of them, or a narrower filter?");
    const newest = await list({ sort: 'newest' }, freshState(), { desk: { listOpen: async () => success(rows) } });
    expect(newest.result.say).toMatch(/^There are more than 25 open incidents\. The 25 newest are on your screen\./);
  });
  it('says nothing matched and suggests a wider filter', async () => {
    const out = await list({ priority: 'moderate', opened: 'yesterday' });
    expect(out.result.say).toBe('There are no moderate-priority incidents opened yesterday. Want me to check this week instead?');
    expect(out.state.itdesk.board).toMatchObject({ kind: 'list', title: 'Moderate-priority incidents opened yesterday', total: 0 });
    expect(out.state.itdesk.queue).toEqual([]);
    expect((await list({ category: 'database', opened: 'this_week', state: 'on_hold' })).result.say).toBe('There are no on-hold incidents in the database category opened this week. Want me to check this month instead?');
    expect((await list({ group: 'payroll', priority: 'critical' })).result.say).toBe('There are no critical incidents in the payroll group. Want me to widen the filter?');
    expect((await list({}, freshState(), { desk: { listOpen: async () => success([]) } })).result.say).toBe('There are no open incidents right now. The queue is clear.');
  });
  it('never puts a semicolon, colon or dash in what it says', async () => {
    for (const args of [{}, { assignee: 'David Loo' }, { priority: 'moderate', opened: 'yesterday' }, { state: 'resolved' }]) {
      expect((await list(args)).result.say.replace(/\w-(?=\w)/g, '')).not.toMatch(/[;:\u2013\u2014-]/);
    }
  });
  it('refuses a filter that could break the query, without calling ServiceNow', async () => {
    const listOpen = vi.fn(async () => success([] as DeskIncident[]));
    const out = await list({ assignee: 'x^ORactive=false' }, freshState(), { desk: { listOpen } });
    expect(out.status).toBe(422);
    expect(out.result).toMatchObject({ error: 'invalid_filter', say: "I couldn't use that assignee. Could you say it another way?" });
    expect(listOpen).not.toHaveBeenCalled();
  });
  it('says honestly when ServiceNow cannot be read', async () => {
    const out = await list({}, freshState(), { desk: { listOpen: async () => failure({ kind: 'timeout' }) } });
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('queue_unavailable');
    expect(out.result.say).toMatch(/ServiceNow did not answer in time/);
  });
});

describe('countIncidents', () => {
  it('counts with filters and shows the number', async () => {
    const out = await count({ priority: 'critical', assignee: 'unassigned' });
    expect(out.result.say).toBe('There are 2 critical unassigned incidents.');
    expect(out.result.data).toEqual({ total: 2, more: false, groups: [] });
    expect(out.state.itdesk.board).toEqual({ kind: 'count', title: 'Critical unassigned incidents', total: 2, more: false, groupBy: null, groups: [], at: NOW, query: { priority: 'critical', assignee: 'unassigned' } });
  });
  it('uses the singular and says none plainly', async () => {
    expect((await count({ state: 'on_hold' })).result.say).toBe('There is 1 on-hold incident.');
    expect((await count({ priority: 'low', opened: 'today' })).result.say).toBe('There are no low-priority incidents opened today.');
  });
  it('breaks the count down and reads the top four', async () => {
    const out = await count({ groupBy: 'group' });
    expect(out.result.say).toBe('There are 14 open incidents. By group: Software 3, Database 2, Finance Systems 2, Service Desk 2, and the rest are on your screen.');
    expect(out.state.itdesk.board).toMatchObject({ kind: 'count', groupBy: 'group', groups: expect.arrayContaining([{ label: 'Other', count: 2 }]) });
    expect((await count({ opened: 'this_week', groupBy: 'opened' })).result.say).toBe('There are 9 incidents opened this week. By day opened: Today 3, Yesterday 2, Mon 16 Nov 4.');
  });
  it('asks ServiceNow for up to 501 and says when there are more than 500', async () => {
    const listOpen = vi.fn(async () => success(Array.from({ length: 501 }, () => freshState().itdesk.backlog[0] as DeskIncident)));
    const out = await count({}, freshState(), { desk: { listOpen } });
    expect(listOpen).toHaveBeenCalledWith({ sort: 'priority' }, 501);
    expect(out.result.say).toBe('There are more than five hundred open incidents.');
    expect(out.state.itdesk.board).toMatchObject({ total: 500, more: true });
  });
  it('fails cleanly', async () => {
    const out = await count({}, freshState(), { desk: { listOpen: async () => failure({ kind: 'timeout' }) } });
    expect(out.result.error).toBe('queue_unavailable');
    expect((await count({ group: 'a=b' })).result.error).toBe('invalid_filter');
  });
});

describe('showDashboard', () => {
  it('reads the open queue and the last week, and shows the numbers', async () => {
    const listOpen = vi.fn((q: Parameters<DeskAdapter['listOpen']>[0], n: number) => makeDeps(freshState(), NOW).desk.listOpen(q, n));
    const activity = vi.fn(async () => success({ opened: [NOW - MINUTE, NOW - 2 * DAY], resolved: [{ at: NOW - DAY, openedAt: NOW - DAY - 180 * MINUTE }] }));
    const out = await call(freshState(), 'showDashboard', {}, { desk: { listOpen, activity } });
    expect(out.status).toBe(200);
    expect(listOpen).toHaveBeenCalledWith({ sort: 'priority' }, 501);
    expect(activity).toHaveBeenCalledWith(zonedTime('2026-11-12', 0));
    const board = out.state.itdesk.board;
    expect(board).toMatchObject({ kind: 'dashboard', at: NOW, resolvedWeek: 1, resolvedToday: 0, onHold: 1, inProgress: 3, oldest: { number: 'INC0013013' }, avgResolve: { ms: 180 * MINUTE, count: 1 } });
    expect(board?.kind === 'dashboard' && board.days.map((d) => d.opened)).toEqual([0, 0, 0, 0, 1, 0, 1]);
    expect(out.result.say).toBe("Right now there are 14 open incidents, 3 critical, 4 unassigned and 1 on hold. 1 came in today and none were resolved today. The oldest was opened 5 days ago. It's all on your screen.");
  });
  it('keeps the summary short for a quiet desk', async () => {
    const quiet = await call(freshState(), 'showDashboard', {}, { desk: { listOpen: async () => success([]), activity: async () => success({ opened: [], resolved: [{ at: NOW - MINUTE, openedAt: null }, { at: NOW - 2 * MINUTE, openedAt: null }] }) } });
    expect(quiet.result.say).toBe("Right now there are no open incidents. None came in today and 2 were resolved today. It's all on your screen.");
    const one = await call(freshState(), 'showDashboard', {}, { desk: { listOpen: async () => success([{ ...freshState().itdesk.backlog[5] }]), activity: async () => success({ opened: [], resolved: [{ at: NOW - MINUTE, openedAt: null }] }) } });
    expect(one.result.say).toBe("Right now there is 1 open incident, 0 critical, 0 unassigned and 1 on hold. None came in today and 1 was resolved today. The oldest was opened 4 days ago. It's all on your screen.");
  });
  it('says honestly when ServiceNow cannot be read', async () => {
    const out = await call(freshState(), 'showDashboard', {}, { desk: { activity: async () => failure({ kind: 'timeout' }) } });
    expect(out.result).toMatchObject({ ok: false, error: 'queue_unavailable' });
    expect(out.result.say).toMatch(/ServiceNow did not answer in time/);
    expect(out.state.itdesk.board ?? null).toBeNull();
  });
});

describe('requestUpdate', () => {
  const ask = (args: { ticket?: string; within?: string }, state = freshState(), o: Parameters<typeof call>[3] = {}) => call(state, 'requestUpdate', { ticket: '', within: '', ...args }, o);
  it('asks the assignee in the IT channel for an update by a deadline', async () => {
    const out = await ask({ ticket: '13002', within: '3 minutes' }, freshState(), { notifyMode: 'live' });
    expect(out.status).toBe(200);
    expect(out.alerts).toEqual([{ id: expect.any(String), text: 'Update requested: Karthik Nair, the IT desk needs an update on INC0013002, Payroll export failing in SAP, by 9:33 AM. Please reply with where you are and any blockers.' }]);
    expect(out.result.say).toBe("Done. I've asked Karthik Nair in the IT helpdesk channel for an update on I-N-C one three zero zero two by 9:33 AM. I'm alerting the IT channel now.");
    expect(out.state.itdesk.updateRequest).toEqual({ number: 'INC0013002', assignee: 'Karthik Nair', due: NOW + 3 * MINUTE, at: NOW });
    expect(out.state.notifications.at(-1)).toMatchObject({ kind: 'updateRequest', status: 'queued' });
  });
  it.each([
    ['', 15],
    ['half an hour', 30],
    ['an hour', 60],
    ['in 2 hours', 120],
    ['ten minutes', 10],
    ['10 hours', 240],
  ])('reads "%s" as %i minutes', async (within, minutes) => {
    expect((await ask({ ticket: '13002', within })).state.itdesk.updateRequest?.due).toBe(NOW + minutes * MINUTE);
  });
  it('uses the open incident when no ticket is named', async () => {
    const s = (await opened('13004')).state;
    expect((await ask({}, s)).state.itdesk.updateRequest).toMatchObject({ number: 'INC0013004', assignee: 'Anita Rao' });
  });
  it('asks for an owner first when nobody is assigned', async () => {
    const out = await ask({ ticket: '13001' });
    expect(out.result).toMatchObject({ ok: false, error: 'no_assignee', say: "Nobody is assigned to I-N-C one three zero zero one yet. Who should take it?" });
    expect(out.alerts).toEqual([]);
  });
  it('asks again for a time it cannot read, and for which incident when unclear', async () => {
    expect((await ask({ ticket: '13002', within: 'soonish' })).result).toMatchObject({ ok: false, error: 'invalid_time' });
    expect((await ask({})).result).toMatchObject({ ok: false, error: 'unknown_incident' });
  });
  it('says the post is simulated without Slack', async () => {
    expect((await ask({ ticket: '13002' })).result.say).toMatch(/simulated/);
  });
});

describe('showImpact', () => {
  it('reads what ASK IT has done and shows it', async () => {
    const s = freshState();
    s.metrics = { ...s.metrics, resolvedByAgent: 3, ticketsRaised: 1, duplicatesAvoided: 2, ticketsUpdatedByVoice: 4, minutesSaved: 150 };
    const out = await call(s, 'showImpact', {});
    expect(out.result.say).toBe("So far ASK IT fixed 3 issues on the call, raised 1 ticket, avoided 2 duplicate tickets and updated 4 incidents by voice. That's about 2.5 hours saved, and 83 percent of issues were handled without a new ticket.");
    expect(out.state.itdesk.board).toEqual({ kind: 'impact', at: NOW });
  });
  it('mentions only what happened', async () => {
    const s = freshState();
    s.metrics = { ...s.metrics, ticketsUpdatedByVoice: 1, minutesSaved: 6 };
    expect((await call(s, 'showImpact', {})).result.say).toBe("So far ASK IT updated 1 incident by voice. That's about 0.1 hours saved.");
  });
  it('is honest before anything happened, even after lookups', async () => {
    expect((await call(freshState(), 'showImpact', {})).result.say).toBe('Nothing yet: no issues have been handled in this session.');
    const s = freshState();
    s.metrics.minutesSaved = 4;
    expect((await call(s, 'showImpact', {})).result.say).toBe('Nothing yet: no issues have been handled in this session.');
  });
});

describe('openIncident', () => {
  it('opens a spoken number and asks for the first missing detail', async () => {
    const out = await opened('I N C 13001');
    expect(out.status).toBe(200);
    expect(out.state.itdesk.current?.number).toBe('INC0013001');
    expect(out.result.data).toMatchObject({ missing: ['assignee', 'assignment group', 'category'] });
    expect(out.result.say).toMatch(/I-N-C one three zero zero one, Sales floor VPN down for 40 users\. Critical, new/);
    expect(out.result.say).toMatch(/missing an assignee, an assignment group and a category\. Who should own it\?$/);
    expect(out.result.next).toMatch(/one at a time.*prepareIncidentUpdate once/);
  });
  it('resolves "the second one" from the last list', async () => {
    const listed = await list({});
    const out = await opened('the second one', listed.state);
    expect(out.state.itdesk.current?.number).toBe('INC0013003');
  });
  it('resolves any row on the screen by position, not only the first few', async () => {
    const listed = await list({});
    expect((await opened('the tenth one', listed.state)).state.itdesk.current?.number).toBe(listed.state.itdesk.queue[9].number);
    expect((await opened('number 12', listed.state)).state.itdesk.current?.number).toBe(listed.state.itdesk.queue[11].number);
  });
  it('finds one incident by keywords and includes the latest work notes', async () => {
    const out = await opened('the laptop battery one');
    expect(out.state.itdesk.current?.number).toBe('INC0013006');
    expect(out.result.data).toMatchObject({ workNotes: [expect.objectContaining({ text: expect.stringMatching(/vendor/) })] });
    expect(out.result.say).toMatch(/Latest work note/);
    const s = freshState();
    s.itdesk.backlog[5].notes = [{ at: NOW, author: 'david.loo', text: 'Vendor confirmed the swap.  ' }];
    expect((await opened('the laptop battery one', s)).result.say).toMatch(/Latest work note: Vendor confirmed the swap\. What/);
  });
  it('lists candidates when several incidents match', async () => {
    const out = await opened('failing');
    expect(out.status).toBe(200);
    expect(out.result.data).toMatchObject({ candidates: [expect.objectContaining({ number: 'INC0013002' }), expect.objectContaining({ number: 'INC0013004' }), expect.objectContaining({ number: 'INC0013010' })] });
    expect(out.result.say).toMatch(/I found 3 matches.*Which one\?/);
    expect(out.state.itdesk.current).toBeNull();
  });
  it('refuses unknown incidents and query operators', async () => {
    expect((await opened('quantum flux')).result.error).toBe('unknown_incident');
    expect((await opened('INC0099999')).result.error).toBe('unknown_incident');
    const search = vi.fn();
    const bad = await call(freshState(), 'openIncident', { ticket: 'concur^ORactive=false' }, { desk: { search } });
    expect(bad.result.error).toBe('invalid_search');
    expect(search).not.toHaveBeenCalled();
  });
});

describe('prepareIncidentUpdate', () => {
  it('asks which David when a first name matches several people', async () => {
    const out = await update((await opened('13001')).state, { assignedTo: 'David' });
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('ambiguous_assignee');
    expect(out.result.say).toBe('Which David: David Dan, David Loo or David Miller?');
  });
  it('sets priority by choosing urgency and impact the way ServiceNow computes it', async () => {
    const high = await update((await opened('13006')).state, { priority: 'high' });
    expect(high.status).toBe(200);
    expect(high.state.pending.at(-1)!.payload).toMatchObject({ kind: 'incident', fields: { urgency: '1' } });
    expect(high.result.say).toBe('Ready to update I-N-C one three zero zero six: set the priority to high.');
    const low = await update((await opened('13001')).state, { priority: 'Low' });
    expect(low.state.pending.at(-1)!.payload).toMatchObject({ fields: { urgency: '2', impact: '3' } });
    expect(low.result.say).toBe('Ready to update I-N-C one three zero zero one: set the priority to low.');
  });
  it('says the new priority when it saves one', async () => {
    const prep = await update((await opened('13006')).state, { priority: 'high' });
    const done = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) });
    expect(done.result.say).toMatch(/^Saved\. I-N-C one three zero zero six is now on hold, high priority, assigned to David Loo in Hardware\./);
  });
  it('says when the priority is already what was asked', async () => {
    const same = await update((await opened('13002')).state, { priority: 'critical' });
    expect(same.result).toMatchObject({ ok: false, error: 'no_changes' });
  });
  it('refuses a priority it does not know, or a priority together with urgency or impact', async () => {
    expect((await update((await opened('13006')).state, { priority: 'urgent' })).result).toMatchObject({ ok: false, error: 'invalid_value', say: 'The priority can be critical, high, moderate or low.' });
    expect((await update((await opened('13006')).state, { priority: 'high', urgency: 'low' })).result).toMatchObject({ ok: false, error: 'conflicting_priority' });
  });
  it.each(['none', 'None', 'N/A', 'n a', 'no change', 'unchanged', 'null', 'same'])('treats %j as "leave it", never as removing the assignee', async (placeholder) => {
    const out = await update((await opened('13002')).state, { priority: 'high', assignedTo: placeholder, assignmentGroup: placeholder });
    expect(out.status).toBe(200);
    const payload = out.state.pending.at(-1)!.payload;
    expect(payload.kind === 'incident' && 'assigned_to' in payload.fields).toBe(false);
    expect(payload.kind === 'incident' && 'assignment_group' in payload.fields).toBe(false);
  });
  it('still clears the assignee when asked in plain words', async () => {
    const out = await update((await opened('13002')).state, { assignedTo: 'unassigned' });
    expect(out.state.pending.at(-1)!.payload).toMatchObject({ fields: { assigned_to: '' } });
  });
  it('collects every change into one read-back', async () => {
    const out = await update((await opened('13001')).state, { assignedTo: 'David Dan', assignmentGroup: 'the network group', category: 'Network', urgency: 'high' });
    expect(out.status).toBe(200);
    const payload = out.state.pending.at(-1)!.payload;
    expect(payload).toMatchObject({ kind: 'incident', number: 'INC0013001', fields: { assigned_to: 'sim-user-ddan', assignment_group: 'sim-group-network', category: 'network' } });
    expect(payload.kind === 'incident' && payload.fields.urgency).toBeUndefined();
    expect(out.result.say).toBe('Ready to update I-N-C one three zero zero one: assign it to David Dan, move it to the Network group and set the category to network.');
    expect(out.result.next).toMatch(/confirmAction/);
  });
  it('refuses a group the new assignee is not in, naming who is, as ServiceNow would', async () => {
    const before = (await opened('13001')).state;
    const out = await update(before, { assignedTo: 'Neha Joshi', assignmentGroup: 'Network' });
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('assignee_not_in_group');
    expect(out.result.say).toBe("Neha Joshi isn't in the Network group, and ServiceNow only accepts an assignee from that group. Network has Arjun Rao, Bow Ruggeri and David Dan. Who should take it?");
    expect(out.state.pending.filter((a) => a.status === 'pending')).toHaveLength(0);
  });
  it('checks the current assignee when only the group changes', async () => {
    const out = await update((await opened('13004')).state, { assignmentGroup: 'Hardware' });
    expect(out.result.error).toBe('assignee_not_in_group');
    expect(out.result.say).toBe("Anita Rao isn't in the Hardware group, and ServiceNow only accepts an assignee from that group. Hardware has Beth Anglin, Bow Ruggeri and David Dan. Who should take it?");
  });
  it('allows a group change when the assignee is cleared at the same time', async () => {
    const out = await update((await opened('13004')).state, { assignedTo: 'nobody', assignmentGroup: 'Hardware' });
    expect(out.status).toBe(200);
    expect(out.state.pending.at(-1)!.payload).toMatchObject({ fields: { assigned_to: '', assignment_group: 'sim-group-hardware' } });
  });
  it('only warns when the assignee changes but the group stays', async () => {
    const out = await update((await opened('13004')).state, { assignedTo: 'Sam Joseph' });
    expect(out.status).toBe(200);
    expect(out.result.say).toBe("Ready to update I-N-C one three zero zero four: assign it to Sam Joseph. Heads-up: Sam Joseph isn't a member of the Software group.");
  });
  it('does not look up group members for updates that keep the assignee and group', async () => {
    const groupMembers = vi.fn(async () => success([]));
    const out = await update((await opened('13004')).state, { holdReason: 'awaiting vendor' }, { desk: { groupMembers } });
    expect(out.status).toBe(200);
    expect(groupMembers).not.toHaveBeenCalled();
  });
  it('says so when a group has no members to suggest', async () => {
    const out = await update((await opened('13001')).state, { assignedTo: 'David Dan', assignmentGroup: 'Help Desk' }, { desk: { groupMembers: async () => success([]) } });
    expect(out.result.error).toBe('assignee_not_in_group');
    expect(out.result.say).toBe("David Dan isn't in the Help Desk group, and ServiceNow only accepts an assignee from that group. The Help Desk group has no active members, so pick another group or leave it unassigned.");
  });
  it('fails honestly when the group members cannot be read', async () => {
    const out = await update((await opened('13001')).state, { assignedTo: 'David Dan', assignmentGroup: 'Network' }, { desk: { groupMembers: async () => failure({ kind: 'timeout' }) } });
    expect(out.status).toBe(422);
    expect(out.result.error).toBe('desk_unavailable');
    expect(out.result.say).toMatch(/^I couldn't check who is in that group: /);
  });
  it('matches groups loosely', async () => {
    const out = await update((await opened('13001')).state, { assignmentGroup: 'software team' });
    expect(out.state.pending.at(-1)!.payload).toMatchObject({ fields: { assignment_group: 'sim-group-software' } });
  });
  it('suggests close names when nobody matches', async () => {
    const out = await update((await opened('13001')).state, { assignedTo: 'Davd' });
    expect(out.result.error).toBe('unknown_assignee');
    expect(out.result.say).toBe("I can't find Davd in ServiceNow. Did you mean David Dan, David Loo or David Miller?");
    const group = await update((await opened('13001')).state, { assignmentGroup: 'Quantum' });
    expect(group.result.error).toBe('unknown_group');
  });
  it('needs a hold reason for On Hold and notes for Resolved, and infers the state from them', async () => {
    const s = (await opened('13002')).state;
    expect((await update(s, { state: 'on hold' })).result.error).toBe('hold_reason_required');
    expect((await update(s, { state: 'resolved' })).result.error).toBe('resolution_notes_required');
    const hold = await update(s, { holdReason: 'awaiting vendor' });
    expect(hold.state.pending.at(-1)!.payload).toMatchObject({ fields: { state: '3', hold_reason: '4' } });
    expect(hold.result.say).toMatch(/put it on hold, awaiting vendor/);
    const resolve = await update(s, { resolutionNotes: 'Export job fixed' });
    expect(resolve.state.pending.at(-1)!.payload).toMatchObject({ fields: { state: '6', close_notes: 'Export job fixed' } });
  });
  it('counts an incident resolved by voice on the simulated desk as resolved today, with its time to resolve', async () => {
    const s = (await opened('13002')).state;
    const prep = await update(s, { resolutionNotes: 'Export job fixed' });
    const done = (await call(prep.state, 'confirmAction', { code: codeOf(prep.result) })).state;
    const board = (await call(done, 'showDashboard', {})).state.itdesk.board;
    expect(board).toMatchObject({ kind: 'dashboard', resolvedToday: 1, resolvedWeek: 1, avgResolve: { ms: DAY, count: 1 } });
  });
  it('refuses empty or unchanged updates and bad values', async () => {
    const s = (await opened('13002')).state;
    expect((await update(s, {})).result.error).toBe('no_changes');
    expect((await update(s, { assignedTo: 'Karthik Nair', assignmentGroup: 'Software' })).result.error).toBe('no_changes');
    expect((await update(s, { urgency: 'urgent' })).result.error).toBe('invalid_value');
    expect((await update(s, { state: 'closed' })).result.error).toBe('invalid_value');
  });
  it('rejects query operators in names without calling ServiceNow', async () => {
    const findUsers = vi.fn();
    const out = await update((await opened('13001')).state, { assignedTo: 'David^ORactive=false' }, { desk: { findUsers } });
    expect(out.result.error).toBe('invalid_name');
    expect(findUsers).not.toHaveBeenCalled();
  });
  it('needs an incident', async () => {
    expect((await update(freshState(), { urgency: 'medium' })).result.error).toBe('no_incident');
  });
  it('replaces an earlier pending update for the same incident', async () => {
    const s = (await opened('13001')).state;
    const first = await update(s, { urgency: 'medium' });
    const second = await update(first.state, { urgency: 'medium', impact: 'low' });
    expect(second.state.pending.map((a) => a.status)).toEqual(['cancelled', 'pending']);
    expect(second.result.data).toMatchObject({ replaced: 1 });
    expect((await call(second.state, 'confirmAction', { code: codeOf(first.result) })).result.error).toBe('action_cancelled');
  });
});

describe('saving an incident update', () => {
  async function prepared() {
    const out = await update((await opened('13001')).state, { assignedTo: 'David Dan', assignmentGroup: 'Network', workNote: 'Router at sales floor rebooting' });
    return { state: out.state, code: codeOf(out.result) };
  }
  it('saves once on yes, refreshes state and queues the assignment alert', async () => {
    const { state, code } = await prepared();
    const updateFn = vi.fn((sysId: string, fields: Record<string, string>) => makeDeps(state, NOW).desk.update(sysId, fields));
    const done = await call(state, 'confirmAction', { code }, { desk: { update: updateFn }, notifyMode: 'live' });
    expect(done.status).toBe(200);
    expect(updateFn).toHaveBeenCalledWith('sim-inc-13001', { assigned_to: 'sim-user-ddan', assignment_group: 'sim-group-network', work_notes: 'Router at sales floor rebooting' });
    expect(done.result.say).toMatch(/^Saved\. I-N-C one three zero zero one is now new, assigned to David Dan in Network\./);
    expect(done.state.itdesk.current).toMatchObject({ number: 'INC0013001', assignee: { name: 'David Dan' }, group: { name: 'Network' } });
    expect(done.state.itdesk.lastUpdate).toMatchObject({ number: 'INC0013001', at: NOW });
    expect(done.state.metrics.ticketsUpdatedByVoice).toBe(1);
    expect(done.alerts).toEqual([{ id: expect.any(String), text: 'INC0013001 assigned to David Dan, Network, from the IT desk.', card: expect.objectContaining({ key: 'INC0013001', status: 'assigned' }) }]);
    const again = await call(done.state, 'confirmAction', { code }, { desk: { update: updateFn } });
    expect(again.result.data).toMatchObject({ alreadyDone: true });
    expect(updateFn).toHaveBeenCalledTimes(1);
    const unassigned = await list({ assignee: 'unassigned' }, done.state);
    expect(items(unassigned.result.data).map((i) => i.number)).not.toContain('INC0013001');
    const reopened = await opened('13001', done.state);
    expect(reopened.result.data).toMatchObject({ workNotes: [expect.objectContaining({ text: 'Router at sales floor rebooting' })] });
  });
  it('keeps the update pending when ServiceNow refuses, and a retry saves it', async () => {
    const { state, code } = await prepared();
    const failed = await call(state, 'confirmAction', { code }, { desk: { update: async () => failure({ kind: 'rejected', status: 403 }) } });
    expect(failed.status).toBe(422);
    expect(failed.result.error).toBe('incident_not_saved');
    expect(failed.result.say).toBe("I couldn't save the update in ServiceNow: ServiceNow rejected the request. Nothing changed yet. Shall I try again?");
    expect(failed.state.pending.at(-1)).toMatchObject({ status: 'pending', tries: 1 });
    expect(failed.state.metrics.ticketsUpdatedByVoice).toBe(0);
    expect((await call(failed.state, 'confirmAction', { code })).status).toBe(200);
  });
  it('is honest when the save is unconfirmed', async () => {
    const { state, code } = await prepared();
    const out = await call(state, 'confirmAction', { code }, { desk: { update: async () => failure({ kind: 'timeout' }) } });
    expect(out.result.error).toBe('incident_unconfirmed');
    expect(out.result.say).toMatch(/not sure it saved/);
  });
});

describe('persona gating', () => {
  async function session() {
    const store = new MemoryStore();
    return { store, code: await createSession(store, NOW) };
  }
  it('keeps employee calls away from IT tools and the reverse', async () => {
    const { store, code } = await session();
    const blocked = await executeTool(code, 'listQueue', { filter: '', limit: '' }, { makeDeps, store, persona: 'employee' });
    expect(blocked.status).toBe(403);
    expect(blocked.result).toMatchObject({ ok: false, error: 'not_available', say: "I can't do that in this call." });
    expect((await executeTool(code, 'checkServiceStatus', { service: 'vpn' }, { makeDeps, store, persona: 'itdesk' })).status).toBe(403);
    expect((await executeTool(code, 'listQueue', { filter: '', limit: '' }, { makeDeps, store, persona: 'itdesk' })).status).toBe(200);
    expect((await executeTool(code, 'cancelAction', { code: '1234' }, { makeDeps, store, persona: 'itdesk' })).status).toBe(422);
    expect((await loadSession(store, code))!.state.events).toHaveLength(2);
  });
  it("never lets one persona confirm or cancel the other's prepared action", async () => {
    const { store, code } = await session();
    const create = vi.fn(async () => success({ number: 'INC0012001', sysId: 's1' }));
    const update = vi.fn(async () => failure<DeskIncident>({ kind: 'rejected' }));
    const deps = (s: SessionState, now: number) => makeDeps(s, now, { tickets: { create }, desk: { update } });
    const ticket = await executeTool(code, 'prepareTicket', { summary: 'Dock broken', urgency: 'low', details: '' }, { makeDeps: deps, store });
    const ticketCode = codeOf(ticket.result);
    expect((await executeTool(code, 'confirmAction', { code: ticketCode }, { makeDeps: deps, store, persona: 'itdesk' })).result.error).toBe('unknown_code');
    expect((await executeTool(code, 'cancelAction', { code: ticketCode }, { makeDeps: deps, store, persona: 'itdesk' })).result.error).toBe('unknown_code');
    expect(create).not.toHaveBeenCalled();

    await executeTool(code, 'openIncident', { ticket: 'INC0013001' }, { makeDeps: deps, store, persona: 'itdesk' });
    const desk = await executeTool(code, 'prepareIncidentUpdate', { ticket: '', ...NO_CHANGES, urgency: 'low' }, { makeDeps: deps, store, persona: 'itdesk' });
    const deskCode = codeOf(desk.result);
    expect((await executeTool(code, 'confirmAction', { code: deskCode }, { makeDeps: deps, store, persona: 'employee' })).result.error).toBe('unknown_code');
    expect((await executeTool(code, 'cancelAction', { code: deskCode }, { makeDeps: deps, store, persona: 'employee' })).result.error).toBe('unknown_code');
    expect(update).not.toHaveBeenCalled();
    const { state } = (await loadSession(store, code))!;
    expect(state.pending.map((a) => a.status)).toEqual(['pending', 'pending']);
    expect((await executeTool(code, 'confirmAction', { code: ticketCode }, { makeDeps: deps, store, persona: 'employee' })).status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('defaults to the employee persona', async () => {
    const { store, code } = await session();
    expect((await executeTool(code, 'listQueue', { filter: '', limit: '' }, { makeDeps, store })).status).toBe(403);
  });
});

const HOUR = 60 * MINUTE;

describe('incident age', () => {
  it.each([
    [5 * MINUTE, '5 minutes ago'],
    [3 * HOUR, '3 hours ago'],
    [4 * DAY, '4 days ago'],
    [59 * DAY, '59 days ago'],
    [75 * DAY, 'over 2 months ago'],
    [400 * DAY, 'over a year ago'],
    [4116 * DAY, 'over 11 years ago'],
  ])('speaks %i ms as %s', (ago, text) => {
    expect(incidentAge(NOW - ago, NOW)).toBe(text);
  });
  it('handles an unknown open time', () => {
    expect(incidentAge(null, NOW)).toBe('at an unknown time');
  });
});
