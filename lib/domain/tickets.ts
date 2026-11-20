import { assetMarker, findAsset } from './assets';
import { deviceLabel } from './company';
import { findArticle } from './kb';
import { SERVICES, mentionsService } from './services';
import { formatTime } from './time';
import type { Mode, RemoteTicket } from '@/lib/integrations/types';
import type { SessionState, TicketRecord, Troubleshooting } from './types';

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const WORD_DIGIT: Record<string, string> = { ...Object.fromEntries(WORDS.map((w, i) => [w, String(i)])), oh: '0' };

// Digits in spoken or typed text: "four two 1-9 8 7" -> "421987".
export const spokenDigits = (raw: string) =>
  raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => WORD_DIGIT[w] ?? w)
    .join('')
    .replace(/\D/g, '');

// "I N C 12001", "ticket 12001" or "INC0012001" -> "INC0012001".
export function parseTicketNumber(raw: string): string | null {
  const digits = spokenDigits(raw);
  return digits && digits.length <= 7 ? `INC${digits.padStart(7, '0')}` : null;
}

// Shortens free text for titles, keeping whole text elsewhere.
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// The caller's own words read back: no brackets, and never more than a short phrase.
export const echo = (text: string, max = 60) => clip(text.replace(/[()[\]{}]/g, '').replace(/\s+/g, ' ').trim(), max);

const sayDigits = (digits: string) => [...digits].map((d) => WORDS[Number(d)]).join(' ');

// "INC0012001" -> "I-N-C one two zero zero one", so the agent never misreads it.
export function spokenTicket(number: string): string {
  const local = number.match(/^LOCAL-(\d+)$/);
  if (local) return `local reference ${sayDigits(local[1])}`;
  const m = number.match(/^([A-Z]+)0*(\d+)$/);
  return m ? `${m[1].split('').join('-')} ${sayDigits(m[2])}` : number;
}

export const isOpen = (t: TicketRecord) => !/resolved|closed|cancel/i.test(t.state);

// A fix made on a call is logged with this correlation id; older ones were titled with the legacy prefix instead.
const FIX_ID = /^askit:[^:]+:fix\w+$/;
export const LEGACY_FIX_PREFIX = 'Resolved by ASK IT: ';
export const fixCorrelationId = (session: string, ref: string | number) => `askit:${session}:fix${ref}`;
const isFixRecord = (r: { correlationId?: string; summary: string }) => Boolean(r.correlationId && FIX_ID.test(r.correlationId)) || r.summary.startsWith(LEGACY_FIX_PREFIX);
export const isAskItFix = (t: TicketRecord) => t.fixedOnCall === true;

// Titles and notes ASK IT writes carry no colons, semicolons or spaced dashes.
export const plainText = (text: string) => text.replace(/\s*[:;]\s*/g, ', ').replace(/\s+[-–—]+\s+/g, ', ').replace(/\s+/g, ' ').trim();

// Short names for the internal services; the others go by their own name.
const SHORT_NAME: Record<string, string> = { vpn: 'VPN', wifi: 'Wi-Fi', outlook: 'Outlook', concur: 'Concur', printers: 'printer' };
const NAME_WORDS = 6;

// A ticket as said aloud, by the service its title names, else its first words: "your VPN ticket".
export function ticketPhrase(summary: string): string {
  const title = summary.replace(LEGACY_FIX_PREFIX, '');
  const service = SERVICES.find((s) => mentionsService(title, s.key));
  if (service) return `your ${SHORT_NAME[service.key] ?? service.name.replace(/^the /, '')} ticket`;
  const words = plainText(echo(title, 200)).replace(/,/g, '').split(' ').slice(0, NAME_WORDS).join(' ');
  // "Laptop fan" reads as "laptop fan", but "VPN" and "SSO" keep their capitals.
  return `your ticket about ${/^[A-Z][a-z]/.test(words) ? words.charAt(0).toLowerCase() + words.slice(1) : words}`;
}

const LATEST = /^(|last|latest|recent|newest|my ticket|that ticket|it|the ticket)$/;

export function findTicket(state: SessionState, raw: string): TicketRecord | undefined {
  const q = raw.trim().toLowerCase();
  if (LATEST.test(q)) return state.tickets.find(isOpen) ?? state.tickets[0];
  if (q.includes('local')) return state.tickets.find((t) => t.number === `LOCAL-${spokenDigits(q)}`);
  const number = parseTicketNumber(q);
  return number ? state.tickets.find((t) => t.number === number) : undefined;
}

export function nextSimNumber(state: SessionState): string {
  const used = state.tickets.filter((t) => t.source === 'simulated' && /^INC\d{7}$/.test(t.number)).map((t) => Number(t.number.slice(3)));
  return `INC${String(Math.max(12000, ...used) + 1).padStart(7, '0')}`;
}

// Newest first, as ServiceNow lists them.
export function addTicket(state: SessionState, ticket: TicketRecord) {
  state.tickets = [ticket, ...state.tickets.filter((t) => t.number !== ticket.number)];
}

// Applies a fresh ServiceNow list to the mirror; local-only and unsynced records are kept. A state change on a known ticket is stamped.
export function mergeRemote(state: SessionState, remote: RemoteTicket[], source: Mode, now: number) {
  // A live list is the truth: a ticket ServiceNow no longer returns goes; a record never saved there stays for its retry.
  const listed = new Set(remote.map((r) => r.number));
  const kept = source === 'live' ? state.tickets.filter((t) => !t.sysId || listed.has(t.number)) : state.tickets;
  const byNumber = new Map(kept.map((t) => [t.number, t]));
  for (const r of remote) {
    const old = byNumber.get(r.number);
    const moved = old?.sysId && old.state !== r.state ? { changedAt: now } : {};
    byNumber.set(r.number, {
      ...old,
      ...moved,
      number: r.number,
      sysId: r.sysId,
      summary: r.summary,
      state: r.state,
      urgency: r.urgency,
      source,
      createdAt: r.createdAt ?? old?.createdAt ?? now,
      updatedAt: r.updatedAt ?? now,
      ...(r.resolvedAt === undefined ? {} : { resolvedAt: r.resolvedAt }),
      ...(isFixRecord(r) ? { fixedOnCall: true as const } : {}),
    });
  }
  state.tickets = [...byNumber.values()].sort((a, b) => b.createdAt - a.createdAt);
}

const OUTCOME_TEXT = { fixed: 'fixed it', not_fixed: 'not fixed', done: 'done', skipped: 'skipped' };

// Ticket body: what is wrong, the device, any scanned device, the verification state and every step tried.
export function ticketDescription(state: SessionState, t: Troubleshooting | null, details: string, now: number): string {
  const { employee: e, verification: v } = state;
  const verified = v.status === 'approved' && v.approvedAt !== null && v.expiresAt !== null && now <= v.expiresAt;
  const lines = [
    `Reported by ${e.name} (${e.email}) through the ASK IT voice helpdesk.`,
    `Device: ${deviceLabel(e)}. VPN client: ${e.vpnClient}.`,
    `Identity: ${verified ? `verified by email code at ${formatTime(v.approvedAt!)} IST` : 'not verified during this call'}.`,
  ];
  const asset = state.asset ? findAsset(state.asset.id) : undefined;
  if (asset) lines.push(`Location: ${asset.name}, ${asset.location}, reported from its QR sticker.`, assetMarker(asset.id));
  if (t) lines.push(`Issue: ${t.issue}`);
  if (details) lines.push(`Details: ${details}`);
  if (t) {
    const total = findArticle(t.articleId)?.steps.length ?? t.log.length;
    lines.push('', `Guided troubleshooting (${t.title}), ${t.log.length} of ${total} steps tried:`);
    lines.push(...t.log.map((l) => `${l.step}. ${l.text} Result: ${OUTCOME_TEXT[l.outcome]}.${l.note ? ` Note: ${l.note}` : ''}`));
    if (!t.log.length) lines.push('No steps were tried yet.');
  } else {
    lines.push('', 'No guided troubleshooting was done before this ticket.');
  }
  return lines.join('\n');
}
