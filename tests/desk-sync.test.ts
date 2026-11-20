import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as refreshRoute } from '@/app/api/itdesk/refresh/route';
import { POST as createSessionRoute } from '@/app/api/session/route';
import { GET as stateRoute } from '@/app/api/state/route';
import { applyDeskRead } from '@/lib/domain/sync';
import { DAY, MINUTE } from '@/lib/domain/time';
import type { SessionState } from '@/lib/domain/types';
import { failure, success } from '@/lib/integrations/http';
import type { DeskAdapter, DeskIncident } from '@/lib/integrations/types';
import { createSession, loadSession, updateSession } from '@/lib/server/session';
import { MemoryStore, getStore } from '@/lib/server/store';
import { syncDesk } from '@/lib/server/sync';
import { NOW, call, freshState } from './helpers';
import { jsonResponse } from './fakes';

const Q = { priority: '', state: '', assignee: '', group: '', category: '', opened: '', keyword: '', sort: '' };
const C = { ...Q, groupBy: '' };
const NOBODY = { assignedTo: '', assignmentGroup: '', state: '', holdReason: '', priority: '', urgency: '', impact: '', category: '', workNote: '', comment: '', resolutionNotes: '' };
const plain = ({ notes: _notes, ...i }: SessionState['itdesk']['backlog'][number]): DeskIncident => i;

// A session with incident 13001 open and the critical list on screen.
async function working(state = freshState()) {
  const listed = (await call(state, 'listQueue', { ...Q, priority: 'critical' })).state;
  return (await call(listed, 'openIncident', { ticket: '13001' })).state;
}

// 13001 as ServiceNow shows it after someone assigned it in the ServiceNow UI.
const edited = (s: SessionState): DeskIncident => ({ ...plain(s.itdesk.backlog[0]), state: '2', stateLabel: 'In Progress', assignee: { id: 'u-1', name: 'David Dan' } });

describe('applyDeskRead', () => {
  it('puts what ServiceNow says now on the open incident card and its row, and keeps the notes when they cannot be read', async () => {
    const s = await working();
    const out = applyDeskRead(s, s.itdesk, { incident: { number: 'INC0013001', found: success(edited(s)), notes: null } }, NOW + MINUTE);
    expect(out.itdesk.current).toMatchObject({ number: 'INC0013001', stateLabel: 'In Progress', assignee: { name: 'David Dan' }, notes: s.itdesk.current!.notes });
    expect(out.itdesk.queue.find((i) => i.number === 'INC0013001')?.assignee?.name).toBe('David Dan');
    const noted = applyDeskRead(s, s.itdesk, { incident: { number: 'INC0013001', found: success(edited(s)), notes: success([{ at: NOW, author: 'beth', text: 'On it' }]) } }, NOW);
    expect(noted.itdesk.current?.notes).toEqual([{ at: NOW, author: 'beth', text: 'On it' }]);
  });
  it('keeps the last values when ServiceNow fails, times out or no longer finds the incident', async () => {
    const s = await working();
    for (const found of [failure<DeskIncident | null>({ kind: 'timeout' }), null, success(null)]) {
      expect(applyDeskRead(s, s.itdesk, { incident: { number: 'INC0013001', found, notes: null } }, NOW)).toBe(s);
    }
  });
  it('leaves an incident alone that a tool changed while ServiceNow was being read', async () => {
    const base = await working();
    const saved = { ...base, itdesk: { ...base.itdesk, current: { ...base.itdesk.current!, stateLabel: 'On Hold', state: '3' } } };
    expect(applyDeskRead(saved, base.itdesk, { incident: { number: 'INC0013001', found: success(edited(base)), notes: null } }, NOW)).toBe(saved);
  });
  it('never drops or changes a confirmation waiting for a yes', async () => {
    const s = (await call(await working(), 'prepareIncidentUpdate', { ticket: '', ...NOBODY, assignedTo: 'David Loo' })).state;
    const out = applyDeskRead(s, s.itdesk, { incident: { number: 'INC0013001', found: success(edited(s)), notes: null } }, NOW);
    expect(out.pending).toEqual(s.pending);
    expect(out.pending.at(-1)).toMatchObject({ status: 'pending', payload: { kind: 'incident', number: 'INC0013001' } });
    expect(out.itdesk.current?.assignee?.name).toBe('David Dan');
  });
  it('runs a list again with its own filters and keeps when it was asked', async () => {
    const s = await working();
    const rows = [edited(s), plain(s.itdesk.backlog[1])];
    const out = applyDeskRead(s, s.itdesk, { board: { rows: success(rows) } }, NOW + MINUTE);
    expect(out.itdesk.queue.map((i) => i.number)).toEqual(['INC0013001', 'INC0013002']);
    expect(out.itdesk.board).toEqual({ kind: 'list', title: 'Critical incidents', total: 2, more: false, at: NOW, query: { priority: 'critical' }, syncedAt: NOW + MINUTE });
  });
  it('counts again by the same breakdown', async () => {
    const s = (await call(freshState(), 'countIncidents', { ...C, assignee: 'unassigned', groupBy: 'priority' })).state;
    const out = applyDeskRead(s, s.itdesk, { board: { rows: success([plain(s.itdesk.backlog[0])]) } }, NOW + MINUTE);
    expect(out.itdesk.board).toMatchObject({ kind: 'count', total: 1, groupBy: 'priority', groups: [{ label: 'Critical', count: 1 }], at: NOW, syncedAt: NOW + MINUTE });
  });
  it('rebuilds the dashboard from fresh numbers', async () => {
    const s = (await call(freshState(), 'showDashboard', {})).state;
    const out = applyDeskRead(s, s.itdesk, { board: { rows: success([edited(s)]), activity: success({ opened: [NOW], resolved: [{ at: NOW, openedAt: NOW - DAY }] }) } }, NOW + MINUTE);
    expect(out.itdesk.board).toMatchObject({ kind: 'dashboard', total: 1, unassigned: 0, inProgress: 1, resolvedToday: 1, at: NOW, syncedAt: NOW + MINUTE });
  });
  it('keeps the board when its read fails or a newer answer replaced it', async () => {
    const s = await working();
    expect(applyDeskRead(s, s.itdesk, { board: { rows: failure({ kind: 'unavailable' }) } }, NOW)).toBe(s);
    expect(applyDeskRead(s, s.itdesk, { board: null }, NOW)).toBe(s);
    const newer = (await call(s, 'countIncidents', C)).state;
    expect(applyDeskRead(newer, s.itdesk, { board: { rows: success([]) } }, NOW)).toBe(newer);
  });
});

type FakeDesk = Pick<DeskAdapter, 'mode' | 'get' | 'workNotes' | 'listOpen' | 'activity'>;
function liveDesk(o: Partial<FakeDesk> = {}) {
  const desk: FakeDesk = {
    mode: 'live',
    get: vi.fn(async () => success(null)),
    workNotes: vi.fn(async () => success([])),
    listOpen: vi.fn(async () => success([])),
    activity: vi.fn(async () => success({ opened: [], resolved: [] })),
    ...o,
  };
  return { desk, make: () => desk as unknown as DeskAdapter };
}

describe('syncDesk', () => {
  async function session(state?: SessionState) {
    let clock = NOW;
    const store = new MemoryStore(() => clock);
    const code = await createSession(store, NOW);
    if (state) await updateSession(store, code, () => ({ state: { ...state, id: code } }));
    return { store, code, tick: (ms: number) => (clock += ms), at: () => clock };
  }

  it('reads the open incident and the board in parallel and stores what ServiceNow says', async () => {
    const s = await working();
    const { store, code } = await session(s);
    const { desk, make } = liveDesk({ get: vi.fn(async () => success(edited(s))), listOpen: vi.fn(async () => success([edited(s)])) });
    const out = await syncDesk(store, code, NOW + MINUTE, make);
    expect(out?.outcome).toBe('synced');
    expect(desk.get).toHaveBeenCalledWith('INC0013001');
    expect(desk.workNotes).toHaveBeenCalledWith(s.itdesk.current!.sysId);
    expect(desk.listOpen).toHaveBeenCalledWith({ priority: 'critical', sort: 'priority' }, 26);
    const stored = (await loadSession(store, code))!.state;
    expect(stored.itdesk.current?.assignee?.name).toBe('David Dan');
    expect(stored.itdesk.board).toMatchObject({ kind: 'list', total: 1, syncedAt: NOW + MINUTE });
  });
  it('reads nothing when no incident or ServiceNow board is on screen, and in simulated mode', async () => {
    const idle = await session();
    const { desk, make } = liveDesk();
    expect((await syncDesk(idle.store, idle.code, NOW, make))?.outcome).toBe('idle');
    const people = await session((await call(freshState(), 'listResources', { team: 'Network', status: '' })).state);
    expect((await syncDesk(people.store, people.code, NOW, make))?.outcome).toBe('idle');
    const sim = await session(await working());
    const before = (await loadSession(sim.store, sim.code))!.version;
    expect((await syncDesk(sim.store, sim.code, NOW, () => ({ ...desk, mode: 'simulated' }) as unknown as DeskAdapter))?.outcome).toBe('simulated');
    expect((await loadSession(sim.store, sim.code))!.version).toBe(before);
    expect(desk.get).not.toHaveBeenCalled();
    expect(await syncDesk(idle.store, 'ZZZ-ZZZ', NOW, make)).toBeNull();
  });
  it('reads ServiceNow at most once per 10 seconds per session, shared by every tab', async () => {
    const { store, code, tick, at } = await session(await working());
    const { desk, make } = liveDesk();
    const both = await Promise.all([syncDesk(store, code, at(), make), syncDesk(store, code, at(), make)]);
    expect(both.map((o) => o?.outcome).sort()).toEqual(['synced', 'throttled']);
    tick(9_000);
    expect((await syncDesk(store, code, at(), make))?.outcome).toBe('throttled');
    tick(1_000);
    expect((await syncDesk(store, code, at(), make))?.outcome).toBe('synced');
    expect(desk.get).toHaveBeenCalledTimes(2);
  });
  it('gives up on a slow ServiceNow after 4 seconds and keeps the last values', async () => {
    vi.useFakeTimers();
    try {
      const s = await working();
      const { store, code } = await session(s);
      const { make } = liveDesk({ get: () => new Promise<never>(() => {}), listOpen: () => new Promise<never>(() => {}) });
      const pending = syncDesk(store, code, NOW, make);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(3_900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect((await pending)?.outcome).toBe('unavailable');
      expect((await loadSession(store, code))!.state.itdesk).toEqual(s.itdesk);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps a change a tool saved while ServiceNow was being read', async () => {
    const s = await working();
    const { store, code } = await session(s);
    const get = vi.fn(async () => {
      await updateSession(store, code, (x) => ({ state: { ...x, itdesk: { ...x.itdesk, current: { ...x.itdesk.current!, stateLabel: 'Resolved', state: '6' } } } }));
      return success(edited(s));
    });
    await syncDesk(store, code, NOW, liveDesk({ get }).make);
    expect((await loadSession(store, code))!.state.itdesk.current?.stateLabel).toBe('Resolved');
  });
});

describe('/api/itdesk/refresh', () => {
  const SN = { SERVICENOW_INSTANCE_URL: 'https://nimbus.service-now.example', SERVICENOW_USER: 'u', SERVICENOW_PASSWORD: 'p', SERVICENOW_CALLER_EMAIL: 'priya@x.example' };
  beforeEach(() => {
    for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'SERVICENOW_INSTANCE_URL']) vi.stubEnv(k, '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const post = (body: unknown) => refreshRoute(new NextRequest('http://localhost/api/itdesk/refresh', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
  const view = async (code: string) => (await stateRoute(new NextRequest(`http://localhost/api/state?session=${code}`))).json();
  const newSession = async () => (await (await createSessionRoute()).json()).code as string;

  it('refuses bad input and unknown sessions', async () => {
    expect((await post('{nope')).status).toBe(400);
    expect((await post({ session: 'nope' })).status).toBe(400);
    expect((await post({ session: 'ZZZ-ZZZ' })).status).toBe(404);
  });
  it('does nothing when nothing from ServiceNow is on screen, or the desk is simulated', async () => {
    const code = await newSession();
    const res = await post({ session: code });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ outcome: 'idle' });
    await updateSession(getStore(), code, (s) => ({ state: { ...s, itdesk: { ...s.itdesk, current: { ...s.itdesk.backlog[0] } } } }));
    expect(await (await post({ session: code })).json()).toEqual({ outcome: 'simulated' });
  });
  it('shows an edit made in the ServiceNow UI on the open incident card', async () => {
    for (const [k, v] of Object.entries(SN)) vi.stubEnv(k, v);
    const code = await newSession();
    const sysId = '0123456789abcdef0123456789abcdef';
    const v = (value: string, display = value) => ({ value, display_value: display });
    const row = (assignee: string) => ({
      number: v('INC0010101'), sys_id: v(sysId), short_description: v('VPN down for sales'), priority: v('1', '1 - Critical'), state: v('2', 'In Progress'), hold_reason: v(''),
      assigned_to: assignee ? v('fedcba9876543210fedcba9876543210', assignee) : v(''), assignment_group: v(''), caller_id: v('c1', 'Priya Sharma'), category: v('network'),
      urgency: v('1'), impact: v('1'), opened_at: v('2026-11-18 04:00:00'),
    });
    let assignee = '';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/now/table/sys_journal_field')) return jsonResponse({ result: [] });
      if (url.includes('number%3DINC0010101') || url.includes('number=INC0010101')) return jsonResponse({ result: [row(assignee)] });
      return jsonResponse({ result: [] });
    });
    fetchSpy.mockClear();
    const current = { number: 'INC0010101', sysId, summary: 'VPN down for sales', priority: 1, priorityLabel: 'Critical', state: '2', stateLabel: 'In Progress', holdReason: null, assignee: null, group: null, caller: 'Priya Sharma', category: 'network', urgency: 1 as const, impact: 1 as const, openedAt: Date.UTC(2026, 10, 18, 4), notes: [] };
    await updateSession(getStore(), code, (s) => ({ state: { ...s, itdesk: { ...s.itdesk, current } } }));
    assignee = 'Beth Anglin';
    const res = await post({ session: code });
    expect(await res.json()).toEqual({ outcome: 'synced' });
    expect((await view(code)).itdesk.current).toMatchObject({ number: 'INC0010101', assignee: 'Beth Anglin' });
    expect(fetchSpy.mock.calls.every(([input, init]) => (init?.method ?? 'GET') === 'GET' && String(input).startsWith('https://nimbus.service-now.example/api/now/table/'))).toBe(true);
  });
});
