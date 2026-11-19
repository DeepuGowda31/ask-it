import { describe, expect, it } from 'vitest';
import { Auth0Identity, auth0Config } from '@/lib/integrations/auth0';
import { fakeFetch, hangingFetch, headerOf, jsonResponse } from './fakes';

const CFG = {
  domain: 'https://nimbus.us.auth0.example',
  clientId: 'm2m-id',
  clientSecret: 'm2m-SECRET',
  otpClientId: 'otp-id',
  otpClientSecret: 'otp-SECRET',
  email: 'priya.sharma@nimbuslabs.example',
};
const TOKEN = { access_token: 'mgmt-TOKEN-1', expires_in: 86400, token_type: 'Bearer' };
const USER = {
  user_id: 'auth0|priya',
  email: CFG.email,
  blocked: false,
  last_password_reset: '2026-09-01T10:00:00.000Z',
  multifactor: ['guardian'],
  identities: [{ connection: 'Username-Password-Authentication', provider: 'auth0' }],
};
const OTHER = { ...USER, user_id: 'google-oauth2|1', identities: [{ connection: 'google-oauth2' }] };

type Handler = (url: string, init: RequestInit) => Response;

function routes(extra: Record<string, Handler> = {}): Handler {
  return (url, init) => {
    for (const [key, h] of Object.entries(extra)) if (`${init.method} ${url}`.includes(key)) return h(url, init);
    if (url.endsWith('/oauth/token')) return jsonResponse(TOKEN);
    if (url.includes('/users-by-email')) return jsonResponse([OTHER, USER]);
    if (url.includes('/user-blocks/')) return jsonResponse({ blocked_for: [] });
    if (url.includes('/authentication-methods')) return jsonResponse([{ id: 'email|1', type: 'email' }, { id: 'totp|2', type: 'otp' }]);
    return jsonResponse({});
  };
}

function adapter(handler: Handler, clock = () => 0) {
  const f = fakeFetch(handler);
  return { auth0: new Auth0Identity(CFG, { fetch: f.fetch, now: clock }, new Map()), calls: f.calls };
}

describe('Auth0 config', () => {
  const env = { AUTH0_DOMAIN: 'nimbus.us.auth0.example/', AUTH0_CLIENT_ID: 'a', AUTH0_CLIENT_SECRET: 'b', AUTH0_OTP_CLIENT_ID: 'c', AUTH0_OTP_CLIENT_SECRET: 'd', AUTH0_USER_EMAIL: 'e@x' };
  it('needs all six variables and normalises the domain', () => {
    expect(auth0Config({ ...env, AUTH0_OTP_CLIENT_SECRET: '' })).toBeNull();
    expect(auth0Config(env)).toEqual({ domain: 'https://nimbus.us.auth0.example', clientId: 'a', clientSecret: 'b', otpClientId: 'c', otpClientSecret: 'd', email: 'e@x' });
  });
});

describe('Auth0 management token', () => {
  it('uses client credentials and caches the token until 60 s before expiry', async () => {
    let t = 0;
    const { auth0, calls } = adapter(routes(), () => t);
    await auth0.getUser();
    await auth0.getUser();
    const tokenCalls = () => calls.filter((c) => c.url.endsWith('/oauth/token'));
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0].init.method).toBe('POST');
    expect(tokenCalls()[0].body).toEqual({ grant_type: 'client_credentials', client_id: 'm2m-id', client_secret: 'm2m-SECRET', audience: 'https://nimbus.us.auth0.example/api/v2/' });
    t = (86400 - 59) * 1000;
    await auth0.getUser();
    expect(tokenCalls()).toHaveLength(2);
  });
  it('drops the cached token on 401 and retries once', async () => {
    let n = 0;
    const { auth0, calls } = adapter(routes({ 'users-by-email': () => (++n === 1 ? jsonResponse({}, 401) : jsonResponse([USER])) }));
    expect(await auth0.getUser()).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.url.endsWith('/oauth/token'))).toHaveLength(2);
    const always = adapter(routes({ 'users-by-email': () => jsonResponse({}, 401) }));
    expect(await always.auth0.getUser()).toEqual({ ok: false, error: { kind: 'unauthorized', status: 401 } });
    expect(always.calls.filter((c) => c.url.includes('users-by-email'))).toHaveLength(2);
  });
  it('reports a token failure', async () => {
    const { auth0 } = adapter(routes({ '/oauth/token': () => jsonResponse({ error: 'access_denied' }, 401) }));
    expect(await auth0.getUser()).toEqual({ ok: false, error: { kind: 'unauthorized', status: 401, code: 'access_denied' } });
    const bad = adapter(routes({ '/oauth/token': () => jsonResponse({ nope: true }) }));
    expect(await bad.auth0.getUser()).toEqual({ ok: false, error: { kind: 'bad_response' } });
  });
});

describe('Auth0 user', () => {
  it('finds the database user by email with a bearer token', async () => {
    const { auth0, calls } = adapter(routes());
    expect(await auth0.getUser()).toEqual({
      ok: true,
      value: { userId: 'auth0|priya', email: CFG.email, locked: false, lastPasswordReset: Date.parse(USER.last_password_reset), factors: ['email', 'otp'], factorsKnown: true },
    });
    const lookup = calls[1];
    expect(lookup.url).toBe('https://nimbus.us.auth0.example/api/v2/users-by-email?email=priya.sharma%40nimbuslabs.example');
    expect(lookup.init.method).toBe('GET');
    expect(headerOf(lookup.init, 'authorization')).toBe('Bearer mgmt-TOKEN-1');
    expect(calls[2].url).toBe('https://nimbus.us.auth0.example/api/v2/user-blocks/auth0%7Cpriya');
    expect(calls[3].url).toBe('https://nimbus.us.auth0.example/api/v2/users/auth0%7Cpriya/authentication-methods');
  });
  it('is locked when blocked or when brute-force blocks exist', async () => {
    const blocked = adapter(routes({ 'users-by-email': () => jsonResponse([{ ...USER, blocked: true }]) }));
    expect(await blocked.auth0.getUser()).toMatchObject({ ok: true, value: { locked: true } });
    const brute = adapter(routes({ 'user-blocks': () => jsonResponse({ blocked_for: [{ identifier: CFG.email, ip: '10.0.0.1' }] }) }));
    expect(await brute.auth0.getUser()).toMatchObject({ ok: true, value: { locked: true } });
  });
  it.each([403, 404])('treats MFA methods as unknown, not none, on %i', async (status) => {
    const { auth0 } = adapter(routes({ 'authentication-methods': () => jsonResponse({ statusCode: status, error: 'Forbidden' }, status) }));
    expect(await auth0.getUser()).toMatchObject({ ok: true, value: { factors: [], factorsKnown: false } });
  });
  it('fails when MFA methods are unavailable for other reasons', async () => {
    const { auth0 } = adapter(routes({ 'authentication-methods': () => jsonResponse({}, 503) }));
    expect(await auth0.getUser()).toEqual({ ok: false, error: { kind: 'unavailable', status: 503 } });
  });
  it('reports no database user as not found', async () => {
    const { auth0 } = adapter(routes({ 'users-by-email': () => jsonResponse([OTHER]) }));
    expect(await auth0.getUser()).toEqual({ ok: false, error: { kind: 'not_found' } });
    expect(await adapter(routes({ 'users-by-email': () => jsonResponse([]) })).auth0.getUser()).toEqual({ ok: false, error: { kind: 'not_found' } });
  });
});

describe('Auth0 email codes', () => {
  it('starts a passwordless email code', async () => {
    const { auth0, calls } = adapter(routes({ '/passwordless/start': () => jsonResponse({ _id: 'x', email: CFG.email, email_verified: true }) }));
    expect(await auth0.sendCode()).toEqual({ ok: true, value: null });
    expect(calls[0].url).toBe('https://nimbus.us.auth0.example/passwordless/start');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].body).toEqual({ client_id: 'otp-id', client_secret: 'otp-SECRET', connection: 'email', email: CFG.email, send: 'code' });
  });
  it('checks a code with the passwordless OTP grant and keeps no tokens', async () => {
    const { auth0, calls } = adapter(() => jsonResponse({ access_token: 'user-TOKEN', id_token: 'id-TOKEN', expires_in: 86400 }));
    const out = await auth0.verifyCode('421987');
    expect(out).toEqual({ ok: true, value: true });
    expect(JSON.stringify(out)).not.toMatch(/TOKEN/);
    expect(calls[0].url).toBe('https://nimbus.us.auth0.example/oauth/token');
    expect(calls[0].body).toEqual({
      grant_type: 'http://auth0.com/oauth/grant-type/passwordless/otp',
      client_id: 'otp-id',
      client_secret: 'otp-SECRET',
      username: CFG.email,
      otp: '421987',
      realm: 'email',
      scope: 'openid',
    });
  });
  it('treats invalid_grant as a wrong or expired code', async () => {
    const { auth0 } = adapter(() => jsonResponse({ error: 'invalid_grant', error_description: 'Wrong email or verification code.' }, 403));
    expect(await auth0.verifyCode('000000')).toEqual({ ok: true, value: false });
  });
  it('counts a right code for a blocked user as verified, since Auth0 checks the code first', async () => {
    const { auth0 } = adapter(() => jsonResponse({ error: 'unauthorized', error_description: 'user is blocked' }, 401));
    expect(await auth0.verifyCode('421987')).toEqual({ ok: true, value: true });
    const other = adapter(() => jsonResponse({ error: 'unauthorized', error_description: 'Unauthorized' }, 401)).auth0;
    expect(await other.verifyCode('421987')).toEqual({ ok: false, error: { kind: 'unauthorized', status: 401 } });
  });
  it('reports other OTP failures as errors', async () => {
    const { auth0 } = adapter(() => jsonResponse({ error: 'unauthorized_client' }, 403));
    expect(await auth0.verifyCode('421987')).toEqual({ ok: false, error: { kind: 'unauthorized', status: 403, code: 'unauthorized_client' } });
  });
});

describe('Auth0 account actions', () => {
  const who = { userId: 'auth0|priya', email: CFG.email };
  it('unlocks by clearing blocked and brute-force blocks', async () => {
    const { auth0, calls } = adapter(routes({ 'DELETE https://nimbus.us.auth0.example/api/v2/user-blocks': () => new Response(null, { status: 204 }) }));
    expect(await auth0.lifecycle(who, 'unlock')).toEqual({ ok: true, value: null });
    const [, patch, del] = calls;
    expect(patch).toMatchObject({ url: 'https://nimbus.us.auth0.example/api/v2/users/auth0%7Cpriya', body: { blocked: false } });
    expect(patch.init.method).toBe('PATCH');
    expect(del.url).toBe('https://nimbus.us.auth0.example/api/v2/user-blocks/auth0%7Cpriya');
    expect(del.init.method).toBe('DELETE');
  });
  it('sends a reset email and accepts the plain-text answer', async () => {
    const { auth0, calls } = adapter(() => new Response("We've just sent you an email to reset your password.", { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await auth0.lifecycle(who, 'resetPassword')).toEqual({ ok: true, value: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://nimbus.us.auth0.example/dbconnections/change_password');
    expect(calls[0].body).toEqual({ client_id: 'm2m-id', email: CFG.email, connection: 'Username-Password-Authentication' });
  });
  it('resets MFA by deleting authenticators', async () => {
    const { auth0, calls } = adapter(routes({ 'DELETE': () => new Response(null, { status: 204 }) }));
    expect(await auth0.lifecycle(who, 'resetMfa')).toEqual({ ok: true, value: null });
    expect(calls[1].url).toBe('https://nimbus.us.auth0.example/api/v2/users/auth0%7Cpriya/authenticators');
    expect(calls[1].init.method).toBe('DELETE');
  });
  it('handles 5xx, timeouts, malformed JSON and network errors without leaking secrets', async () => {
    const outs = [
      await adapter(routes({ 'PATCH': () => jsonResponse({}, 503) })).auth0.lifecycle(who, 'unlock'),
      await new Auth0Identity(CFG, { fetch: hangingFetch() }, new Map(), 30).getUser(),
      await adapter(routes({ 'users-by-email': () => new Response('<html>', { status: 200 }) })).auth0.getUser(),
      await adapter(() => {
        throw new TypeError(`connect ECONNREFUSED ${CFG.domain} ${CFG.clientSecret} ${CFG.otpClientSecret}`);
      }).auth0.verifyCode('421987'),
    ];
    expect(outs).toEqual([
      { ok: false, error: { kind: 'unavailable', status: 503 } },
      { ok: false, error: { kind: 'timeout' } },
      { ok: false, error: { kind: 'bad_response' } },
      { ok: false, error: { kind: 'network' } },
    ]);
    expect(JSON.stringify(outs)).not.toMatch(/SECRET|TOKEN|auth0\.example|421987/);
  });
});

describe('Auth0 lockdown calls', () => {
  const id = 'auth0|abc';
  const noContent = () => new Response(null, { status: 204 });
  it('blocks the user with a PATCH', async () => {
    const { auth0, calls } = adapter(routes({ PATCH: () => jsonResponse({ user_id: id, blocked: true }) }));
    expect(await auth0.block(id)).toEqual({ ok: true, value: null });
    expect(calls[1]).toMatchObject({ url: 'https://nimbus.us.auth0.example/api/v2/users/auth0%7Cabc', body: { blocked: true } });
    expect(calls[1].init.method).toBe('PATCH');
    expect(headerOf(calls[1].init, 'authorization')).toBe('Bearer mgmt-TOKEN-1');
  });
  it('deletes all sessions and refresh tokens with URL-encoded ids', async () => {
    const { auth0, calls } = adapter(routes({ DELETE: noContent }));
    expect(await auth0.endSessions(id)).toEqual({ ok: true, value: null });
    expect(await auth0.revokeRefreshTokens(id)).toEqual({ ok: true, value: null });
    const deletes = calls.filter((c) => c.init.method === 'DELETE');
    expect(deletes.map((c) => c.url)).toEqual([
      'https://nimbus.us.auth0.example/api/v2/users/auth0%7Cabc/sessions',
      'https://nimbus.us.auth0.example/api/v2/users/auth0%7Cabc/refresh-tokens',
    ]);
    expect(deletes.every((c) => c.body === undefined)).toBe(true);
  });
  it('encodes ids that contain slashes or query characters', async () => {
    const { auth0, calls } = adapter(routes({ DELETE: noContent }));
    await auth0.endSessions('samlp|corp/priya?x=1#y');
    expect(calls[1].url).toBe('https://nimbus.us.auth0.example/api/v2/users/samlp%7Ccorp%2Fpriya%3Fx%3D1%23y/sessions');
  });
  it('counts nothing to delete as success', async () => {
    const { auth0 } = adapter(routes({ DELETE: () => jsonResponse({ statusCode: 404, error: 'Not Found' }, 404) }));
    expect(await auth0.endSessions(id)).toEqual({ ok: true, value: null });
    expect(await auth0.revokeRefreshTokens(id)).toEqual({ ok: true, value: null });
  });
  it('reports a missing user on block, rate limits, 5xx and refused scopes as failures', async () => {
    expect(await adapter(routes({ PATCH: () => jsonResponse({}, 404) })).auth0.block(id)).toEqual({ ok: false, error: { kind: 'not_found', status: 404 } });
    const limited = adapter(routes({ DELETE: () => new Response('{}', { status: 429, headers: { 'retry-after': '3' } }) }));
    expect(await limited.auth0.endSessions(id)).toEqual({ ok: false, error: { kind: 'unavailable', status: 429, retryAfter: 3 } });
    expect(await adapter(routes({ DELETE: () => jsonResponse({}, 502) })).auth0.revokeRefreshTokens(id)).toEqual({ ok: false, error: { kind: 'unavailable', status: 502 } });
    expect(await adapter(routes({ DELETE: () => jsonResponse({ error: 'insufficient_scope' }, 403) })).auth0.endSessions(id)).toEqual({ ok: false, error: { kind: 'unauthorized', status: 403, code: 'insufficient_scope' } });
  });
  it('refreshes an expired token and retries once on 401', async () => {
    let t = 0;
    let n = 0;
    const { auth0, calls } = adapter(routes({ DELETE: () => (++n === 2 ? jsonResponse({}, 401) : noContent()) }), () => t);
    await auth0.endSessions(id);
    t = 86400 * 1000;
    expect(await auth0.revokeRefreshTokens(id)).toEqual({ ok: true, value: null });
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://nimbus.us.auth0.example', '')}`)).toEqual([
      'POST /oauth/token',
      'DELETE /api/v2/users/auth0%7Cabc/sessions',
      'POST /oauth/token',
      'DELETE /api/v2/users/auth0%7Cabc/refresh-tokens',
      'POST /oauth/token',
      'DELETE /api/v2/users/auth0%7Cabc/refresh-tokens',
    ]);
  });
  it('times out without throwing', async () => {
    const auth0 = new Auth0Identity(CFG, { fetch: hangingFetch() }, new Map(), 30);
    expect(await auth0.block(id)).toEqual({ ok: false, error: { kind: 'timeout' } });
  });
});
