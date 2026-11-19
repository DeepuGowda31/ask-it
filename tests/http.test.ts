import { describe, expect, it } from 'vitest';
import { describeFailure, requestJson, requestText } from '@/lib/integrations/http';
import { fakeFetch, hangingFetch, jsonResponse } from './fakes';

describe('requestJson', () => {
  it('returns parsed JSON on 2xx', async () => {
    const f = fakeFetch(() => jsonResponse({ a: 1 }));
    const out = await requestJson({ fetch: f.fetch }, 'https://x.example/api', { method: 'GET' }, 1000);
    expect(out).toEqual({ ok: true, value: { a: 1 } });
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
  it('treats an empty 2xx body as null', async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }));
    expect(await requestJson({ fetch: f.fetch }, 'https://x.example', {}, 1000)).toEqual({ ok: true, value: null });
  });
  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not_found'],
    [400, 'rejected'],
    [429, 'unavailable'],
    [503, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const f = fakeFetch(() => jsonResponse({ error: 'x' }, status));
    expect(await requestJson({ fetch: f.fetch }, 'https://x.example', {}, 1000)).toEqual({ ok: false, error: { kind, status } });
  });
  it('keeps a safe OAuth error code from the body', async () => {
    const f = fakeFetch(() => jsonResponse({ error: 'invalid_grant', error_description: 'Wrong email or verification code.' }, 403));
    expect(await requestJson({ fetch: f.fetch }, 'https://x.example', {}, 1000)).toEqual({ ok: false, error: { kind: 'unauthorized', status: 403, code: 'invalid_grant' } });
    const odd = fakeFetch(() => jsonResponse({ error: 'token abc.def leaked' }, 400));
    expect(await requestJson({ fetch: odd.fetch }, 'https://x.example', {}, 1000)).toEqual({ ok: false, error: { kind: 'rejected', status: 400 } });
  });
  it('treats a 403 with a ServiceNow business error as rejected, not credentials', async () => {
    const body = { error: { message: 'Operation Failed', detail: 'Data Policy Exception: the following fields are mandatory: Resolution code' }, status: 'failure' };
    const f = fakeFetch(() => jsonResponse(body, 403));
    expect(await requestJson({ fetch: f.fetch }, 'https://x.example', {}, 1000)).toEqual({ ok: false, error: { kind: 'rejected', status: 403 } });
  });
  it('returns plain text bodies with requestText', async () => {
    const f = fakeFetch(() => new Response("We've just sent you an email to reset your password.", { status: 200 }));
    expect(await requestText({ fetch: f.fetch }, 'https://x.example', {}, 1000)).toEqual({ ok: true, value: "We've just sent you an email to reset your password." });
  });
  it('keeps Retry-After on a 429', async () => {
    const f = fakeFetch(() => new Response('{}', { status: 429, headers: { 'retry-after': '3' } }));
    expect(await requestJson({ fetch: f.fetch }, 'https://x.example', {}, 1000)).toEqual({ ok: false, error: { kind: 'unavailable', status: 429, retryAfter: 3 } });
  });
  it('reports malformed JSON', async () => {
    const f = fakeFetch(() => new Response('<html>', { status: 200 }));
    expect(await requestJson({ fetch: f.fetch }, 'https://x.example', {}, 1000)).toEqual({ ok: false, error: { kind: 'bad_response' } });
  });
  it('reports network errors', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await requestJson({ fetch: f.fetch }, 'https://x.example', {}, 1000)).toEqual({ ok: false, error: { kind: 'network' } });
  });
  it('aborts after the timeout', async () => {
    const out = await requestJson({ fetch: hangingFetch() }, 'https://x.example', {}, 30);
    expect(out).toEqual({ ok: false, error: { kind: 'timeout' } });
  });
  it('never waits past the shared deadline', async () => {
    let t = 1000;
    const f = fakeFetch(() => jsonResponse({}));
    const out = await requestJson({ fetch: f.fetch, deadline: 1000, now: () => t }, 'https://x.example', {}, 5000);
    expect(out).toEqual({ ok: false, error: { kind: 'timeout' } });
    expect(f.calls).toHaveLength(0);
    t = 0;
    const started = Date.now();
    const slow = await requestJson({ fetch: hangingFetch(), deadline: 40, now: () => t }, 'https://x.example', {}, 5000);
    expect(slow).toEqual({ ok: false, error: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('describeFailure', () => {
  it('names the system and the problem without URLs, status codes or brackets', () => {
    const all = [
      describeFailure('ServiceNow', { kind: 'timeout' }),
      describeFailure('Okta', { kind: 'unavailable', status: 503 }),
      describeFailure('Auth0', { kind: 'unauthorized', status: 401 }),
      describeFailure('ServiceNow', { kind: 'network' }),
      describeFailure('ServiceNow', { kind: 'bad_response' }),
      describeFailure('ServiceNow', { kind: 'not_found', status: 404 }),
      describeFailure('ServiceNow', { kind: 'rejected', status: 403 }),
    ];
    expect(all).toEqual([
      'ServiceNow did not answer in time.',
      'Okta is having problems right now.',
      'Auth0 refused our credentials.',
      'ServiceNow could not be reached.',
      'ServiceNow sent an unexpected response.',
      'ServiceNow could not find that record.',
      'ServiceNow rejected the request.',
    ]);
    expect(all.join(' ')).not.toMatch(/HTTP|\d{3}|[()[\]]/);
  });
});
