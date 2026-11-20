import { describe, expect, it } from 'vitest';
import { buildItDeskView } from '@/lib/domain/itdesk-view';
import { NOW, call, freshState } from './helpers';

describe('IT desk view', () => {
  it('is empty until the desk is used', () => {
    expect(buildItDeskView(freshState(), NOW)).toEqual({ queue: [], current: null, lastUpdate: null, pending: null, board: null, updateRequest: null });
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
