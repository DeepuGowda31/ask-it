import { describe, expect, it } from 'vitest';
import { ServiceNowKnowledge, SimulatedKnowledge } from '@/lib/integrations/servicenow-kb';
import { fakeFetch, hangingFetch, headerOf, jsonResponse } from './fakes';

const CFG = { instanceUrl: 'https://nimbus.service-now.example', user: 'askit.bot', password: 'pa55-SECRET', callerEmail: 'it@x.example', closeCode: 'Resolved – Permanent Fix Applied' };
const BASIC = `Basic ${Buffer.from('askit.bot:pa55-SECRET').toString('base64')}`;

const row = (number: string, title: string, text: string) => ({ number, short_description: title, text });

function adapter(handler: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(handler);
  return { kb: new ServiceNowKnowledge(CFG, { fetch: f.fetch }), calls: f.calls };
}

const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('ServiceNow knowledge', () => {
  it('reads published articles with a text search and display values', async () => {
    const { kb, calls } = adapter(() => jsonResponse({ result: [] }));
    expect(kb.mode).toBe('live');
    expect(await kb.search('How do I set up an Outlook signature?')).toEqual({ ok: true, value: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith('https://nimbus.service-now.example/api/now/table/kb_knowledge?')).toBe(true);
    expect(calls[0].init.method).toBe('GET');
    expect(headerOf(calls[0].init, 'authorization')).toBe(BASIC);
    expect(query(calls[0].url)).toEqual({
      sysparm_query: 'workflow_state=published^active=true^123TEXTQUERY321=how do i set up an outlook signature',
      sysparm_fields: 'number,short_description,text',
      sysparm_display_value: 'true',
      sysparm_limit: '10',
    });
  });
  it('cannot be steered by operators in the spoken query', async () => {
    const { kb, calls } = adapter(() => jsonResponse({ result: [] }));
    await kb.search('vpn^NQactive=false^ORDERBYnumber\nworkflow_state=draft');
    const q = query(calls[0].url).sysparm_query;
    expect(q).toBe('workflow_state=published^active=true^123TEXTQUERY321=vpn nqactive false orderbynumber workflow state draft');
    expect(q.split('^')).toHaveLength(3);
  });
  it('makes no call when the query has no words', async () => {
    const { kb, calls } = adapter(() => jsonResponse({ result: [] }));
    expect(await kb.search(' ?! ^= ')).toEqual({ ok: true, value: [] });
    expect(calls).toHaveLength(0);
  });
  it('turns article HTML into short plain text', async () => {
    const html = `<style>p { color: red }</style><h2>Expenses</h2>\n<p>Open&nbsp;SAP Concur &amp; choose <b>Expense</b>.</p><script>alert(1)</script><p>Tom&#39;s &quot;tip&quot;: use &lt;Submit&gt;&#x21;</p>`;
    const { kb } = adapter(() => jsonResponse({ result: [row('KB0010001', '  Submit an\n expense   report ', html)] }));
    expect(await kb.search('expense report')).toEqual({
      ok: true,
      value: [{ number: 'KB0010001', title: 'Submit an expense report', summary: `Expenses Open SAP Concur & choose Expense. Tom's "tip": use <Submit>!` }],
    });
  });
  it('trims long articles to about 400 characters at a word boundary', async () => {
    const long = `<p>${'Restart the laptop and try again. '.repeat(30)}</p>`;
    const { kb } = adapter(() => jsonResponse({ result: [row('KB0010002', 'Long one', long)] }));
    const res = await kb.search('laptop');
    const summary = res.ok ? res.value[0].summary : '';
    expect(summary.length).toBeLessThanOrEqual(401);
    expect(summary.length).toBeGreaterThan(350);
    expect(summary).toMatch(/\w…$/);
    expect(summary).not.toMatch(/ …$/);
  });
  it('skips demo-template articles and rows without a number or title, and returns at most two', async () => {
    const rows = [
      row('KB0000011', 'Outlook demo data article', 'x'),
      row('KB0000012', 'This is a Demo Article', 'x'),
      { short_description: 'No number', text: 'x' },
      row('KB0010003', '', 'No title'),
      'junk',
      row('KB0010004', 'Outlook signature', '<p>Settings, Signatures.</p>'),
      row('KB0010005', 'Outlook rules', ''),
      row('KB0010006', 'Outlook folders', 'Third match'),
    ];
    const { kb } = adapter(() => jsonResponse({ result: rows }));
    expect(await kb.search('outlook')).toEqual({
      ok: true,
      value: [
        { number: 'KB0010004', title: 'Outlook signature', summary: 'Settings, Signatures.' },
        { number: 'KB0010005', title: 'Outlook rules', summary: '' },
      ],
    });
  });
  it('reports malformed and failed responses as typed failures', async () => {
    const bad = { ok: false, error: { kind: 'bad_response' } };
    expect(await adapter(() => new Response('')).kb.search('vpn')).toEqual(bad);
    expect(await adapter(() => new Response('<html>')).kb.search('vpn')).toEqual(bad);
    expect(await adapter(() => jsonResponse({ result: 'nope' })).kb.search('vpn')).toEqual(bad);
    expect(await adapter(() => jsonResponse({})).kb.search('vpn')).toEqual(bad);
    expect(await adapter(() => jsonResponse({ error: { message: 'no' } }, 401)).kb.search('vpn')).toMatchObject({ ok: false, error: { kind: 'unauthorized' } });
  });
  it('gives up within its own short timeout', async () => {
    const kb = new ServiceNowKnowledge(CFG, { fetch: hangingFetch() }, 30);
    expect(await kb.search('vpn')).toEqual({ ok: false, error: { kind: 'timeout' } });
  });
});

describe('simulated knowledge', () => {
  const kb = new SimulatedKnowledge();
  it('returns the fixed articles that share a word with the query, best first', async () => {
    expect(kb.mode).toBe('simulated');
    const res = await kb.search('how do I set up an email signature');
    expect(res.ok && res.value[0]).toMatchObject({ number: expect.stringMatching(/^KB\d{7}$/), title: expect.stringMatching(/signature/i) });
    expect(res.ok && res.value.length).toBeLessThanOrEqual(2);
    expect(res.ok && res.value[0].summary.length).toBeGreaterThan(40);
  });
  it('returns nothing for unrelated queries', async () => {
    expect(await kb.search('banana smoothie')).toEqual({ ok: true, value: [] });
    expect(await kb.search('')).toEqual({ ok: true, value: [] });
  });
});
