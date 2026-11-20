import { describe, expect, it } from 'vitest';
import { buildItDeskView } from '@/lib/domain/itdesk-view';
import { NOW, call, freshState } from './helpers';

describe('IT desk view', () => {
  it('is empty until the desk is used', () => {
    expect(buildItDeskView(freshState(), NOW)).toEqual({ queue: [], current: null, lastUpdate: null, pending: null, board: null, updateRequest: null, report: null, stage: { incident: false, board: false } });
  });
  it('shows the queue, the open incident and the waiting update without internal ids', async () => {
    let s = (await call(freshState(), 'listQueue', { priority: 'critical', state: '', assignee: '', group: '', category: '', opened: '', keyword: '', sort: '', limit: '' })).state;
    expect(buildItDeskView(s, NOW).board).toEqual({ kind: 'list', title: 'Critical incidents', total: 3, more: false, at: NOW, query: { priority: 'critical' } });
    s = (await call(s, 'openIncident', { ticket: '13001' })).state;
    s = (await call(s, 'prepareIncidentUpdate', { ticket: '', assignedTo: 'David Dan', assignmentGroup: '', state: '', holdReason: '', urgency: '', impact: '', category: '', workNote: '', comment: '', resolutionNotes: '' })).state;
    const v = buildItDeskView(s, NOW);
    expect(v.queue.map((i) => i.number)).toEqual(['INC0013002', 'INC0013003', 'INC0013001']);
    expect(v.queue[0]).toMatchObject({ summary: 'Payroll export failing in SAP', priority: 1, priorityLabel: 'Critical', stateLabel: 'In Progress', assignee: 'Karthik Nair', group: 'Software' });
    expect(v.current).toMatchObject({ number: 'INC0013001', assignee: null, group: null, missing: ['assignee', 'assignment group', 'category'], workNotes: [] });
    expect(v.pending).toMatchObject({ number: 'INC0013001', summary: expect.stringMatching(/assign it to David Dan/), changes: ['assign it to David Dan'] });
    expect(JSON.stringify(v)).not.toMatch(/sysId|sim-|"id"/);
  });
});

describe('IT desk view update requests', () => {
  it('shows the last update asked of an assignee', async () => {
    const s = (await call(freshState(), 'requestUpdate', { ticket: '13002', within: '3 minutes' })).state;
    expect(buildItDeskView(s, NOW).updateRequest).toEqual({ number: 'INC0013002', assignee: 'Karthik Nair', due: NOW + 3 * 60_000, at: NOW });
  });
});

describe('IT desk view reports', () => {
  it('shows the report asked for, named for the screen', async () => {
    const s = (await call(freshState(), 'generateReport', { period: 'last_7_days' }, { claim: 'r1' })).state;
    expect(buildItDeskView(s, NOW).report).toEqual({ id: 'r1', status: 'pending', requestedAt: NOW, filename: null, kind: 'Weekly', periodLabel: 'Last 7 days' });
  });
});

describe('IT desk stage', () => {
  const LIST = { priority: '', state: '', assignee: '', group: '', category: '', opened: '', keyword: '', sort: '', limit: '' };
  const UPDATE = { ticket: '', assignedTo: 'David Dan', assignmentGroup: '', state: '', holdReason: '', urgency: '', impact: '', category: '', workNote: '', comment: '', resolutionNotes: '' };
  const stage = (s: Parameters<typeof buildItDeskView>[0]) => buildItDeskView(s, NOW).stage;

  it('shows only the board that answers the last question', async () => {
    let s = (await call(freshState(), 'listQueue', LIST)).state;
    expect(stage(s)).toEqual({ incident: false, board: true });
    s = (await call(s, 'showDashboard', {})).state;
    expect(stage(s)).toEqual({ incident: false, board: true });
  });
  it('hides the open incident when a dashboard, list, count or impact board is asked for after it, but keeps it for "it"', async () => {
    for (const [name, args] of [['showDashboard', {}], ['listQueue', LIST], ['countIncidents', { ...LIST, groupBy: '' }], ['showImpact', {}]] as const) {
      let s = (await call(freshState(), 'openIncident', { ticket: '13001' })).state;
      s = (await call(s, name, args)).state;
      expect(stage(s)).toEqual({ incident: false, board: true });
      expect(buildItDeskView(s, NOW).current?.number).toBe('INC0013001');
    }
  });
  it('shows only the incident when one is opened after a board', async () => {
    let s = (await call(freshState(), 'showDashboard', {})).state;
    s = (await call(s, 'openIncident', { ticket: '13001' })).state;
    expect(stage(s)).toEqual({ incident: true, board: false });
  });
  it('keeps the incident above the people asked about to take it', async () => {
    let s = (await call(freshState(), 'openIncident', { ticket: '13001' })).state;
    s = (await call(s, 'listResources', { team: '', status: '' })).state;
    expect(stage(s)).toEqual({ incident: true, board: true });
  });
  it('shows no incident beside people when none is open', async () => {
    const s = (await call(freshState(), 'listResources', { team: '', status: '' })).state;
    expect(stage(s)).toEqual({ incident: false, board: true });
  });
  it('brings the incident back for an update waiting for a yes, and for an update request', async () => {
    let s = (await call(freshState(), 'openIncident', { ticket: '13001' })).state;
    s = (await call(s, 'showDashboard', {})).state;
    s = (await call(s, 'prepareIncidentUpdate', UPDATE)).state;
    expect(stage(s)).toEqual({ incident: true, board: false });
    let r = (await call(freshState(), 'showDashboard', {})).state;
    r = (await call(r, 'requestUpdate', { ticket: '13002', within: '3 minutes' })).state;
    expect(stage(r)).toEqual({ incident: true, board: false });
  });
});
