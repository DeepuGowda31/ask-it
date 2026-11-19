interface FakeCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Records every request and answers with the handler's response.
export function fakeFetch(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    return handler(url, init, calls.length);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

// Never answers; rejects only when aborted.
export const hangingFetch = () =>
  ((_input: RequestInfo | URL, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as typeof fetch;

export const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);
