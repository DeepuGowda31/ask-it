import { describe, expect, it, vi } from 'vitest';
import { ASSETS, assetMarker, findAsset } from '@/lib/domain/assets';
import { findArticle } from '@/lib/domain/kb';
import { buildGreeting, buildSystemPrompt } from '@/lib/agent/config';
import { buildSessionView } from '@/lib/domain/view';
import { ServiceNowTickets } from '@/lib/integrations/servicenow';
import { SimulatedTickets } from '@/lib/integrations/simulated';
import { failure, success } from '@/lib/integrations/http';
import { MemoryStore } from '@/lib/server/store';
import { createSession, loadSession } from '@/lib/server/session';
import type { AssetVisit, SessionState } from '@/lib/domain/types';
import { NOW, call, codeOf, confirmed, freshState } from './helpers';
import { fakeFetch, jsonResponse } from './fakes';

const OPEN = { number: 'INC0011962', sysId: 'sn-1962', summary: 'Display shows no signal' };

const at = (id: string, ticket: AssetVisit['ticket'] = null, s: SessionState = freshState()) => ({ ...s, asset: { id, ticket } });

describe('asset catalog', () => {
  it('has stable ids whose guides exist', () => {
    expect(ASSETS.map((a) => a.id)).toEqual(expect.arrayContaining(['room-4b-display', 'printer-3f', 'laptop-nb-2231']));
    for (const a of ASSETS) {
      expect(a.id).toMatch(/^[a-z0-9-]+$/);
      expect(a.guides.length).toBeGreaterThan(0);
      for (const g of a.guides) expect(findArticle(g), `${a.id} guide ${g}`).toBeDefined();
    }
    // No id is a prefix of another, so a description match is never ambiguous.
    for (const a of ASSETS) for (const b of ASSETS) if (a !== b) expect(b.id.startsWith(a.id)).toBe(false);
  });
  it('looks up known ids only', () => {
    expect(findAsset('room-4b-display')).toMatchObject({ name: 'Meeting room 4B display', guides: ['external-monitor', 'screen-sharing'] });
    for (const bad of ['', 'ROOM-4B-DISPLAY', 'room-4b-display ', 'room-4b', '../printer-3f', 'printer-3f^ORactive=true', 'x'.repeat(200), 42, null, undefined, {}]) {
      expect(findAsset(bad), String(bad)).toBeUndefined();
    }
    expect(assetMarker('printer-3f')).toBe('Asset: printer-3f');
  });
});

describe('session asset', () => {
  it('stores the scanned device on a new session and shows it on the page', async () => {
    const store = new MemoryStore();
    const code = await createSession(store, NOW, { tickets: 'simulated' }, { id: 'printer-3f', ticket: OPEN });
    const { state } = (await loadSession(store, code))!;
    expect(state.asset).toEqual({ id: 'printer-3f', ticket: OPEN });
    const view = buildSessionView(state, NOW, 1, { tickets: 'simulated', identity: 'simulated', notify: 'simulated', status: 'live' });
    expect(view.asset).toEqual({ id: 'printer-3f', name: findAsset('printer-3f')!.name, location: findAsset('printer-3f')!.location, ticket: { number: OPEN.number, summary: OPEN.summary } });
    const plain = (await loadSession(store, await createSession(store, NOW)))!.state;
    expect(plain.asset ?? null).toBeNull();
    expect(buildSessionView(plain, NOW, 1, view.integrations).asset).toBeNull();
  });
});

describe('greeting and prompt', () => {
  it('greets with the device and lists its guides', () => {
    const s = at('room-4b-display');
    expect(buildGreeting(s)).toBe("Hi Deepak, this is ASK IT. You're at meeting room 4B's display. What's going wrong?");
    const p = buildSystemPrompt(NOW, 'employee', null, s.asset);
    expect(p).toMatch(/This call\n- Deepak scanned the QR sticker on Meeting room 4B display, Bengaluru, 4th floor\./);
    expect(p).toMatch(/external-monitor, screen-sharing/);
    expect(p).not.toMatch(/addTicketNote with ticket/);
  });
  it('says so when the device already has an open ticket', () => {
    const s = at('printer-3f', OPEN);
    expect(buildGreeting(s)).toBe("Hi Deepak, this is ASK IT. You're at the printer by the 3rd floor pantry. It already has an open ticket, I-N-C one one nine six two, so I'll add what you tell me to it. What's going wrong?");
    expect(buildSystemPrompt(NOW, 'employee', null, s.asset)).toMatch(/already has open ticket INC0011962, Display shows no signal\. Do not raise a duplicate: call addTicketNote with ticket INC0011962/);
  });
  it('lets a ringing follow-up win, and ignores unknown or missing assets', () => {
    const f = { number: 'INC0010013', summary: 'GlobalProtect VPN not connecting' };
    const s = at('room-4b-display');
    expect(buildGreeting(s, 'employee', f)).toMatch(/^Hi Deepak, this is ASK IT calling about I-N-C one zero zero one three/);
    const p = buildSystemPrompt(NOW, 'employee', f, s.asset);
    expect(p).toMatch(/You called Deepak back about INC0010013/);
    expect(p).not.toMatch(/QR sticker/);
    expect(buildGreeting(s, 'itdesk')).toMatch(/^Hi, I'm your IT Admin voice agent/);
    expect(buildGreeting(at('nope'))).toBe('Hi Deepak, ASK IT here.');
    expect(buildSystemPrompt(NOW, 'employee', null, { id: 'nope', ticket: null })).not.toMatch(/This call/);
  });
});

describe('tickets from a scanned device', () => {
  it('carries the device, location and a findable marker', async () => {
    const prep = await call(at('room-4b-display'), 'prepareTicket', { summary: 'Display shows no signal', urgency: 'medium', details: 'HDMI cable plugged in' });
    const p = prep.state.pending[0].payload;
    const description = p.kind === 'ticket' ? p.ticket.description : '';
    expect(description).toMatch(/Location: Meeting room 4B display, Bengaluru, 4th floor, reported from its QR sticker\./);
    expect(description).toMatch(/^Asset: room-4b-display$/m);
    expect(prep.result.data).toMatchObject({ warnings: [] });
    const plain = await call(freshState(), 'prepareTicket', { summary: 'Laptop fan loud', urgency: 'low', details: '' });
    const q = plain.state.pending[0].payload;
    expect(q.kind === 'ticket' && q.ticket.description).not.toMatch(/Asset:|Location:/);
  });
  it('points to the open ticket for the device instead of a duplicate', async () => {
    const findOpenForAsset = vi.fn(async () => success(OPEN));
    const prep = await call(at('room-4b-display'), 'prepareTicket', { summary: 'No signal', urgency: 'medium', details: '' }, { tickets: { findOpenForAsset } });
    expect(findOpenForAsset).toHaveBeenCalledWith('room-4b-display');
    expect(prep.result.data).toMatchObject({ existingTicket: { number: 'INC0011962', summary: 'Display shows no signal' }, warnings: [expect.stringMatching(/already has an open ticket, I-N-C one one nine six two/)] });
    expect(prep.result.next).toMatch(/Instead of confirming, call addTicketNote with ticket INC0011962/);
    expect(prep.state.asset?.ticket).toEqual(OPEN);
  });
  it('raises a normal ticket when none is open, and clears a stale one', async () => {
    const prep = await call(at('room-4b-display', OPEN), 'prepareTicket', { summary: 'No signal', urgency: 'medium', details: '' }, { tickets: { findOpenForAsset: async () => success(null) } });
    expect(prep.result.data).toMatchObject({ warnings: [] });
    expect(prep.result.next).not.toMatch(/addTicketNote/);
    expect(prep.state.asset?.ticket).toBeNull();
  });
  it('falls back to a normal ticket and says so when ServiceNow cannot be checked', async () => {
    const prep = await call(at('room-4b-display'), 'prepareTicket', { summary: 'No signal', urgency: 'medium', details: '' }, { tickets: { findOpenForAsset: async () => failure({ kind: 'timeout' }) } });
    expect(prep.result.ok).toBe(true);
    expect(prep.result.say).toMatch(/couldn't check whether Meeting room 4B display already has a ticket/);
    expect(prep.result.data).toMatchObject({ status: 'awaiting_confirmation', warnings: [] });
  });
  it('remembers a ticket raised for the device, so the next report joins it', async () => {
    const prep = await call(at('room-4b-display'), 'prepareTicket', { summary: 'No signal', urgency: 'medium', details: '' });
    const done = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) });
    const number = (done.result.data as { number: string }).number;
    expect(done.state.asset?.ticket).toMatchObject({ number, summary: 'No signal' });
    const again = await call(done.state, 'prepareTicket', { summary: 'Still no signal', urgency: 'medium', details: '' });
    expect(again.result.next).toMatch(new RegExp(`addTicketNote with ticket ${number}`));
  });
  it("adds the caller's report to the device's open ticket on her yes and counts the duplicate avoided", async () => {
    const addNote = vi.fn(async () => success(null));
    const prep = await call(at('printer-3f', OPEN), 'addTicketNote', { ticket: 'I N C 11962', note: 'Jams on every page' }, { tickets: { addNote } });
    expect(prep.result.say).toBe('Shall I add your report to I-N-C one one nine six two, the ticket already open for this device: Jams on every page?');
    expect(prep.state.pending[0].payload).toMatchObject({ kind: 'note', number: 'INC0011962', sysId: 'sn-1962', shared: true });
    expect(addNote).not.toHaveBeenCalled();
    const out = await call(prep.state, 'confirmAction', { code: codeOf(prep.result) }, { tickets: { addNote } });
    expect(out.result.ok).toBe(true);
    expect(out.result.say).toMatch(/Added your report to I-N-C one one nine six two/);
    expect(addNote).toHaveBeenCalledWith({ number: 'INC0011962', sysId: 'sn-1962' }, expect.stringMatching(/Deepak Gowda .*QR sticker.*Jams on every page/));
    expect(out.state.metrics.duplicatesAvoided).toBe(1);
    const repeat = await call(out.state, 'confirmAction', { code: codeOf(prep.result) }, { tickets: { addNote } });
    expect(repeat.state.metrics.duplicatesAvoided).toBe(1);
    expect(addNote).toHaveBeenCalledTimes(1);
    const failed = await confirmed(at('printer-3f', OPEN), 'addTicketNote', { ticket: 'INC0011962', note: 'x' }, { tickets: { addNote: async () => failure({ kind: 'unavailable', status: 500 }) } });
    expect(failed.result.ok).toBe(false);
    expect(failed.state.metrics.duplicatesAvoided).toBe(0);
    expect((await call(at('printer-3f'), 'addTicketNote', { ticket: 'INC0011962', note: 'x' })).result.error).toBe('unknown_ticket');
  });
  it('simulates an open ticket for the 3rd floor printer, and accepts notes on it', async () => {
    const s = at('printer-3f');
    const sim = new SimulatedTickets(s);
    const found = await sim.findOpenForAsset('printer-3f');
    expect(found).toMatchObject({ ok: true, value: { number: expect.stringMatching(/^INC\d{7}$/) } });
    expect(await sim.findOpenForAsset('room-4b-display')).toEqual({ ok: true, value: null });
    const withTicket = at('printer-3f', found.ok ? found.value : null);
    expect(await new SimulatedTickets(withTicket).addNote(withTicket.asset.ticket!)).toEqual({ ok: true, value: null });
  });
});

describe('ServiceNow open ticket for an asset', () => {
  const CFG = { instanceUrl: 'https://nimbus.service-now.example', user: 'u', password: 'p', callerEmail: 'priya@x.example', closeCode: 'x' };
  const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

  it('finds the newest open incident whose description carries the marker', async () => {
    const f = fakeFetch(() => jsonResponse({ result: [{ number: 'INC0010777', sys_id: 'abc', short_description: 'No signal' }] }));
    const sn = new ServiceNowTickets(CFG, { fetch: f.fetch }, new Map());
    expect(await sn.findOpenForAsset('room-4b-display')).toEqual({ ok: true, value: { number: 'INC0010777', sysId: 'abc', summary: 'No signal' } });
    expect(f.calls[0].url).toMatch(/\/api\/now\/table\/incident\?/);
    expect(query(f.calls[0].url)).toMatchObject({
      sysparm_query: 'active=true^stateIN1,2,3^descriptionLIKEAsset: room-4b-display^ORDERBYDESCsys_created_on',
      sysparm_fields: 'number,sys_id,short_description',
      sysparm_limit: '1',
    });
  });
  it('returns null when there is none, fails on errors, and never queries an unknown id', async () => {
    const empty = fakeFetch(() => jsonResponse({ result: [] }));
    expect(await new ServiceNowTickets(CFG, { fetch: empty.fetch }, new Map()).findOpenForAsset('printer-3f')).toEqual({ ok: true, value: null });
    const down = fakeFetch(() => jsonResponse({ error: 'x' }, 500));
    expect((await new ServiceNowTickets(CFG, { fetch: down.fetch }, new Map()).findOpenForAsset('printer-3f')).ok).toBe(false);
    const never = fakeFetch(() => jsonResponse({ result: [] }));
    const sn = new ServiceNowTickets(CFG, { fetch: never.fetch }, new Map());
    expect(await sn.findOpenForAsset('printer-3f^ORactive=false')).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(await sn.findOpenForAsset('unknown-thing')).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(never.calls).toHaveLength(0);
  });
});
