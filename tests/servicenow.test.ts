import { describe, expect, it } from 'vitest';
import { ServiceNowTickets, serviceNowConfig } from '@/lib/integrations/servicenow';
import { fakeFetch, hangingFetch, headerOf, jsonResponse } from './fakes';

const CFG = { instanceUrl: 'https://nimbus.service-now.example', user: 'askit.bot', password: 'pa55-SECRET', callerEmail: 'priya.sharma@nimbuslabs.example', closeCode: 'Resolved – Permanent Fix Applied' };
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
    expect(query(lookup.url)).toMatchObject({ sysparm_query: 'email=priya.sharma@nimbuslabs.example', sysparm_fields: 'sys_id', sysparm_limit: '1' });
    expect(post.url).toBe('https://nimbus.service-now.example/api/now/table/incident');
    expect(post.init.method).toBe('POST');
    expect(headerOf(post.init, 'authorization')).toBe(BASIC);
    expect(headerOf(post.init, 'content-type')).toBe('application/json');
    expect(post.body).toEqual({ short_description: 'VPN keeps dropping', description: 'Tried 3 steps', urgency: '2', impact: '3', category: 'network', caller_id: 'usr-1', contact_type: 'virtual_agent', correlation_id: 'askit:NMB-7K2:4217' });
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
                sys_updated_on: { display_value: '2026-11-17 23:00:00', value: '2026-11-18 10:00:00' },
              },
            ],
          }),
    );
    const out = await sn.listMine();
    expect(out).toEqual({ ok: true, value: [{ number: 'INC0010042', sysId: 'abc', summary: 'VPN', state: 'In Progress', urgency: 1, createdAt: Date.UTC(2026, 10, 18, 9), updatedAt: Date.UTC(2026, 10, 18, 10) }] });
    const list = calls[1];
    expect(list.init.method).toBe('GET');
    expect(list.url.startsWith('https://nimbus.service-now.example/api/now/table/incident?')).toBe(true);
    expect(query(list.url)).toEqual({
      sysparm_query: 'caller_id=usr-1^ORDERBYDESCsys_created_on',
      sysparm_limit: '10',
      sysparm_fields: 'number,short_description,state,urgency,sys_created_on,sys_updated_on,sys_id',
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
  it('escalates and resolves with the documented fields', async () => {
    const { sn, calls } = adapter(() => jsonResponse({ result: {} }));
    await sn.escalate({ number: 'INC0010042', sysId: 'abc' }, 'Blocking a release');
    expect(calls[0].body).toEqual({ urgency: '1', impact: '2', comments: 'Blocking a release' });
    await sn.resolve({ number: 'INC0010042', sysId: 'abc' }, 'Fixed by restarting GlobalProtect');
    expect(calls[1].body).toEqual({ state: '6', close_code: 'Resolved – Permanent Fix Applied', close_notes: 'Fixed by restarting GlobalProtect' });
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
  it('resolves with the close code from env', async () => {
    const f = fakeFetch(() => jsonResponse({ result: {} }));
    await new ServiceNowTickets({ ...CFG, closeCode: 'Solved' }, { fetch: f.fetch }, new Map()).resolve({ number: 'INC0010042', sysId: 'abc' }, 'x');
    expect(f.calls[0].body).toMatchObject({ close_code: 'Solved' });
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
