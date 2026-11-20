import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import type { ReportData, ReportIncident } from '@/lib/domain/report';

// The service desk report as an A4 PDF: standard Helvetica only, so it needs no font files and runs anywhere.

const W = 595.28;
const H = 841.89;
const M = 40;
const CW = W - 2 * M;
const BOTTOM = 62;
const FOOTER = 34;

const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const C = {
  ink: hex('#0f172a'),
  body: hex('#334155'),
  muted: hex('#64748b'),
  faint: hex('#94a3b8'),
  hair: hex('#e2e8f0'),
  panel: hex('#f8fafc'),
  track: hex('#f1f5f9'),
  teal: hex('#14b8a6'),
  tealDark: hex('#0f766e'),
  slate: hex('#475569'),
  red: hex('#dc2626'),
  amber: hex('#d97706'),
};

interface TextOpts {
  size?: number;
  bold?: boolean;
  color?: RGB;
  align?: 'left' | 'right' | 'center';
  // Truncated with an ellipsis to fit.
  width?: number;
}

interface Cell {
  text: string;
  color?: RGB;
  bold?: boolean;
}

interface Column {
  label: string;
  // Fixed width; one column per table leaves it out and takes the rest.
  width?: number;
  align?: 'left' | 'right';
  // Up to this many lines; the last one ends with an ellipsis when cut.
  lines?: number;
}

const ROW = 16;
const LINE = 9.5;
const SIZE = 8;

class Writer {
  page!: PDFPage;
  y = 0;
  private pages: PDFPage[] = [];
  private chars: Set<number>;

  constructor(
    private doc: PDFDocument,
    private font: PDFFont,
    private bold: PDFFont,
    private data: ReportData,
  ) {
    this.chars = new Set(font.getCharacterSet());
  }

  // Characters Helvetica cannot draw become their plain letter, else "?".
  clean(s: string): string {
    let out = '';
    for (const ch of s.replace(/[\u0000-\u001f\u007f]+/g, ' ')) {
      if (this.chars.has(ch.codePointAt(0)!)) out += ch;
      else {
        const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
        out += base.length === 1 && this.chars.has(base.codePointAt(0)!) ? base : '?';
      }
    }
    return out;
  }

  widthOf(s: string, size: number, bold = false) {
    return (bold ? this.bold : this.font).widthOfTextAtSize(s, size);
  }

  fit(s: string, size: number, width: number, bold = false): string {
    const text = this.clean(s);
    if (this.widthOf(text, size, bold) <= width) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.widthOf(`${text.slice(0, mid).trimEnd()}…`, size, bold) <= width) lo = mid;
      else hi = mid - 1;
    }
    return `${text.slice(0, lo).trimEnd()}…`;
  }

  wrap(s: string, size: number, width: number, max: number): string[] {
    const words = this.clean(s).split(' ').filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (let k = 0; k < words.length; k++) {
      const next = line ? `${line} ${words[k]}` : words[k];
      if (this.widthOf(next, size) <= width || !line) {
        line = next;
        continue;
      }
      if (lines.length === max - 1) return [...lines, this.fit(`${line} ${words.slice(k).join(' ')}`, size, width)];
      lines.push(line);
      line = words[k];
    }
    return line ? [...lines, this.fit(line, size, width)] : lines;
  }

  text(s: string, x: number, y: number, o: TextOpts = {}) {
    const size = o.size ?? SIZE;
    const font = o.bold ? this.bold : this.font;
    const t = o.width !== undefined ? this.fit(s, size, o.width, o.bold) : this.clean(s);
    const w = font.widthOfTextAtSize(t, size);
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    this.page.drawText(t, { x: left, y, size, font, color: o.color ?? C.body });
  }

  rect(x: number, y: number, w: number, h: number, color: RGB, border?: RGB) {
    this.page.drawRectangle({ x, y, width: w, height: h, color, ...(border ? { borderColor: border, borderWidth: 0.6 } : {}) });
  }

  rule(y: number, color = C.hair, width = 0.6, x = M, w = CW) {
    this.page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: width, color });
  }

  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pages.push(this.page);
    if (this.pages.length === 1) {
      this.y = H;
      return;
    }
    this.text(this.data.title, M, H - 34, { size: 8, bold: true, color: C.ink });
    this.text(`${this.data.periodLabel} · ${this.data.range}`, W - M, H - 34, { size: 8, color: C.muted, align: 'right' });
    this.rule(H - 42);
    this.y = H - 66;
  }

  // Starts a new page unless `h` more points fit.
  ensure(h: number) {
    if (this.y - h < BOTTOM) this.newPage();
  }

  footers() {
    this.pages.forEach((p, n) => {
      this.page = p;
      this.rule(FOOTER + 12);
      this.text(`ASK IT · ${this.data.title} · ${this.data.periodLabel}`, M, FOOTER, { size: 7.5, color: C.muted });
      this.text(`Page ${n + 1} of ${this.pages.length}`, W - M, FOOTER, { size: 7.5, color: C.muted, align: 'right' });
    });
  }

  section(title: string, room = 70) {
    this.ensure(28 + room);
    this.y -= 18;
    this.text(title, M, this.y, { size: 12.5, bold: true, color: C.ink });
    this.rect(M, this.y - 7, 18, 1.6, C.teal);
    this.y -= 22;
  }

  sub(title: string, count: number | null, room = 40) {
    this.ensure(26 + room);
    this.y -= 12;
    this.text(title, M, this.y, { size: 9.5, bold: true, color: C.ink });
    if (count !== null) this.text(String(count), M + this.widthOf(this.clean(title), 9.5, true) + 6, this.y, { size: 9.5, color: C.muted });
    this.y -= 14;
  }

  none(x = M) {
    this.ensure(16);
    this.text('None', x, this.y - 2, { size: 8.5, color: C.muted });
    this.y -= 16;
  }

  private widths(cols: Column[]) {
    const fixed = cols.reduce((n, c) => n + (c.width ?? 0), 0);
    return cols.map((c) => c.width ?? CW - fixed);
  }

  private header(cols: Column[]) {
    const ws = this.widths(cols);
    let x = M;
    cols.forEach((c, k) => {
      this.text(c.label.toUpperCase(), c.align === 'right' ? x + ws[k] - 4 : x + 4, this.y - 9, { size: 6.5, bold: true, color: C.muted, align: c.align === 'right' ? 'right' : 'left', width: ws[k] - 8 });
      x += ws[k];
    });
    this.y -= 14;
    this.rule(this.y, C.faint, 0.7);
  }

  private lines(cols: Column[], row: Cell[]) {
    const ws = this.widths(cols);
    return row.map((cell, k) => (cols[k].lines ? this.wrap(cell.text, SIZE, ws[k] - 8, cols[k].lines!) : [cell.text]));
  }

  private rowHeight(cells: string[][]) {
    return ROW + (Math.max(...cells.map((l) => l.length)) - 1) * LINE;
  }

  // Room to keep with a table's title: all of a short table, else its header and first rows.
  keepHeight(cols: Column[], rows: Cell[][]) {
    if (!rows.length) return 16;
    const hs = rows.map((r) => this.rowHeight(this.lines(cols, r)));
    const all = 20 + hs.reduce((a, b) => a + b, 0);
    return all <= 220 ? all : 20 + hs.slice(0, 3).reduce((a, b) => a + b, 0);
  }

  // A table that breaks across pages with its header repeated; `again` titles the continuation.
  table(cols: Column[], rows: Cell[][], again: string) {
    if (!rows.length) return this.none();
    const ws = this.widths(cols);
    this.ensure(14 + ROW);
    this.header(cols);
    for (const row of rows) {
      const cells = this.lines(cols, row);
      const h = this.rowHeight(cells);
      if (this.y - h < BOTTOM) {
        this.newPage();
        this.text(again, M, this.y, { size: 9.5, bold: true, color: C.ink });
        this.y -= 8;
        this.header(cols);
      }
      let x = M;
      row.forEach((cell, k) => {
        const right = cols[k].align === 'right';
        cells[k].forEach((line, n) =>
          this.text(line, right ? x + ws[k] - 4 : x + 4, this.y - 11 - n * LINE, { color: cell.color, bold: cell.bold, align: right ? 'right' : 'left', width: ws[k] - 8 }),
        );
        x += ws[k];
      });
      this.y -= h;
      this.rule(this.y);
    }
    this.y -= 6;
  }
}

const priorityCell = (i: Pick<ReportIncident, 'priority' | 'priorityLabel'>): Cell => (i.priority === 1 ? { text: i.priorityLabel, color: C.red, bold: true } : { text: i.priorityLabel });
const stateCell = (state: string): Cell => (state === 'On Hold' ? { text: state, color: C.amber } : { text: state });
const assigneeCell = (name: string): Cell => (name ? { text: name } : { text: 'Unassigned', color: C.amber });
const teamCell = (team: string): Cell => (team ? { text: team } : { text: 'No group', color: C.faint });
const plain = (text: string): Cell => ({ text });

function title(w: Writer, d: ReportData) {
  w.newPage();
  w.rect(0, H - 5, W, 5, C.teal);
  w.text('ASK IT', M, H - 38, { size: 10, bold: true, color: C.tealDark });
  w.text('IT Operations', W - M, H - 38, { size: 8.5, color: C.muted, align: 'right' });
  w.text(d.title, M, H - 72, { size: 22, bold: true, color: C.ink });
  w.text(`${d.periodLabel} · ${d.range}`, M, H - 93, { size: 11, color: C.body });
  w.text(`Prepared ${d.prepared}`, M, H - 110, { size: 8.5, color: C.muted });
  w.page.drawCircle({ x: M + 2.5, y: H - 121.5, size: 2.5, color: d.source.startsWith('Live') ? C.teal : C.faint });
  w.text(d.source, M + 9, H - 124, { size: 8.5, color: C.muted });
  if (d.scope) w.text(d.scope, W - M, H - 124, { size: 8.5, color: C.muted, align: 'right' });
  w.y = H - 136;
  w.rule(w.y);
  w.y -= 4;
}

function figures(w: Writer, d: ReportData) {
  const f = d.figures;
  const count = (n: number, more = false) => (more ? `${n}+` : String(n));
  const tiles: { label: string; value: string; note: string; tone?: RGB }[] = [
    { label: 'Open now', value: count(f.open, f.openMore), note: 'New, in progress or on hold' },
    { label: 'Critical', value: String(f.critical), note: 'Open at priority 1', tone: f.critical ? C.red : undefined },
    { label: 'Unassigned', value: String(f.unassigned), note: 'Open with no assignee', tone: f.unassigned ? C.amber : undefined },
    { label: 'On hold', value: String(f.onHold), note: 'Blocked, waiting on someone', tone: f.onHold ? C.amber : undefined },
    { label: 'New in period', value: String(f.newInPeriod), note: 'Incidents opened' },
    { label: 'Resolved in period', value: String(f.resolvedInPeriod), note: d.resolvedMore ? 'At least this many' : 'Incidents resolved' },
    { label: 'Average time to resolve', value: f.avgResolve?.text ?? 'None', note: f.avgResolve ? `Over ${f.avgResolve.count} resolved` : 'Nothing resolved with dates' },
    { label: 'Oldest open', value: f.oldest?.age ?? 'None', note: f.oldest ? f.oldest.number : 'No open incidents' },
  ];
  w.section('Key figures', 130);
  const gap = 10;
  const tw = (CW - 3 * gap) / 4;
  const th = 56;
  tiles.forEach((t, k) => {
    const x = M + (k % 4) * (tw + gap);
    const top = w.y - Math.floor(k / 4) * (th + gap);
    w.rect(x, top - th, tw, th, C.panel, C.hair);
    w.rect(x, top - th, 2.5, th, t.tone ?? C.teal);
    w.text(t.label, x + 11, top - 14, { size: 7.5, color: C.muted, width: tw - 16 });
    w.text(t.value, x + 11, top - 36, { size: t.value.length > 8 ? 14 : 19, bold: true, color: t.tone ?? C.ink, width: tw - 16 });
    w.text(t.note, x + 11, top - 48, { size: 7, color: C.faint, width: tw - 16 });
  });
  w.y -= 2 * th + gap + 6;
}

// Horizontal bars: the count is printed, the bar shows proportion; an empty bucket draws no bar.
function barList(w: Writer, x: number, width: number, top: number, caption: string, rows: { label: string; count: number }[], tone: (label: string) => RGB): number {
  w.text(caption, x, top, { size: 9, bold: true, color: C.ink });
  let y = top - 18;
  if (!rows.some((r) => r.count)) {
    w.text('None', x, y, { size: 8.5, color: C.muted });
    return top - 30;
  }
  const labelW = 74;
  const valueW = 22;
  const trackW = width - labelW - valueW - 6;
  const max = Math.max(...rows.map((r) => r.count));
  for (const r of rows) {
    w.text(r.label, x, y, { size: 8, width: labelW - 6, color: r.label === 'No group' || r.label === 'Other' ? C.muted : C.body });
    w.rect(x + labelW, y - 1, trackW, 7, C.track);
    if (r.count) w.rect(x + labelW, y - 1, Math.max(1.5, (r.count / max) * trackW), 7, tone(r.label));
    w.text(String(r.count), x + width, y, { size: 8, align: 'right', color: C.ink });
    y -= 15;
  }
  return y + 2;
}

function openCharts(w: Writer, d: ReportData) {
  w.section('Open incidents', 150);
  const gap = 18;
  const cw = (CW - 2 * gap) / 3;
  const top = w.y;
  const ends = [
    barList(w, M, cw, top, 'Open by priority', d.byPriority, (l) => (l === 'Critical' ? C.red : C.teal)),
    barList(w, M + cw + gap, cw, top, 'Open by state', d.byState, (l) => (l === 'On Hold' ? C.amber : C.teal)),
    barList(w, M + 2 * (cw + gap), cw, top, 'Open by team', d.byTeam, (l) => (l === 'No group' ? C.amber : C.teal)),
  ];
  w.y = Math.min(...ends) - 6;
}

const niceStep = (max: number) => {
  const raw = Math.max(1, max / 4);
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
};

// New against resolved per day, as paired vertical bars.
function dayChart(w: Writer, d: ReportData) {
  const ph = 112;
  w.section('New and resolved per day', ph + 40);
  const top = w.y;
  if (!d.days.some((x) => x.opened || x.resolved)) return w.none();
  const legend = (x: number, color: RGB, label: string) => {
    w.rect(x, top + 22, 7, 7, color);
    w.text(label, x + 10, top + 23, { size: 8, color: C.body });
  };
  legend(W - M - 112, C.teal, 'New');
  legend(W - M - 60, C.slate, 'Resolved');
  const max = Math.max(...d.days.flatMap((x) => [x.opened, x.resolved]));
  const step = niceStep(max);
  const scale = Math.ceil(max / step) * step;
  const left = M + 24;
  const pw = W - M - left;
  const base = top - ph;
  for (let v = 0; v <= scale; v += step) {
    const y = base + (v / scale) * (ph - 10);
    w.rule(y, v ? C.hair : C.faint, v ? 0.5 : 0.8, left, pw);
    w.text(String(v), left - 6, y - 2.5, { size: 7, color: C.muted, align: 'right' });
  }
  const gw = pw / d.days.length;
  const bw = Math.min(14, gw * 0.32);
  const every = gw >= 15 ? 1 : 2;
  d.days.forEach((x, k) => {
    const cx = left + gw * (k + 0.5);
    ([[x.opened, C.teal, cx - bw - 0.5], [x.resolved, C.slate, cx + 0.5]] as const).forEach(([n, color, bx]) => {
      if (!n) return;
      const h = (n / scale) * (ph - 10);
      w.rect(bx, base, bw, h, color);
      if (d.days.length <= 14) w.text(String(n), bx + bw / 2, base + h + 3, { size: 6.5, color: C.body, align: 'center' });
    });
    if (k % every === 0) w.text(x.label, cx, base - 11, { size: 7, color: C.muted, align: 'center' });
  });
  w.y = base - 24;
}

function attention(w: Writer, d: ReportData) {
  const a = d.attention;
  const urgent: [Column[], Cell[][]] = [
    [{ label: 'Incident', width: 62 }, { label: 'Priority', width: 50 }, { label: 'State', width: 58 }, { label: 'Title' }, { label: 'Team', width: 78 }, { label: 'Assignee', width: 84 }, { label: 'Age', width: 48, align: 'right' }],
    a.urgent.map((i) => [plain(i.number), priorityCell(i), stateCell(i.state), plain(i.title), teamCell(i.team), assigneeCell(i.assignee), plain(i.age)]),
  ];
  const blocked: [Column[], Cell[][]] = [
    [{ label: 'Incident', width: 62 }, { label: 'Title', width: 138 }, { label: 'Waiting on', width: 78 }, { label: 'Latest work note', lines: 2 }, { label: 'Age', width: 48, align: 'right' }],
    a.blocked.map((i) => [plain(i.number), plain(i.title), { text: i.waitingOn, color: C.amber }, { text: i.reason, color: i.reason === 'No work note yet' ? C.faint : C.body }, plain(i.age)]),
  ];
  const unassigned: [Column[], Cell[][]] = [
    [{ label: 'Incident', width: 62 }, { label: 'Priority', width: 50 }, { label: 'State', width: 58 }, { label: 'Title' }, { label: 'Team', width: 92 }, { label: 'Age', width: 48, align: 'right' }],
    a.unassigned.map((i) => [plain(i.number), priorityCell(i), stateCell(i.state), plain(i.title), teamCell(i.team), plain(i.age)]),
  ];
  w.section('Needs attention', 26 + w.keepHeight(...urgent));
  const parts: [string, [Column[], Cell[][]]][] = [['Critical and high priority', urgent], ['On hold', blocked], ['Unassigned', unassigned]];
  for (const [name, [cols, rows]] of parts) {
    w.sub(name, rows.length, w.keepHeight(cols, rows));
    w.table(cols, rows, `${name}, continued`);
  }
}

function resolved(w: Writer, d: ReportData) {
  const cols: Column[] = [{ label: 'Incident', width: 62 }, { label: 'Title' }, { label: 'Team', width: 82 }, { label: 'Assignee', width: 90 }, { label: 'Resolved', width: 52 }, { label: 'Time to resolve', width: 66, align: 'right' }];
  const rows = d.resolved.map((r) => [plain(r.number), plain(r.title), teamCell(r.team), assigneeCell(r.assignee), plain(r.resolved), plain(r.took)]);
  w.section('Resolved in the period', w.keepHeight(cols, rows) + (d.resolvedMore ? 12 : 0));
  if (d.resolvedMore) {
    w.text(`Showing the ${d.resolved.length} most recent`, M, w.y, { size: 8, color: C.muted });
    w.y -= 12;
  }
  w.table(cols, rows, 'Resolved in the period, continued');
}

function workload(w: Writer, d: ReportData) {
  const n = (v: number | null): Cell => (v === null ? { text: '' } : plain(String(v)));
  const cols: Column[] = [{ label: 'Team' }, { label: 'Open incidents', width: 84, align: 'right' }, { label: 'Engineers', width: 84, align: 'right' }, { label: 'Busy', width: 84, align: 'right' }, { label: 'Free', width: 84, align: 'right' }];
  const rows = d.workload.map((t) => [
    t.engineers === null ? { text: `${t.team}  ·  not a desk team`, color: C.muted } : { text: t.team, bold: true, color: C.ink },
    plain(String(t.open)),
    n(t.engineers),
    n(t.busy),
    t.free === 0 && t.engineers ? { text: '0', color: C.amber } : n(t.free),
  ]);
  w.section('Team workload', w.keepHeight(cols, rows));
  w.table(cols, rows, 'Team workload, continued');
}

function appendix(w: Writer, d: ReportData) {
  w.section('All open incidents', 60);
  if (d.figures.openMore) {
    w.text(`Showing the first ${d.openRows.length}`, M, w.y, { size: 8, color: C.muted });
    w.y -= 12;
  }
  w.table(
    [{ label: 'Incident', width: 56 }, { label: 'Priority', width: 44 }, { label: 'State', width: 52 }, { label: 'Title' }, { label: 'Team', width: 72 }, { label: 'Assignee', width: 76 }, { label: 'Opened', width: 44 }, { label: 'Age', width: 44, align: 'right' }],
    d.openRows.map((i) => [plain(i.number), priorityCell(i), stateCell(i.state), plain(i.title), teamCell(i.team), assigneeCell(i.assignee), plain(i.opened), plain(i.age)]),
    'All open incidents, continued',
  );
}

export async function renderReportPdf(d: ReportData): Promise<Uint8Array> {
  // No automatic metadata: every field is set below.
  const doc = await PDFDocument.create({ updateMetadata: false });
  const at = new Date(d.preparedAt);
  doc.setTitle(d.title, { showInWindowTitleBar: true });
  doc.setAuthor('ASK IT');
  doc.setSubject(`${d.periodLabel}, ${d.range}`);
  doc.setCreator('ASK IT');
  doc.setProducer('ASK IT');
  doc.setLanguage('en-IN');
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold), d);
  title(w, d);
  figures(w, d);
  openCharts(w, d);
  dayChart(w, d);
  attention(w, d);
  resolved(w, d);
  workload(w, d);
  appendix(w, d);
  w.footers();
  // Plain object streams keep the document readable by any viewer.
  return doc.save({ useObjectStreams: false });
}
