import { failure, success, type Http, type Result } from './http';
import { serviceNowRequest, type ServiceNowConfig } from './servicenow';
import type { Mode } from './types';

export interface KbArticle {
  number: string;
  title: string;
  summary: string;
}

// ServiceNow knowledge articles, the fallback when no local guide fits.
export interface KnowledgeSource {
  readonly mode: Mode;
  search(query: string): Promise<Result<KbArticle[]>>;
}

const MAX_ARTICLES = 2;
const SUMMARY_CHARS = 400;
const TIMEOUT_MS = 3000;
// Out-of-the-box instances ship template articles that say so in their title.
const DEMO = /demo (data|article)/i;
const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (row: Json, name: string) => (typeof row[name] === 'string' ? row[name] : '');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

// Only letters and digits reach the query, so it can never carry an operator.
const words = (query: string) => query.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
  });
}

function plain(html: string): string {
  const stripped = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ');
  // A closing inline tag such as </b> must not leave a gap before punctuation.
  return squash(decode(stripped)).replace(/ ([.,;:!?])/g, '$1');
}

function clip(s: string): string {
  if (s.length <= SUMMARY_CHARS) return s;
  const cut = s.slice(0, SUMMARY_CHARS);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:.]+$/, '')}…`;
}

function toArticle(row: unknown): KbArticle | null {
  if (!isRecord(row)) return null;
  const number = text(row, 'number');
  const title = squash(text(row, 'short_description'));
  if (!number || !title || DEMO.test(title)) return null;
  return { number, title, summary: clip(plain(text(row, 'text'))) };
}

export class ServiceNowKnowledge implements KnowledgeSource {
  readonly mode = 'live';

  constructor(
    private cfg: ServiceNowConfig,
    private http: Http,
    private timeoutMs = TIMEOUT_MS,
  ) {}

  async search(query: string): Promise<Result<KbArticle[]>> {
    const terms = words(query);
    if (!terms.length) return success([]);
    const params = new URLSearchParams({
      sysparm_query: `workflow_state=published^active=true^123TEXTQUERY321=${terms.join(' ')}`,
      sysparm_fields: 'number,short_description,text',
      sysparm_display_value: 'true',
      sysparm_limit: '10',
    });
    const res = await serviceNowRequest(this.cfg, this.http, 'GET', `/api/now/table/kb_knowledge?${params}`, undefined, this.timeoutMs);
    if (!res.ok) return res;
    const rows = isRecord(res.value) ? res.value.result : undefined;
    if (!Array.isArray(rows)) return failure({ kind: 'bad_response' });
    return success(rows.map(toArticle).filter((a): a is KbArticle => a !== null).slice(0, MAX_ARTICLES));
  }
}

const SIMULATED: KbArticle[] = [
  {
    number: 'KB0010001',
    title: 'Submit an expense report in SAP Concur',
    summary: 'Open SAP Concur from the company portal, choose Expense, then Create New Report. Add each receipt with a photo, check the cost centre, and click Submit Report. Your manager approves it, and the money arrives with the next salary run.',
  },
  {
    number: 'KB0010002',
    title: 'Set up an email signature in Outlook for Mac',
    summary: 'In Outlook, open Settings, then Signatures. Click the plus button, paste the company signature template from the brand page on the intranet, and set it as the default for new messages and replies.',
  },
  {
    number: 'KB0010003',
    title: 'Turn on an out of office reply in Outlook',
    summary: 'In Outlook, open Tools, then Automatic Replies. Switch on automatic replies, set the start and end dates, and write one message for colleagues and one for people outside Nimbus Labs.',
  },
  {
    number: 'KB0010004',
    title: 'Book a meeting room in Outlook',
    summary: 'Create a new event in the Outlook calendar, click Room Finder, and pick the Bengaluru office and floor. Rooms that are free at that time are listed with their size and whether they have a video bar.',
  },
];

// A few fixed articles, matched on words of four letters or more.
export class SimulatedKnowledge implements KnowledgeSource {
  readonly mode = 'simulated';

  async search(query: string): Promise<Result<KbArticle[]>> {
    const terms = new Set(words(query).filter((w) => w.length >= 4));
    const scored = SIMULATED.map((a) => ({ a, n: words(`${a.title} ${a.summary}`).filter((w) => terms.has(w)).length }));
    return success(scored.filter((x) => x.n > 0).sort((x, y) => y.n - x.n).slice(0, MAX_ARTICLES).map((x) => x.a));
  }
}
