type FailureKind = 'timeout' | 'network' | 'unauthorized' | 'not_found' | 'rejected' | 'unavailable' | 'bad_response';

export interface Failure {
  kind: FailureKind;
  status?: number;
  // OAuth-style error code from the body, such as invalid_grant.
  code?: string;
  // Seconds to wait after a 429.
  retryAfter?: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };

export interface Http {
  fetch: typeof fetch;
  // Epoch ms after which no request may still be running.
  deadline?: number;
  now?: () => number;
}

export const success = <T>(value: T): Result<T> => ({ ok: true, value });
export const failure = <T = never>(error: Failure): Result<T> => ({ ok: false, error });

function kindOf(status: number): FailureKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'rejected';
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Only snake_case codes like invalid_grant are kept; free text could carry secrets.
function errorCode(body: unknown): string | undefined {
  const b = body as { error?: unknown; error_description?: unknown } | undefined;
  // Auth0's blocked-user reply is plain "unauthorized"; it gets a code of its own.
  if (b?.error === 'unauthorized' && b.error_description === 'user is blocked') return 'user_blocked';
  return typeof b?.error === 'string' && /^[a-z]+(_[a-z]+)+$/.test(b.error) ? b.error : undefined;
}

// A 403 carrying a ServiceNow error object is a business rule (data policy, ACL on a field), not bad credentials.
function businessError(body: unknown): boolean {
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === 'object' && error !== null && ('detail' in error || 'message' in error);
}

// One outbound call returning the raw body: timeout via AbortController, typed failures, never throws.
export async function requestText(http: Http, url: string, init: RequestInit, capMs: number): Promise<Result<string>> {
  const now = http.now ?? Date.now;
  const timeoutMs = Math.min(capMs, http.deadline === undefined ? capMs : http.deadline - now());
  if (timeoutMs <= 0) return failure({ kind: 'timeout' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await http.fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
    const text = await res.text();
    if (res.ok) return success(text);
    const body = parse(text);
    const code = errorCode(body);
    const kind = res.status === 403 && businessError(body) ? 'rejected' : kindOf(res.status);
    const header = res.status === 429 ? res.headers.get('retry-after') : null;
    const retryAfter = header ? Number(header) : NaN;
    return failure({ kind, status: res.status, ...(code ? { code } : {}), ...(retryAfter >= 0 ? { retryAfter } : {}) });
  } catch {
    return failure({ kind: controller.signal.aborted ? 'timeout' : 'network' });
  } finally {
    clearTimeout(timer);
  }
}

export async function requestJson(http: Http, url: string, init: RequestInit, capMs: number): Promise<Result<unknown>> {
  const res = await requestText(http, url, init, capMs);
  if (!res.ok) return res;
  if (!res.value.trim()) return success(null);
  try {
    return success(JSON.parse(res.value) as unknown);
  } catch {
    return failure({ kind: 'bad_response' });
  }
}

// Spoken explanation of a failure: no URLs, credentials, status codes or brackets.
export function describeFailure(system: string, error: Failure): string {
  switch (error.kind) {
    case 'timeout':
      return `${system} did not answer in time.`;
    case 'network':
      return `${system} could not be reached.`;
    case 'unauthorized':
      return `${system} refused our credentials.`;
    case 'not_found':
      return `${system} could not find that record.`;
    case 'rejected':
      return `${system} rejected the request.`;
    case 'unavailable':
      return `${system} is having problems right now.`;
    case 'bad_response':
      return `${system} sent an unexpected response.`;
  }
}
