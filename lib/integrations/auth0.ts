import { failure, requestJson, requestText, success, type Http, type Result } from './http';
import type { AccountAction, AccountInfo, IdentityAdapter } from './types';

type Env = Record<string, string | undefined>;

interface Auth0Config {
  domain: string;
  clientId: string;
  clientSecret: string;
  otpClientId: string;
  otpClientSecret: string;
  email: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const TIMEOUT_MS = 4000;
const DATABASE = 'Username-Password-Authentication';
const OTP_GRANT = 'http://auth0.com/oauth/grant-type/passwordless/otp';

// Management tokens survive across requests in the same process.
const TOKENS = new Map<string, CachedToken>();

export function auth0Config(env: Env): Auth0Config | null {
  const raw = env.AUTH0_DOMAIN?.trim().replace(/\/+$/, '');
  const domain = raw && !/^https?:\/\//.test(raw) ? `https://${raw}` : raw;
  const cfg = {
    domain: domain ?? '',
    clientId: env.AUTH0_CLIENT_ID?.trim() ?? '',
    clientSecret: env.AUTH0_CLIENT_SECRET ?? '',
    otpClientId: env.AUTH0_OTP_CLIENT_ID?.trim() ?? '',
    otpClientSecret: env.AUTH0_OTP_CLIENT_SECRET ?? '',
    email: env.AUTH0_USER_EMAIL?.trim() ?? '',
  };
  return Object.values(cfg).every(Boolean) ? cfg : null;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const badResponse = <T>() => failure<T>({ kind: 'bad_response' });
const enc = encodeURIComponent;

export class Auth0Identity implements IdentityAdapter {
  readonly mode = 'live';

  constructor(
    private cfg: Auth0Config,
    private http: Http,
    private tokens: Map<string, CachedToken> = TOKENS,
    private timeoutMs = TIMEOUT_MS,
  ) {}

  private now() {
    return (this.http.now ?? Date.now)();
  }

  private post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) };
    return { url: `${this.cfg.domain}${path}`, init };
  }

  private async managementToken(): Promise<Result<string>> {
    const key = `${this.cfg.domain}|${this.cfg.clientId}`;
    const cached = this.tokens.get(key);
    if (cached && this.now() < cached.expiresAt) return success(cached.token);
    const { url, init } = this.post('/oauth/token', {
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      audience: `${this.cfg.domain}/api/v2/`,
    });
    const res = await requestJson(this.http, url, init, this.timeoutMs);
    if (!res.ok) return res;
    const body = res.value;
    if (!isRecord(body) || typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') return badResponse();
    // Refresh a minute early so a token never expires mid-call.
    this.tokens.set(key, { token: body.access_token, expiresAt: this.now() + (body.expires_in - 60) * 1000 });
    return success(body.access_token);
  }

  // Management API call; a 401 drops the cached token and retries once.
  private async management(method: string, path: string, body?: unknown, retry = true): Promise<Result<unknown>> {
    const token = await this.managementToken();
    if (!token.ok) return token;
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${token.value}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const res = await requestJson(this.http, `${this.cfg.domain}/api/v2${path}`, init, this.timeoutMs);
    if (!res.ok && res.error.status === 401 && retry) {
      this.tokens.delete(`${this.cfg.domain}|${this.cfg.clientId}`);
      return this.management(method, path, body, false);
    }
    return res;
  }

  async getUser(): Promise<Result<AccountInfo>> {
    const found = await this.management('GET', `/users-by-email?email=${enc(this.cfg.email)}`);
    if (!found.ok) return found;
    if (!Array.isArray(found.value)) return badResponse();
    const user = found.value.find((u): u is Json => isRecord(u) && Array.isArray(u.identities) && u.identities.some((i) => isRecord(i) && i.connection === DATABASE));
    if (!user) return failure({ kind: 'not_found' });
    if (typeof user.user_id !== 'string') return badResponse();
    let locked = user.blocked === true;
    if (!locked) {
      const blocks = await this.management('GET', `/user-blocks/${enc(user.user_id)}`);
      if (!blocks.ok) return blocks;
      if (!isRecord(blocks.value) || !Array.isArray(blocks.value.blocked_for)) return badResponse();
      locked = blocks.value.blocked_for.length > 0;
    }
    const methods = await this.authenticationMethods(user.user_id);
    if (!methods.ok) return methods;
    const reset = typeof user.last_password_reset === 'string' ? Date.parse(user.last_password_reset) : NaN;
    return success({
      userId: user.user_id,
      email: typeof user.email === 'string' ? user.email : this.cfg.email,
      locked,
      lastPasswordReset: Number.isNaN(reset) ? null : reset,
      factors: methods.value ?? [],
      factorsKnown: methods.value !== null,
    });
  }

  // Enrolled MFA types, or null when the tenant does not allow reading them (403 or 404).
  private async authenticationMethods(userId: string): Promise<Result<string[] | null>> {
    const res = await this.management('GET', `/users/${enc(userId)}/authentication-methods`);
    if (!res.ok) return res.error.status === 403 || res.error.status === 404 ? success(null) : res;
    if (!Array.isArray(res.value)) return badResponse();
    return success(res.value.filter(isRecord).map((m) => String(m.type)));
  }

  async sendCode(): Promise<Result<string | null>> {
    const { url, init } = this.post('/passwordless/start', {
      client_id: this.cfg.otpClientId,
      client_secret: this.cfg.otpClientSecret,
      connection: 'email',
      email: this.cfg.email,
      send: 'code',
    });
    const res = await requestJson(this.http, url, init, this.timeoutMs);
    return res.ok ? success(null) : res;
  }

  async verifyCode(code: string): Promise<Result<boolean>> {
    const { url, init } = this.post('/oauth/token', {
      grant_type: OTP_GRANT,
      client_id: this.cfg.otpClientId,
      client_secret: this.cfg.otpClientSecret,
      username: this.cfg.email,
      otp: code,
      realm: 'email',
      scope: 'openid',
    });
    // The returned tokens are discarded: a 200 is all the proof we need.
    const res = await requestText(this.http, url, init, this.timeoutMs);
    // A blocked user only hears "blocked" after a right code; a wrong one is invalid_grant.
    if (res.ok || res.error.code === 'user_blocked') return success(true);
    return res.error.status === 403 && res.error.code === 'invalid_grant' ? success(false) : res;
  }

  async lifecycle(user: { userId: string; email: string }, action: AccountAction): Promise<Result<null>> {
    const id = enc(user.userId);
    if (action === 'unlock') {
      const patched = await this.management('PATCH', `/users/${id}`, { blocked: false });
      if (!patched.ok) return patched;
      const cleared = await this.management('DELETE', `/user-blocks/${id}`);
      return cleared.ok ? success(null) : cleared;
    }
    if (action === 'resetMfa') {
      const res = await this.management('DELETE', `/users/${id}/authenticators`);
      return res.ok ? success(null) : res;
    }
    // Answers with plain text, not JSON.
    const { url, init } = this.post('/dbconnections/change_password', { client_id: this.cfg.clientId, email: user.email, connection: DATABASE });
    const res = await requestText(this.http, url, init, this.timeoutMs);
    return res.ok ? success(null) : res;
  }

  async block(userId: string): Promise<Result<null>> {
    const res = await this.management('PATCH', `/users/${enc(userId)}`, { blocked: true });
    return res.ok ? success(null) : res;
  }

  endSessions(userId: string) {
    return this.deleteAll(`/users/${enc(userId)}/sessions`);
  }

  revokeRefreshTokens(userId: string) {
    return this.deleteAll(`/users/${enc(userId)}/refresh-tokens`);
  }

  // A 404 means there was nothing left to delete.
  private async deleteAll(path: string): Promise<Result<null>> {
    const res = await this.management('DELETE', path);
    return res.ok || res.error.status === 404 ? success(null) : res;
  }
}
