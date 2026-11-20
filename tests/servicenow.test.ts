import { describe, expect, it } from 'vitest';
import { ServiceNowTickets, serviceNowConfig } from '@/lib/integrations/servicenow';
import { fakeFetch, hangingFetch, headerOf, jsonResponse } from './fakes';

const CFG = { instanceUrl: 'https://nimbus.service-now.example', user: 'askit.bot', password: 'pa55-SECRET', callerEmail: 'deepak.gowda@nimbuslabs.example', closeCode: 'Resolved – Permanent Fix Applied' };
const BASIC = `Basic ${Buffer.from('askit.bot:pa55-SECRET').toString('base64')}`;
const CALLER = { result: [{ sys_id: 'usr-1' }] };

function adapter(handler: Parameters<typeof fakeFetch>[0], cache = new Map<string, string>()) {
  const f = fakeFetch(handler);
  return { sn: new ServiceNowTickets(CFG, { fetch: f.fetch }, cache), calls: f.calls };
}

const query = (url: string) => Object.fromEntries(new URL(url).searchParams);
const NEW = { shortDescription: 'VPN keeps dropping', description: 'Tried 3 steps', urgency: 2 as const, impact: 3 as const, category: 'network', correlationId: 'askit:NMB-7K2:4217' };

describe('ServiceNow config', () => {
  it('needs all four variables', () => {
    expect(serviceNowConfig({})).toBeNull();
    expect(serviceNowConfig({ SERVICENOW_INSTANCE_URL: 'https://x.example/', SERVICENOW_USER: 'u', SERVICENOW_PASSWORD: 'p' })).toBeNull();
    expect(serviceNowConfig({ SERVICENOW_INSTANCE_URL: 'https://x.example/', SERVICENOW_USER: 'u', SERVICENOW_PASSWORD: 'p', SERVICENOW_CALLER_EMAIL: 'e@x' })).toEqual({ instanceUrl: 'https://x.example', user: 'u', password: 'p', callerEmail: 'e@x', closeCode: 'Resolved – Permanent Fix Applied' });
    expect(serviceNowConfig({ SERVICENOW_INSTANCE_URL: 'https://x.example', SERVICENOW_USER: 'u', SERVICENOW_PASSWORD: 'p', SERVICENOW_CALLER_EMAIL: 'e@x', SERVICENOW_CLOSE_CODE: 'Solved' })?.closeCode).toBe('Solved');
  });
});

describe('ServiceNow tickets', () => {
  it('creates an incident for the caller, resolving the caller once', async () => {
    const { sn, calls } = adapter((url) => (url.includes('sys_user') ? jsonResponse(CALLER) : jsonResponse({ result: { number: 'INC0010042', sys_id: 'abc' } }, 201)));
    expect(await sn.create(NEW)).toEqual({ ok: true, value: { number: 'INC0010042', sysId: 'abc' } });
    expect(await sn.create(NEW)).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.url.includes('sys_user'))).toHaveLength(1);
    const [lookup, post] = calls;
    expect(lookup.url.startsWith('https://nimbus.service-now.example/api/now/table/sys_user?')).toBe(true);
    expect(query(lookup.url)).toMatchObject({ sysparm_query: 'email=deepak.gowda@nimbuslabs.example', sysparm_fields: 'sys_id', sysparm_limit: '1' });
    expect(post.url).toBe('https://nimbus.service-now.example/api/now/table/incident');
    expect(post.init.method).toBe('POST');
    expect(headerOf(post.init, 'authorization')).toBe(BASIC);
    expect(headerOf(post.init, 'content-type')).toBe('application/json');
    expect(post.body).toEqual({ short_description: 'VPN keeps dropping', description: 'Tried 3 steps', urgency: '2', impact: '3', category: 'network', caller_id: 'usr-1', contact_type: 'virtual_agent', correlation_id: 'askit:NMB-7K2:4217' });
  });
  it('reads one of the caller\'s own tickets with its owner and the last update the caller can see', async () => {
    const v = (value: string, display = value) => ({ value, display_value: display });
    const { sn, calls } = adapter((url) => {
      if (url.includes('sys_user')) return jsonResponse(CALLER);
      if (url.includes('sys_journal_field')) return jsonResponse({ result: [{ value: 'Licence approved, assigning the seat today.', sys_created_on: '2026-11-17 06:00:00' }] });
      return jsonResponse({ result: [{ number: v('INC0010049'), sys_id: v('s49'), short_description: v('Figma licence needed'), state: v('2', 'In Progress'), assigned_to: v('u7', 'Meera Krishnan'), assignment_group: v('g3', 'Software'), sys_updated_on: v('2026-11-17 06:00:00'), close_notes: v('') }] });
    });
    expect(await sn.details('INC0010049')).toEqual({
      ok: true,
      value: { number: 'INC0010049', sysId: 's49', summary: 'Figma licence needed', state: 'In Progress', urgency: 3, assignee: 'Meera Krishnan', group: 'Software', createdAt: null, updatedAt: Date.UTC(2026, 10, 17, 6), lastComment: { text: 'Licence approved, assigning the seat today.', at: Date.UTC(2026, 10, 17, 6) }, resolution: null },
    });
    const incident = calls.find((c) => c.url.includes('/table/incident?'))!;
    expect(query(incident.url)).toMatchObject({ sysparm_query: 'number=INC0010049^caller_id=usr-1', sysparm_display_value: 'all', sysparm_limit: '1' });
    const journal = calls.find((c) => c.url.includes('sys_journal_field'))!;
    // Only comments the caller can see, never work notes.
    expect(query(journal.url)).toMatchObject({ sysparm_query: 'element_id=s49^element=comments^sys_created_by!=askit.bot^ORDERBYDESCsys_created_on', sysparm_limit: '1' });
  });
  it('gives nothing for someone else\'s ticket or a bad number, and keeps the facts when the comments cannot be read', async () => {
    const none = adapter((url) => (url.includes('sys_user') ? jsonResponse(CALLER) : jsonResponse({ result: [] })));
    expect(await none.sn.details('INC0010050')).toEqual({ ok: true, value: null });
    expect(none.calls.some((c) => c.url.includes('sys_journal_field'))).toBe(false);
    const bad = adapter(() => jsonResponse(CALLER));
    expect(await bad.sn.details('INC0010050^ORDERBYnumber')).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(bad.calls).toHaveLength(0);
    const v = (value: string, display = value) => ({ value, display_value: display });
    const quiet = adapter((url) =>
      url.includes('sys_user') ? jsonResponse(CALLER) : url.includes('sys_journal_field') ? jsonResponse({}, 500) : jsonResponse({ result: [{ number: v('INC0010051'), sys_id: v('s51'), short_description: v('VPN'), state: v('6', 'Resolved'), assigned_to: v(''), assignment_group: v(''), sys_updated_on: v(''), close_notes: v('Replaced the profile') }] }),
    );
    expect(await quiet.sn.details('INC0010051')).toMatchObject({ ok: true, value: { assignee: null, group: null, lastComment: null, resolution: 'Replaced the profile', state: 'Resolved' } });
  });
  it('fails when the caller has no ServiceNow user', async () => {
    const { sn, calls } = adapter(() => jsonResponse({ result: [] }));
    expect(await sn.create(NEW)).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(calls).toHaveLength(1);
  });
  it('lists my incidents with UTC dates and display labels', async () => {
    const { sn, calls } = adapter((url) =>
      url.includes('sys_user')
        ? jsonResponse(CALLER)
        : jsonResponse({
            result: [
              {
                number: { display_value: 'INC0010042', value: 'INC0010042' },
                sys_id: { display_value: 'abc', value: 'abc' },
                short_description: { display_value: 'VPN', value: 'VPN' },
                state: { display_value: 'In Progress', value: '2' },
                urgency: { display_value: '1 - High', value: '1' },
                sys_created_on: { display_value: '2026-11-17 22:00:00', value: '2026-11-18 09:00:00' },
                opened_at: { display_value: '2026-11-15 09:30:00', value: '2026-11-15 04:00:00' },
                sys_updated_on: { display_value: '2026-11-17 23:00:00', value: '2026-11-18 10:00:00' },
                resolved_at: { display_value: '', value: '' },
              },
              {
                number: { display_value: 'INC0010035', value: 'INC0010035' },
                sys_id: { display_value: 'def', value: 'def' },
                short_description: { display_value: 'Wi-Fi', value: 'Wi-Fi' },
                state: { display_value: 'Resolved', value: '6' },
                urgency: { display_value: '3 - Low', value: '3' },
                sys_created_on: { display_value: '', value: '2026-11-16 09:00:00' },
                sys_updated_on: { display_value: '', value: '2026-11-18 10:00:00' },
                resolved_at: { display_value: '', value: '2026-11-16 12:30:00' },
                correlation_id: { display_value: 'askit:NMB-7K2:fix4217', value: 'askit:NMB-7K2:fix4217' },
              },
            ],
          }),
    );
    const out = await sn.listMine();
    expect(out).toEqual({
      ok: true,
      value: [
        { number: 'INC0010042', sysId: 'abc', summary: 'VPN', state: 'In Progress', urgency: 1, createdAt: Date.UTC(2026, 10, 15, 4), updatedAt: Date.UTC(2026, 10, 18, 10) },
        { number: 'INC0010035', sysId: 'def', summary: 'Wi-Fi', state: 'Resolved', urgency: 3, createdAt: Date.UTC(2026, 10, 16, 9), updatedAt: Date.UTC(2026, 10, 18, 10), resolvedAt: Date.UTC(2026, 10, 16, 12, 30), correlationId: 'askit:NMB-7K2:fix4217' },
      ],
    });
    const list = calls[1];
    expect(list.init.method).toBe('GET');
    expect(list.url.startsWith('https://nimbus.service-now.example/api/now/table/incident?')).toBe(true);
    expect(query(list.url)).toEqual({
      sysparm_query: 'caller_id=usr-1^ORDERBYDESCopened_at',
      sysparm_limit: '25',
      sysparm_fields: 'number,short_description,state,urgency,sys_created_on,opened_at,sys_updated_on,sys_id,resolved_at,correlation_id',
      sysparm_display_value: 'all',
    });
  });
  it('adds a comment by sys_id, or looks the number up first', async () => {
    const { sn, calls } = adapter((url) => (url.includes('sysparm_query') ? jsonResponse({ result: [{ sys_id: 'xyz' }] }) : jsonResponse({ result: {} })));
    expect(await sn.addNote({ number: 'INC0010042', sysId: 'abc' }, 'Still dropping')).toEqual({ ok: true, value: null });
    expect(calls[0]).toMatchObject({ url: 'https://nimbus.service-now.example/api/now/table/incident/abc', body: { comments: 'Still dropping' } });
    expect(calls[0].init.method).toBe('PATCH');
    expect(await sn.addNote({ number: 'INC0011950', sysId: null }, 'Also affected')).toMatchObject({ ok: true });
    expect(query(calls[1].url)).toMatchObject({ sysparm_query: 'number=INC0011950', sysparm_fields: 'sys_id' });
    expect(calls[2].url).toBe('https://nimbus.service-now.example/api/now/table/incident/xyz');
  });
  it('reports an unknown number as not found', async () => {
    const { sn, calls } = adapter(() => jsonResponse({ result: [] }));
    expect(await sn.addNote({ number: 'INC0099999', sysId: null }, 'x')).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(calls).toHaveLength(1);
  });
  it('escalates with the documented fields', async () => {
    const { sn, calls } = adapter(() => jsonResponse({ result: {} }));
    await sn.escalate({ number: 'INC0010042', sysId: 'abc' }, 'Blocking a release');
    expect(calls[0].body).toEqual({ urgency: '1', impact: '2', comments: 'Blocking a release' });
    expect(calls.every((c) => c.init.method === 'PATCH')).toBe(true);
  });
  it.each([
    [401, 'unauthorized'],
    [404, 'not_found'],
    [500, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const { sn } = adapter(() => jsonResponse({ error: { message: 'nope' } }, status));
    const out = await sn.listMine();
    expect(out).toEqual({ ok: false, error: { kind, status } });
  });
  it('handles timeouts, malformed JSON, wrong shapes and network errors', async () => {
    const slow = new ServiceNowTickets(CFG, { fetch: hangingFetch() }, new Map(), { call: 30, create: 30 });
    expect(await slow.create(NEW)).toEqual({ ok: false, error: { kind: 'timeout' } });
    expect(await adapter(() => new Response('<html>oops', { status: 200 })).sn.listMine()).toEqual({ ok: false, error: { kind: 'bad_response' } });
    const wrong = adapter((url) => (url.includes('sys_user') ? jsonResponse(CALLER) : jsonResponse({ result: { nope: true } })));
    expect(await wrong.sn.create(NEW)).toEqual({ ok: false, error: { kind: 'bad_response' } });
    const down = adapter(() => {
      throw new TypeError(`connect ECONNREFUSED ${CFG.instanceUrl} ${CFG.password}`);
    });
    const out = await down.sn.addNote({ number: 'INC1', sysId: 'a' }, 'x');
    expect(out).toEqual({ ok: false, error: { kind: 'network' } });
    expect(JSON.stringify(out)).not.toMatch(/SECRET|service-now/);
  });
  it('closes a resolved incident with a work note and checks the state it kept', async () => {
    const { sn, calls } = adapter(() => jsonResponse({ result: { number: 'INC0010013', state: '7' } }));
    expect(await sn.close({ number: 'INC0010013', sysId: 'abc' }, 'Caller confirmed the fix by voice')).toEqual({ ok: true, value: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].url).toBe('https://nimbus.service-now.example/api/now/table/incident/abc?sysparm_fields=number%2Cstate');
    expect(calls[0].body).toEqual({ state: '7', work_notes: 'Caller confirmed the fix by voice' });
  });
  it('reopens to In Progress at high urgency with her words as a work note', async () => {
    const { sn, calls } = adapter(() => jsonResponse({ result: { number: 'INC0010013', state: '2' } }));
    expect(await sn.reopen({ number: 'INC0010013', sysId: 'abc' }, 'Caller says the fix did not work: still drops every hour')).toEqual({ ok: true, value: null });
    expect(calls[0].body).toEqual({ state: '2', urgency: '1', work_notes: 'Caller says the fix did not work: still drops every hour' });
  });
  it('reports a state change ServiceNow silently ignored as rejected', async () => {
    const { sn } = adapter(() => jsonResponse({ result: { number: 'INC0010013', state: '7' } }));
    expect(await sn.reopen({ number: 'INC0010013', sysId: 'abc' }, 'x')).toEqual({ ok: false, error: { kind: 'rejected' } });
    const odd = adapter(() => jsonResponse({ result: [] }));
    expect(await odd.sn.close({ number: 'INC0010013', sysId: 'abc' }, 'x')).toEqual({ ok: false, error: { kind: 'bad_response' } });
  });
  it('maps a business rule refusal, a 403 and a timeout on close or reopen', async () => {
    const rule = adapter(() => jsonResponse({ error: { message: 'Operation against file incident was aborted by Business Rule', detail: 'x' }, status: 'failure' }, 403));
    expect(await rule.sn.reopen({ number: 'INC0010013', sysId: 'abc' }, 'x')).toEqual({ ok: false, error: { kind: 'rejected', status: 403 } });
    const denied = adapter(() => new Response('', { status: 403 }));
    expect(await denied.sn.close({ number: 'INC0010013', sysId: 'abc' }, 'x')).toEqual({ ok: false, error: { kind: 'unauthorized', status: 403 } });
    const slow = new ServiceNowTickets(CFG, { fetch: hangingFetch() }, new Map(), { call: 30, create: 30 });
    expect(await slow.close({ number: 'INC0010013', sysId: 'abc' }, 'x')).toEqual({ ok: false, error: { kind: 'timeout' } });
  });
  it('looks the number up for a simulated or missing sys_id before closing', async () => {
    const { sn, calls } = adapter((url) => (url.includes('sysparm_query') ? jsonResponse({ result: [{ sys_id: 'real-1' }] }) : jsonResponse({ result: { state: '7' } })));
    expect(await sn.close({ number: 'INC0010013', sysId: 'sim-INC0010013' }, 'x')).toEqual({ ok: true, value: null });
    expect(calls[1].url).toBe('https://nimbus.service-now.example/api/now/table/incident/real-1?sysparm_fields=number%2Cstate');
    expect(await sn.reopen({ number: 'INC0010013^ORDERBYnumber', sysId: null }, 'x')).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(calls).toHaveLength(2);
  });
  it('logs a fix made on the call as one incident created already resolved, in the Service Desk group', async () => {
    const at = Date.UTC(2026, 10, 18, 4, 5, 6);
    const { sn, calls } = adapter((url) =>
      url.includes('sys_user_group') ? jsonResponse({ result: [{ sys_id: 'grp-sd' }] }) : url.includes('sys_user') ? jsonResponse(CALLER) : jsonResponse({ result: { number: 'INC0010050', sys_id: 'fix' } }, 201),
    );
    const fix = { ...NEW, shortDescription: 'VPN fixed', correlationId: 'askit:NMB-7K2:fix4217', resolution: { notes: 'Resolved on the call by ASK IT. VPN fixed.', at } };
    expect(await sn.create(fix)).toEqual({ ok: true, value: { number: 'INC0010050', sysId: 'fix' } });
    const lookup = calls.find((c) => c.url.includes('sys_user_group'))!;
    expect(query(lookup.url)).toMatchObject({ sysparm_query: 'name=Service Desk^active=true', sysparm_fields: 'sys_id', sysparm_limit: '1' });
    const posts = calls.filter((c) => c.init.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      short_description: 'VPN fixed', description: 'Tried 3 steps', urgency: '2', impact: '3', category: 'network', caller_id: 'usr-1', contact_type: 'virtual_agent', correlation_id: 'askit:NMB-7K2:fix4217',
      state: '6', close_code: 'Resolved – Permanent Fix Applied', close_notes: 'Resolved on the call by ASK IT. VPN fixed.', resolved_at: '2026-11-18 04:05:06', assignment_group: 'grp-sd',
    });
    await sn.create(fix);
    expect(calls.filter((c) => c.url.includes('sys_user_group'))).toHaveLength(1);
    expect(calls.filter((c) => c.init.method !== 'POST' && !c.url.includes('sys_user_group'))).toHaveLength(1);
  });
  it('logs the fix without a group when there is no Service Desk group or the lookup fails, and uses the close code from env', async () => {
    const missing = fakeFetch((url) => (url.includes('sys_user_group') ? jsonResponse({ result: [] }) : url.includes('sys_user') ? jsonResponse(CALLER) : jsonResponse({ result: { number: 'INC0010051', sys_id: 'f2' } }, 201)));
    const sn = new ServiceNowTickets({ ...CFG, closeCode: 'Solved' }, { fetch: missing.fetch }, new Map());
    const fix = { ...NEW, resolution: { notes: 'x', at: 0 } };
    expect(await sn.create(fix)).toMatchObject({ ok: true });
    const post = missing.calls.find((c) => c.init.method === 'POST')!;
    expect(post.body).toMatchObject({ state: '6', close_code: 'Solved' });
    expect(post.body).not.toHaveProperty('assignment_group');
    const down = fakeFetch((url) => (url.includes('sys_user_group') ? jsonResponse({}, 500) : url.includes('sys_user') ? jsonResponse(CALLER) : jsonResponse({ result: { number: 'INC0010052', sys_id: 'f3' } }, 201)));
    const flaky = new ServiceNowTickets(CFG, { fetch: down.fetch }, new Map());
    expect(await flaky.create(fix)).toMatchObject({ ok: true, value: { number: 'INC0010052' } });
    await flaky.create(fix);
    // A failed lookup is tried again next time; a missing group is remembered.
    expect(down.calls.filter((c) => c.url.includes('sys_user_group'))).toHaveLength(2);
    await sn.create(fix);
    expect(missing.calls.filter((c) => c.url.includes('sys_user_group'))).toHaveLength(1);
  });
});

describe('ServiceNow create when the answer is lost', () => {
  const postHangs = (lookup: unknown) =>
    (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.includes('sys_user')) return jsonResponse(CALLER);
      if (init.method === 'GET') return jsonResponse(lookup);
      return new Promise<Response>((_r, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }) as typeof fetch;

  it('finds the incident by correlation_id after a timeout', async () => {
    const calls: string[] = [];
    const base = postHangs({ result: [{ number: 'INC0010050', sys_id: 'late' }] });
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => (calls.push(`${init?.method} ${String(input)}`), base(input, init))) as typeof fetch;
    const sn = new ServiceNowTickets(CFG, { fetch: spy }, new Map(), { call: 1000, create: 30 });
    expect(await sn.create(NEW)).toEqual({ ok: true, value: { number: 'INC0010050', sysId: 'late' } });
    const lookup = calls.find((c) => c.startsWith('GET') && c.includes('/incident?'))!;
    expect(query(lookup.slice(4))).toMatchObject({ sysparm_query: 'correlation_id=askit:NMB-7K2:4217', sysparm_fields: 'number,sys_id', sysparm_limit: '1' });
  });
  it('still reports the timeout when no incident is found', async () => {
    const sn = new ServiceNowTickets(CFG, { fetch: postHangs({ result: [] }) }, new Map(), { call: 1000, create: 30 });
    expect(await sn.create(NEW)).toEqual({ ok: false, error: { kind: 'timeout' } });
  });
  it('looks up by correlation id, and refuses odd ids without calling', async () => {
    const { sn, calls } = adapter(() => jsonResponse({ result: [] }));
    expect(await sn.find('askit:NMB-7K2:4217')).toEqual({ ok: true, value: null });
    expect(await sn.find('askit:x^ORDERBYsys_id:1')).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(calls).toHaveLength(1);
  });
});

describe('ServiceNow query safety', () => {
  it('never puts an invalid ticket number into a query', async () => {
    const { sn, calls } = adapter(() => jsonResponse({ result: [{ sys_id: 'x' }] }));
    expect(await sn.addNote({ number: 'INC0011950^ORDERBYnumber', sysId: null }, 'x')).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(await sn.escalate({ number: 'INC12', sysId: null }, 'x')).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(calls).toHaveLength(0);
  });
  it('refuses a caller email with a query operator', async () => {
    const f = fakeFetch(() => jsonResponse(CALLER));
    const sn = new ServiceNowTickets({ ...CFG, callerEmail: 'a@x^ORactive=true' }, { fetch: f.fetch }, new Map());
    expect(await sn.listMine()).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(f.calls).toHaveLength(0);
  });
  it('never sends a simulated sys_id to the live API', async () => {
    const { sn, calls } = adapter((url) => (url.includes('sysparm_query') ? jsonResponse({ result: [{ sys_id: 'real-1' }] }) : jsonResponse({ result: {} })));
    expect(await sn.addNote({ number: 'INC0011994', sysId: 'sim-INC0011994' }, 'x')).toMatchObject({ ok: true });
    expect(calls.map((c) => c.url).join(' ')).not.toMatch(/sim-/);
    expect(calls[1].url).toBe('https://nimbus.service-now.example/api/now/table/incident/real-1');
  });
});
