import { describe, expect, it } from 'vitest';
import { success } from '@/lib/integrations/http';
import type { SessionState } from '@/lib/domain/types';
import { NOW, call, codeOf, confirmed, freshState } from './helpers';

type Run = Awaited<ReturnType<typeof call>>;
const card = (out: Run) => out.alerts.at(-1)?.card;
const keyOf = (s: SessionState) => `NMB-7K2:${s.issue!.id}`;

async function verified() {
  const sent = await call(freshState(), 'verifyIdentity', {}, { code: '421987' });
  return call(sent.state, 'checkIdentity', { code: '421987' });
}

describe('issue milestones on the Slack card', () => {
  it('starts a new issue with each guided fix', async () => {
    const out = await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: 'VPN drops every few minutes' });
    expect(out.state.issue).toMatchObject({ title: 'VPN drops every few minutes', status: 'in_progress' });
    expect(card(out)).toEqual({
      key: keyOf(out.state),
      status: 'in_progress',
      title: 'VPN drops every few minutes',
      person: 'Deepak Gowda',
      device: 'NB-2231',
      detail: "Guided fix started: VPN won't connect or keeps dropping in GlobalProtect",
      at: NOW,
    });
    expect(out.state.notifications.at(-1)).toMatchObject({ kind: 'issueStatus', status: 'queued' });
    const second = await call(out.state, 'startTroubleshooting', { articleId: 'printer', issue: 'Cannot print' });
    expect(card(second)!.key).not.toBe(card(out)!.key);
  });
  it('does not post every troubleshooting step', async () => {
    const s = (await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: '' })).state;
    expect((await call(s, 'reportStep', { outcome: 'not_fixed', note: '' })).alerts).toEqual([]);
  });
  it('waits for the employee while a code or a confirmation is pending', async () => {
    const sent = await call(freshState(), 'verifyIdentity', {}, { code: '421987' });
    expect(card(sent)).toMatchObject({ status: 'waiting_employee', title: 'Account access', detail: 'Verification code sent to the employee' });
    const ok = await call(sent.state, 'checkIdentity', { code: '421987' });
    const prep = await call(ok.state, 'prepareAccountAction', { action: 'unlock' });
    expect(card(prep)).toMatchObject({ key: card(sent)!.key, status: 'waiting_employee', detail: 'Waiting for the employee to confirm: Unlock your Nimbus account' });
  });
  it('asks the employee to try signing in after an account action, then resolves on yes', async () => {
    const prep = await call((await verified()).state, 'prepareAccountAction', { action: 'unlock' });
    const done = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) });
    expect(done.result.next).toMatch(/sign in now.*markResolved/);
    expect(card(done)).toMatchObject({ status: 'waiting_employee', detail: 'Account unlocked; waiting for the employee to sign in' });
    const resolved = await confirmed(done.state, 'markResolved', { summary: 'Account unlocked and sign-in works' });
    expect(card(resolved)).toMatchObject({ key: card(done)!.key, status: 'resolved_by_askit', detail: 'Account unlocked and sign-in works', ticket: 'INC0012001', alias: 'INC0012001' });
  });
  it('re-keys the card to the ticket number when a ticket is raised', async () => {
    const start = await call(freshState(), 'startTroubleshooting', { articleId: 'vpn', issue: 'VPN drops' });
    const prep = await call(start.state, 'prepareTicket', { summary: 'VPN keeps dropping', urgency: 'high', details: '' });
    expect(card(prep)).toMatchObject({ key: keyOf(start.state), status: 'waiting_employee', detail: 'Waiting for the employee to confirm a high-urgency ticket' });
    const raised = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) }, { tickets: { create: async () => success({ number: 'INC0012001', sysId: 's1' }) } });
    expect(raised.alerts).toHaveLength(1);
    expect(raised.alerts[0]).toMatchObject({ text: expect.stringMatching(/^New IT ticket INC0012001/) });
    expect(card(raised)).toMatchObject({ key: keyOf(start.state), alias: 'INC0012001', status: 'ticket_raised', ticket: 'INC0012001', detail: 'Raised as INC0012001, high urgency' });
    expect(raised.state.issue?.ticket).toBe('INC0012001');
    const later = await call(raised.state, 'prepareEscalation', { ticket: 'INC0012001', reason: 'Blocking a release' });
    expect(card(later)).toMatchObject({ key: 'INC0012001', status: 'waiting_employee' });
    const escalated = await call(later.state, 'confirmAction', { code: codeOf(later.result) });
    expect(card(escalated)).toMatchObject({ key: 'INC0012001', status: 'escalated', title: 'VPN keeps dropping', detail: 'Escalated to high urgency: Blocking a release' });
  });
  it('links an outage follow to the outage', async () => {
    const out = await confirmed(freshState(), 'followOutage', { incident: '' });
    expect(card(out)).toMatchObject({ status: 'opened', title: 'Affected by SAP Concur expense submissions failing', detail: 'Linked to known outage INC0011950' });
  });
  it('keys IT desk updates by incident number with the caller on the card', async () => {
    const open = await call(freshState(), 'openIncident', { ticket: '13001' });
    const base = { ticket: '', assignedTo: '', assignmentGroup: '', state: '', holdReason: '', urgency: '', impact: '', category: '', workNote: '', comment: '', resolutionNotes: '' };
    const save = async (s: SessionState, changes: Partial<typeof base>) => {
      const prep = await call(s, 'prepareIncidentUpdate', { ...base, ...changes });
      return call(prep.state, 'confirmAction', { code: codeOf(prep.result) });
    };
    const assigned = await save(open.state, { assignedTo: 'David Dan', assignmentGroup: 'Network' });
    expect(card(assigned)).toEqual({ key: 'INC0013001', status: 'assigned', title: 'Sales floor VPN down for 40 users', person: 'Meera Pillai', ticket: 'INC0013001', detail: 'Assigned to David Dan, Network', at: NOW });
    expect(card(await save(assigned.state, { holdReason: 'vendor' }))).toMatchObject({ status: 'on_hold', detail: 'On hold: awaiting vendor' });
    expect(card(await save(assigned.state, { resolutionNotes: 'Router replaced' }))).toMatchObject({ status: 'resolved_by_it', detail: 'Resolved: Router replaced' });
    expect(card(await save(assigned.state, { state: 'in progress' }))).toMatchObject({ status: 'in_progress', detail: 'Updated: set it to in progress' });
    expect(card(await save(assigned.state, { urgency: 'low' }))).toMatchObject({ status: 'in_progress', detail: 'Updated: set urgency to low' });
  });
  it('posts no milestone when a commit fails', async () => {
    const prep = await call(freshState(), 'prepareTicket', { summary: 'Dock broken', urgency: 'low', details: '' });
    const failed = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) }, { tickets: { create: async () => ({ ok: false, error: { kind: 'rejected' } }) } });
    expect(failed.alerts).toEqual([]);
  });
});
