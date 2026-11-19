import { NextRequest, NextResponse } from 'next/server';
import { buildSessionView } from '@/lib/domain/view';
import { buildItDeskView } from '@/lib/domain/itdesk-view';
import { integrationModes } from '@/lib/server/deps';
import { getStore } from '@/lib/server/store';
import { isValidSessionCode, loadSession, normalizeSessionCode } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

// "priya.sharma@x.com" -> "p***@x.com", keeping a +tag: "demo+priya@gmail.com" -> "d***+priya@gmail.com".
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const tag = local.includes('+') ? local.slice(local.indexOf('+')) : '';
  return `${local.charAt(0)}***${tag}@${domain}`;
}

// Polled about once a second by both screens. The ETag is the store version, so unchanged polls are a cheap 304.
export async function GET(request: NextRequest) {
  const code = normalizeSessionCode(request.nextUrl.searchParams.get('session'));
  if (!isValidSessionCode(code)) return NextResponse.json({ error: 'invalid_session_code' }, { status: 400 });
  try {
    const hit = await loadSession(getStore(), code);
    if (!hit) return NextResponse.json({ error: 'session_not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const etag = `"v${hit.version}"`;
    if (request.headers.get('if-none-match') === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-store' } });
    }
    const now = Date.now();
    const view = buildSessionView(hit.state, now, hit.version, integrationModes());
    const masked = {
      ...view,
      employee: { ...view.employee, email: maskEmail(view.employee.email) },
      account: { ...view.account, email: maskEmail(view.account.email) },
      itdesk: buildItDeskView(hit.state, now),
    };
    return NextResponse.json(masked, {
      headers: { ETag: etag, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Failed to load session state:', error);
    return NextResponse.json({ error: 'state_unavailable' }, { status: 503 });
  }
}
