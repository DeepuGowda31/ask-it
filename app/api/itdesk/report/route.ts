import { NextRequest, NextResponse, after } from 'next/server';
import { speakWhenIdle } from '@/lib/agent/agent';
import { claimReport, finishReport, reportFailedLine, reportFilename, reportReadyLine } from '@/lib/domain/report';
import type { SessionState } from '@/lib/domain/types';
import { buildDeps } from '@/lib/server/deps';
import { buildReport } from '@/lib/server/report';
import { getStore } from '@/lib/server/store';
import { SessionNotFoundError, isValidSessionCode, normalizeSessionCode, updateSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';
// Reads and drawing take a few seconds; this leaves room for a slow ServiceNow.
export const maxDuration = 30;

const NO_STORE = { 'Cache-Control': 'no-store' };
const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });
const ID = /^[A-Za-z0-9-]{1,80}$/;

// After the response when there is one; outside a request it runs at once.
function later(task: () => Promise<void>) {
  const run = () => task().catch(() => console.error('Report line could not be said'));
  try {
    after(run);
  } catch {
    void run();
  }
}

// The IT page asks for the report the agent recorded: built once from the desk, downloaded as a PDF. The agent says once that it is ready, or that it failed.
export async function POST(request: NextRequest) {
  let body: { session?: unknown; id?: unknown };
  try {
    body = JSON.parse(await request.text());
  } catch {
    return reply({ error: 'Invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object') return reply({ error: 'Invalid JSON body' }, 400);
  const code = normalizeSessionCode(typeof body.session === 'string' ? body.session : '');
  if (!isValidSessionCode(code)) return reply({ error: 'session is required' }, 400);
  if (typeof body.id !== 'string' || !ID.test(body.id)) return reply({ error: 'id is required' }, 400);
  const id = body.id;

  const store = getStore();
  const now = Date.now();
  let claim: ReturnType<typeof claimReport>;
  try {
    claim = await updateSession(store, code, (s) => claimReport(s, id, now));
  } catch (error) {
    if (error instanceof SessionNotFoundError) return reply({ error: 'session_not_found' }, 404);
    return reply({ error: 'Session busy, try again.' }, 503);
  }
  if (claim.outcome === 'stale' || !claim.report) return reply({ error: 'stale_report' }, 409);
  if (claim.outcome === 'failed') return reply({ error: 'report_failed' }, 409);
  if (claim.outcome === 'busy') return reply({ error: 'in_progress' }, 409);

  const { period } = claim.report;
  const desk = buildDeps(claim.state, now).desk;
  const built = await buildReport(desk, period, now);
  const filename = reportFilename(period, now);

  // The first build of a pending report records how it went and has the agent say it, once.
  if (claim.outcome === 'build') {
    let agentId: string | null = null;
    try {
      ({ agentId } = await updateSession(store, code, (s: SessionState) => finishReport(s, id, built.ok ? 'ready' : 'failed', Date.now(), filename)));
    } catch {
      agentId = null;
    }
    const line = built.ok ? reportReadyLine(period) : reportFailedLine(period, desk.mode === 'live' && built.why === 'read');
    const speaker = agentId;
    if (speaker) later(() => speakWhenIdle(speaker, line));
  }

  if (!built.ok) return reply({ error: 'report_unavailable' }, 502);
  return new NextResponse(new Blob([built.pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), {
    status: 200,
    headers: {
      ...NO_STORE,
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
