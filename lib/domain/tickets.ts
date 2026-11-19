import { assetMarker, findAsset } from './assets';
import { deviceLabel } from './company';
import { findArticle } from './kb';
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

// Applies a fresh ServiceNow list to the mirror; local-only and unsynced records are kept.
export function mergeRemote(state: SessionState, remote: RemoteTicket[], source: Mode, now: number) {
  const byNumber = new Map(state.tickets.map((t) => [t.number, t]));
  for (const r of remote) {
    const old = byNumber.get(r.number);
    byNumber.set(r.number, {
      ...old,
      number: r.number,
      sysId: r.sysId,
      summary: r.summary,
      state: r.state,
      urgency: r.urgency,
      source,
      createdAt: r.createdAt ?? old?.createdAt ?? now,
      updatedAt: r.updatedAt ?? now,
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
