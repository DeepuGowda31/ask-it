// Ticket numbers in agent speech: "I-N-C one zero zero one three" reads as INC0010013, and spoken lists become one line per ticket.

export interface TicketInfo {
  summary: string;
  status: string;
}

interface TicketLine {
  number: string;
  summary: string;
  status: string | null;
}

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
// Group 1: written digits; group 2: spoken digit words. Uppercase only, so "Inc." never matches.
const TICKET = new RegExp(`\\bI[- ]?N[- ]?C(?:[- ]?(\\d{4,7})\\b|((?:[\\s-]+(?:${DIGITS.join('|')})\\b)+))`, 'g');
const ORDINAL = /[\s,;:.-]*(?:\b(?:and|then)\b)?[\s,;:.-]*\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|next|finally|lastly)\b[\s,;:.-]*$/i;
const SENTENCE_END = /[.!?]\s+(?=[A-Z])/;

interface Mention {
  number: string;
  start: number;
  end: number;
}

function mentions(text: string): Mention[] {
  return [...text.matchAll(TICKET)].flatMap((m) => {
    const digits = m[1] ?? m[2].trim().split(/[\s-]+/).map((w) => DIGITS.indexOf(w)).join('');
    return digits.length <= 7 ? [{ number: `INC${digits.padStart(7, '0')}`, start: m.index, end: m.index + m[0].length }] : [];
  });
}

export function displayTicketNumbers(text: string): string {
  let out = '';
  let at = 0;
  for (const m of mentions(text)) {
    out += text.slice(at, m.start) + m.number;
    at = m.end;
  }
  return out + text.slice(at);
}

const trimTail = (s: string) => s.replace(ORDINAL, '').replace(/[\s,;:.-]+$/, '');
const trimHead = (s: string) => s.replace(/^[\s,;:.-]+/, '').replace(/^(?:for the|for)\s+/i, '');

// A message that reads out tickets, split into intro, one line per ticket and what follows; null for anything else.
export function ticketList(text: string, catalog: ReadonlyMap<string, TicketInfo>): { intro: string; items: TicketLine[]; outro: string } | null {
  const all = mentions(text);
  if (!all.length) return null;
  const before = text.slice(0, all[0].start).trim();
  const distinct = new Set(all.map((m) => m.number));
  if (distinct.size === 1 && !before.endsWith(':')) return null;

  const last = text.slice(all.at(-1)!.end);
  const cut = last.search(SENTENCE_END);
  const outro = cut >= 0 ? last.slice(cut + 1).trim() : '';
  const seen = new Set<string>();
  const items: TicketLine[] = [];
  all.forEach((m, i) => {
    if (seen.has(m.number)) return;
    seen.add(m.number);
    const known = catalog.get(m.number);
    if (known) return void items.push({ number: m.number, summary: known.summary, status: known.status });
    const raw = i + 1 < all.length ? text.slice(m.end, all[i + 1].start) : cut >= 0 ? last.slice(0, cut) : last;
    items.push({ number: m.number, summary: trimTail(trimHead(raw)), status: null });
  });
  const intro = trimTail(before);
  return { intro: intro ? `${intro}:` : '', items, outro };
}

// Open work reads as active, on hold as waiting, an outage as bad; closed states stay quiet.
export function statusTone(status: string | null): 'info' | 'warn' | 'bad' | undefined {
  const s = status?.toLowerCase() ?? '';
  if (s === 'outage') return 'bad';
  if (s.includes('hold')) return 'warn';
  return s === 'new' || s.includes('progress') ? 'info' : undefined;
}

// Server and voice clocks differ a little, so a turn just before the list still counts as its answer.
const LIST_DRIFT_MS = 3000;

// The ASK IT turn that answers a ticket list asked for in this call: the first one after it; without turn times, the newest.
export function listTurnId(messages: { id: string; role: 'agent' | 'user'; createdAt?: number }[], listAt: number, callStart: number | null): string | null {
  if (callStart !== null && listAt < callStart) return null;
  const agent = messages.filter((m) => m.role === 'agent');
  if (agent.some((m) => m.createdAt === undefined)) return agent.at(-1)?.id ?? null;
  return agent.find((m) => m.createdAt! >= listAt - LIST_DRIFT_MS)?.id ?? null;
}
