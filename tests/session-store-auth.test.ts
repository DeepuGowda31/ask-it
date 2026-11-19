import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, UpstashStore, getStore } from '@/lib/server/store';
import { SessionNotFoundError, createSession, generateSessionCode, isValidSessionCode, loadSession, normalizeSessionCode, updateSession, SESSION_TTL_SECONDS } from '@/lib/server/session';
import { isAuthorizedToolCall } from '@/lib/server/auth';
import { runTool } from '@/lib/domain/tools';
import { findAction } from '@/lib/domain/actions';
import { NOW } from './helpers';

describe('session codes', () => {
  it('generates readable codes like NMB-7K2', () => {
    for (let i = 0; i < 50; i++) expect(generateSessionCode()).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
    expect(generateSessionCode(() => 0)).toBe('AAA-AAA');
    expect(isValidSessionCode('FX7-29K')).toBe(true);
    expect(normalizeSessionCode(' fx7-29k ')).toBe('FX7-29K');
    expect(isValidSessionCode('FX7-20K')).toBe(false); // 0 is ambiguous and never issued
    expect(isValidSessionCode('../etc')).toBe(false);
  });
});

describe('memory store', () => {
  it('does compare-and-set with versions', async () => {
    const s = new MemoryStore();
    expect(await s.get('k')).toBeNull();
    expect(await s.setIfVersion('k', 'a', 0, 60)).toBe(true);
    expect(await s.setIfVersion('k', 'b', 0, 60)).toBe(false);
    expect(await s.get('k')).toEqual({ value: 'a', version: 1 });
    expect(await s.setIfVersion('k', 'b', 1, 60)).toBe(true);
    expect(await s.setIfVersion('k', 'c', 1, 60)).toBe(false);
    expect(await s.get('k')).toEqual({ value: 'b', version: 2 });
  });
  it('expires keys', async () => {
    let t = 0;
    const s = new MemoryStore(() => t);
    await s.setIfVersion('k', 'a', 0, 10);
    t = 9_999;
    expect(await s.get('k')).not.toBeNull();
    t = 10_001;
    expect(await s.get('k')).toBeNull();
  });
});

describe('sessions', () => {
  it('are stored under askit:session: and isolated from each other', async () => {
    const store = new MemoryStore();
    const a = await createSession(store, NOW);
    const b = await createSession(store, NOW);
    expect(a).not.toBe(b);
    expect(await store.get(`askit:session:${a}`)).not.toBeNull();
    await updateSession(store, a, (s) => runTool('startTroubleshooting', s, { articleId: 'vpn', issue: '' }, NOW));
    expect((await loadSession(store, a))!.state.troubleshooting?.articleId).toBe('vpn');
    expect((await loadSession(store, b))!.state.troubleshooting).toBeNull();
  });
  it('report unknown or expired sessions', async () => {
    let t = 0;
    const store = new MemoryStore(() => t);
    const code = await createSession(store, NOW);
    t = SESSION_TTL_SECONDS * 1000 + 1;
    expect(await loadSession(store, code)).toBeNull();
    await expect(updateSession(store, code, (s) => runTool('searchKnowledge', s, { query: 'vpn' }, NOW))).rejects.toBeInstanceOf(SessionNotFoundError);
  });
  it('skip the write when nothing changed', async () => {
    const store = new MemoryStore();
    const code = await createSession(store, NOW);
    const out = await updateSession(store, code, (state) => ({ state }));
    expect(out.version).toBe(1);
    expect((await loadSession(store, code))!.version).toBe(1);
  });
  it('never lose concurrent writes', async () => {
    const store = new MemoryStore();
    const code = await createSession(store, NOW);
    const summaries = Array.from({ length: 6 }, (_, i) => `issue ${i}`);
    await Promise.all(summaries.map((summary) => updateSession(store, code, (s) => runTool('prepareTicket', s, { summary, urgency: 'low', details: '' }, NOW))));
    const { state, version } = (await loadSession(store, code))!;
    expect(state.events).toHaveLength(6);
    expect(state.pending.map((a) => a.summary.split(': ')[1]).sort()).toEqual(summaries);
    expect(new Set(state.pending.map((a) => a.code)).size).toBe(6);
    expect(findAction(state, state.pending[0].code)).toBeDefined();
    expect(version).toBe(7);
  });
});

describe('Upstash REST store', () => {
  function fakeRedis() {
    const hashes = new Map<string, { v: string; d: string }>();
    const calls: unknown[][] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const cmd = JSON.parse(String(init.body)) as string[];
      calls.push(cmd);
      let result: unknown = null;
      if (cmd[0] === 'HMGET') {
        const h = hashes.get(cmd[1]);
        result = [h?.v ?? null, h?.d ?? null];
      } else if (cmd[0] === 'EVAL') {
        const [, , , key, expected, value] = cmd;
        const cur = hashes.get(key)?.v ?? '0';
        if (cur !== expected) result = 0;
        else {
          hashes.set(key, { v: String(Number(expected) + 1), d: value });
          result = 1;
        }
      }
      return new Response(JSON.stringify({ result }), { status: 200 });
    });
    return { fetchImpl, calls };
  }
  it('sends authenticated commands and honours versions', async () => {
    const { fetchImpl, calls } = fakeRedis();
    const s = new UpstashStore('https://example.upstash.io', 'tok', fetchImpl as unknown as typeof fetch);
    expect(await s.get('k')).toBeNull();
    expect(await s.setIfVersion('k', 'a', 0, 60)).toBe(true);
    expect(await s.setIfVersion('k', 'b', 0, 60)).toBe(false);
    expect(await s.get('k')).toEqual({ value: 'a', version: 1 });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls[1][0]).toBe('EVAL');
    expect(calls[1].slice(2)).toEqual(['1', 'k', '0', 'a', '60']);
  });
  it('surfaces HTTP errors', async () => {
    const s = new UpstashStore('https://x', 't', (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch);
    await expect(s.get('k')).rejects.toThrow(/Upstash/);
  });
  it('is selected only when configured', () => {
    expect(getStore({})).toBeInstanceOf(MemoryStore);
    expect(getStore({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' })).toBeInstanceOf(UpstashStore);
    expect(getStore({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' })).toBeInstanceOf(UpstashStore);
  });
});

describe('tool secret auth', () => {
  it('uses a constant-time comparison and fails closed', () => {
    expect(isAuthorizedToolCall('s3cret-value', 's3cret-value')).toBe(true);
    expect(isAuthorizedToolCall('s3cret-valuX', 's3cret-value')).toBe(false);
    expect(isAuthorizedToolCall('short', 's3cret-value')).toBe(false);
    expect(isAuthorizedToolCall(null, 's3cret-value')).toBe(false);
    expect(isAuthorizedToolCall('', '')).toBe(false);
    expect(isAuthorizedToolCall('anything', undefined)).toBe(false);
  });
});
