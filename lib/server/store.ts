// Versioned key-value store: each write names the version it read, so parallel tool calls never overwrite each other.

export interface VersionedStore {
  get(key: string): Promise<{ value: string; version: number } | null>;
  // Writes only if the stored version equals `expectedVersion` (0 = key must not exist).
  setIfVersion(key: string, value: string, expectedVersion: number, ttlSeconds: number): Promise<boolean>;
}

export class MemoryStore implements VersionedStore {
  private data = new Map<string, { value: string; version: number; expiresAt: number }>();
  constructor(private clock: () => number = Date.now) {}

  private read(key: string) {
    const entry = this.data.get(key);
    if (!entry || entry.expiresAt <= this.clock()) {
      this.data.delete(key);
      return null;
    }
    return { value: entry.value, version: entry.version };
  }

  async get(key: string) {
    // Behave like a network store: callers interleave.
    await Promise.resolve();
    return this.read(key);
  }

  async setIfVersion(key: string, value: string, expectedVersion: number, ttlSeconds: number) {
    await Promise.resolve();
    // Check and write with no await in between, so the pair is atomic.
    if ((this.read(key)?.version ?? 0) !== expectedVersion) return false;
    this.data.set(key, { value, version: expectedVersion + 1, expiresAt: this.clock() + ttlSeconds * 1000 });
    return true;
  }
}

// Atomic check-and-set in one round trip. The hash holds v (version) and d (JSON data).
const CAS_SCRIPT = `
local v = redis.call('HGET', KEYS[1], 'v')
if (v or '0') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'v', tostring(tonumber(ARGV[1]) + 1), 'd', ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1`;

export class UpstashStore implements VersionedStore {
  constructor(
    private url: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async command(cmd: string[]): Promise<unknown> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Upstash request failed with HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: string };
    if (body.error) throw new Error(`Upstash error: ${body.error}`);
    return body.result;
  }

  async get(key: string) {
    const [v, d] = (await this.command(['HMGET', key, 'v', 'd'])) as [string | null, string | null];
    return d === null || d === undefined ? null : { value: d, version: Number(v) };
  }

  async setIfVersion(key: string, value: string, expectedVersion: number, ttlSeconds: number) {
    const r = await this.command(['EVAL', CAS_SCRIPT, '1', key, String(expectedVersion), value, String(ttlSeconds)]);
    return Number(r) === 1;
  }
}

type Env = Record<string, string | undefined>;

// Upstash (or Vercel KV, same REST API) when configured; otherwise one in-process memory store.
export function getStore(env: Env = process.env): VersionedStore {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashStore(url, token);
  // Route bundles can load this module separately; share one instance per process.
  const g = globalThis as typeof globalThis & { __askitMemoryStore?: MemoryStore };
  return (g.__askitMemoryStore ??= new MemoryStore());
}

export const usingSharedStore = (env: Env = process.env) =>
  Boolean((env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL) && (env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN));
