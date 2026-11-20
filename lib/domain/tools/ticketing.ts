import { describeFailure, type Result } from '@/lib/integrations/http';
import type { Level, Mode, OpenTicket, RemoteTicket, TicketDetails } from '@/lib/integrations/types';
import { findAsset } from '../assets';
import { EMPLOYEE } from '../company';
import { issueMilestone, ticketMilestone } from '../cards';
import { findArticle } from '../kb';
import { mentionsService, outageName } from '../services';
import { mergeTickets } from '../followup';
import { dayWord, resolvedTime } from '../opener';
import { openedRange } from '../queue-query';
import { clip, echo, findTicket, isAskItFix, isOpen, parseTicketNumber, plainText, spokenTicket, ticketDescription, ticketPhrase } from '../tickets';
import type { SessionState, TicketRecord } from '../types';
import { failed, ok, plural, prepare, tool, type Outcome } from './shared';

const URGENCY: Record<string, Level> = { high: 1, medium: 2, low: 3 };

// The guided fix to attach to a new ticket, if one is still relevant.
const currentFix = (state: SessionState) => (state.troubleshooting && ['active', 'exhausted', 'fixed'].includes(state.troubleshooting.status) ? state.troubleshooting : null);

function ticketWarnings(state: SessionState, text: string): string[] {
  const warnings: string[] = [];
  const fix = currentFix(state);
  const article = fix ? findArticle(fix.articleId) : undefined;
  // Requests end in a ticket, so an unfinished request guide is no reason to wait.
  if (fix?.status === 'active' && article && !article.request) {
    warnings.push(`We're only at step ${fix.stepIndex + 1} of ${article.steps.length} of the guided fix; finishing it may solve this without a ticket.`);
  }
  for (const o of state.outages) {
    if (article?.service === o.service || mentionsService(text, o.service)) {
      warnings.push(`This looks like the known ${outageName(o)} outage, ${spokenTicket(o.incident)}. I can add you to it instead, which avoids a duplicate ticket.`);
    }
  }
  return warnings;
}

const prepareTicket = tool<Result<OpenTicket | null>>({
  name: 'prepareTicket',
  description: `Step 1 of raising an IT ticket: after the guided fix ran out, when ${EMPLOYEE.firstName} asks for a person, or for a request such as software, hardware or access. The steps tried, the device and verification state are attached automatically. Returns a confirmation code for confirmAction.`,
  params: {
    summary: { description: 'Short title, e.g. "VPN keeps dropping"' },
    urgency: { description: 'high (cannot work), medium or low', enum: ['high', 'medium', 'low'] },
    details: { description: `Anything else ${EMPLOYEE.firstName} said, or empty string`, allowEmpty: true },
  },
  // A scanned device may already have an open ticket from someone else.
  async effect({ state, deps }) {
    return state.asset ? deps.tickets.findOpenForAsset(state.asset.id) : undefined;
  },
  run({ state, now, effect }, args) {
    if (args.summary.length > 160) return failed('Ticket not prepared: summary too long', 'summary_too_long', 'That title is too long for a ticket. Can you say it in a few words?');
    const fix = currentFix(state);
    const steps = fix?.log.length ?? 0;
    const ticket = {
      shortDescription: args.summary,
      description: ticketDescription(state, fix, args.details, now),
      urgency: URGENCY[args.urgency],
      impact: 3 as Level,
      category: (fix && findArticle(fix.articleId)?.category) || 'inquiry',
    };
    const warnings = ticketWarnings(state, `${args.summary} ${args.details}`);
    const attached = steps ? `, with the ${plural(steps, 'step')} we tried attached` : '';
    const outage = state.outages.find((o) => warnings.some((w) => w.includes(spokenTicket(o.incident))));
    let extraNext = outage ? `If they prefer, call followOutage with ${outage.incident} instead of confirming. ` : '';
    let lead = `Ready to raise a ticket: "${echo(args.summary, 160)}", ${args.urgency} urgency${attached}.`;
    const asset = state.asset ? findAsset(state.asset.id) : undefined;
    const data: Record<string, unknown> = {};
    if (state.asset && asset) {
      const open = effect?.ok ? effect.value : null;
      if (effect?.ok) state.asset.ticket = open;
      if (open) {
        warnings.push(`${asset.name} already has an open ticket, ${spokenTicket(open.number)}, ${open.summary}. I can add your report to it instead, which avoids a duplicate ticket.`);
        extraNext += `Instead of confirming, call addTicketNote with ticket ${open.number} and their report as the note. `;
        data.existingTicket = { number: open.number, summary: open.summary };
      } else if (!effect?.ok) {
        lead += ` I couldn't check whether ${asset.name} already has a ticket, so IT may see this as a duplicate.`;
      }
    }
    const out = prepare(state, now, { kind: 'ticket', ticket }, `Raise a ${args.urgency}-urgency ticket: ${args.summary}`, warnings, lead, extraNext, data);
    return { ...out, alerts: [issueMilestone(state, now, 'waiting_employee', `Waiting for the employee to confirm a ${args.urgency}-urgency ticket`, { title: args.summary })] };
  },
});

const ticketView = (t: TicketRecord) => ({ number: t.number, summary: t.summary, state: t.state, urgency: t.urgency, source: t.source, syncFailed: Boolean(t.syncFailed) });

type TicketStatus = 'open' | 'resolved' | 'all';
const PERIODS = ['today', 'yesterday', 'this_week', 'last_7_days', 'this_month'] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_WORD: Record<Period, string> = { today: 'today', yesterday: 'yesterday', this_week: 'this week', last_7_days: 'in the last 7 days', this_month: 'this month' };
const LABEL: Record<TicketStatus, string> = { open: 'open ticket', resolved: 'resolved ticket', all: 'ticket' };

const isDone = (t: TicketRecord) => /resolved|closed/i.test(t.state);

// Open tickets count from when they were raised, finished ones from when they were resolved.
function inPeriod(t: TicketRecord, period: Period | '', now: number) {
  if (!period) return true;
  const { since, before = Infinity } = openedRange(period, now);
  const at = isOpen(t) ? t.createdAt : resolvedTime(t);
  return at >= since && at < before;
}

const matches = (t: TicketRecord, status: TicketStatus) => (status === 'all' ? true : status === 'open' ? isOpen(t) : isDone(t));

// ", 2 in progress and 1 on hold", ", 1 open and 2 resolved" or ", 1 fixed on a call with ASK IT".
function breakdown(tickets: TicketRecord[], status: TicketStatus): string {
  if (status === 'all') return `, ${tickets.filter(isOpen).length} open and ${tickets.filter((t) => !isOpen(t)).length} resolved`;
  if (status === 'resolved') {
    const fixed = tickets.filter(isAskItFix).length;
    return fixed ? `, ${fixed} fixed on a call with ASK IT` : '';
  }
  const states = new Map<string, number>();
  for (const t of tickets) states.set(t.state.trim().toLowerCase(), (states.get(t.state.trim().toLowerCase()) ?? 0) + 1);
  if (states.size === 1) return `, ${tickets.length === 2 ? 'both' : 'all'} ${[...states.keys()][0]}`;
  const parts = [...states].map(([state, n]) => `${n} ${state}`);
  return `, ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

// A short summary like the IT desk gives; one ticket is named, a list is never read out.
function listSay(tickets: TicketRecord[], status: TicketStatus, period: Period | ''): string {
  const when = period ? `${status === 'open' ? ' raised' : status === 'all' ? ' from' : ''} ${PERIOD_WORD[period]}` : '';
  const label = LABEL[status];
  if (!tickets.length) return `You have no ${label}s${when}.`;
  if (tickets.length === 1) {
    const t = tickets[0];
    const state = status === 'resolved' ? '' : `, ${t.state.trim().toLowerCase()}`;
    return `You have one ${label}${when}, ${ticketPhrase(t.summary)}${state}. Want the details?`;
  }
  return `You have ${tickets.length} ${label}s${when}${breakdown(tickets, status)}. Want details on any of them?`;
}

const listMyTickets = tool<{ mode: Mode; listed: Result<RemoteTicket[]> }>({
  name: 'listMyTickets',
  description: `${EMPLOYEE.firstName}'s IT tickets, refreshed from ServiceNow, filtered by status and time: "what's open" is status open, "show my resolved tickets" is status resolved, "anything closed this week" is status resolved and period this_week. The reply is a short summary; the tickets are in the result, never read them one by one. If ServiceNow is unreachable, returns the last known list and says it may be stale.`,
  params: {
    status: { description: 'all, open, or resolved (includes closed). all unless they ask for open or resolved ones', enum: ['all', 'open', 'resolved'], allowEmpty: true },
    period: { description: 'any unless the employee names a time; then today, yesterday, this_week, last_7_days or this_month, by when it was raised (open) or resolved. "my tickets" or "tickets under my name" is any', enum: ['any', ...PERIODS], allowEmpty: true },
  },
  minutesSaved: 2,
  async effect({ deps }) {
    return { mode: deps.tickets.mode, listed: await deps.tickets.listMine() };
  },
  run({ state, now, effect }, args) {
    const status = (args.status || 'all') as TicketStatus;
    const period = (args.period === 'any' ? '' : args.period || '') as Period | '';
    const listed = effect?.listed;
    if (effect && listed?.ok) mergeTickets(state, listed.value, effect.mode, now);
    const tickets = state.tickets.filter((t) => matches(t, status) && inPeriod(t, period, now));
    // The screen shows the same subset the reply sums up.
    state.ticketList = { status, period, numbers: tickets.map((t) => t.number), at: now };
    const stale = !listed?.ok;
    const warning = stale ? `I couldn't reach ServiceNow just now.${listed && !listed.ok ? ` ${describeFailure('ServiceNow', listed.error)}` : ''} So this list may be out of date. ` : '';
    const say = `${warning}${listSay(tickets, status, period)}`;
    const title = `Listed ${plural(tickets.length, LABEL[status])}${period ? ` ${PERIOD_WORD[period]}` : ''}${stale ? ' (may be stale)' : ''}`;
    const next = tickets.length ? 'The tickets are in data.tickets: do not read them aloud. Give the number, state or details of one only when asked.' : undefined;
    return { title, result: ok(say, { stale, status, period, total: tickets.length, tickets: tickets.map(ticketView) }, next) };
  },
});

// The ticket asked about: a number as said, else their latest open ticket.
function askedTicket(state: SessionState, raw: string): string | null {
  if (!raw.trim()) return findTicket(state, '')?.number ?? null;
  return findTicket(state, raw)?.number ?? parseTicketNumber(raw);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const firstName = (name: string) => name.trim().split(/\s+/)[0];
const team = (group: string) => `the ${group.replace(/\s+team$/i, '')} team`;
const plainLine = (text: string) => plainText(echo(text, 200)).replace(/[.!?]+$/, '');

function detailsSay(d: TicketDetails, now: number): string {
  const name = capital(ticketPhrase(d.summary));
  const state = d.state.trim().toLowerCase();
  const done = /resolved|closed/.test(state);
  const status = state === 'resolved' ? `${name} was resolved.` : `${name} is ${state}.`;
  const person = d.assignee ? `${firstName(d.assignee)}${d.group ? ` from ${team(d.group)}` : ''}` : '';
  const owner = person ? `${person} ${done ? 'handled it' : 'is on it'}.` : d.group ? `It's with ${team(d.group)}, not assigned to a person yet.` : done ? '' : "It isn't assigned to anyone yet.";
  const update = done && d.resolution
    ? `The resolution note says ${plainLine(d.resolution)}.`
    : d.lastComment
      ? `The last update${d.lastComment.at ? `, ${dayWord(d.lastComment.at, now)},` : ''} says ${plainLine(d.lastComment.text)}.`
      : done ? '' : "There's no update from IT on it yet.";
  return [status, owner, update].filter(Boolean).join(' ');
}

const getTicketDetails = tool<{ mode: Mode; read: Result<TicketDetails | null> }>({
  name: 'getTicketDetails',
  description: `One of ${EMPLOYEE.firstName}'s own tickets, read live from ServiceNow: its status, who is working on it and their team, and the last update IT shared with them. Use it for "who has my ticket", "any update on the VPN one" or "details of ticket 10049". Never for other people's tickets.`,
  params: { ticket: { description: 'Ticket number as said, or empty string for their latest open ticket', allowEmpty: true } },
  minutesSaved: 2,
  async effect({ state, deps }, args) {
    const number = askedTicket(state, args.ticket);
    return number ? { mode: deps.tickets.mode, read: await deps.tickets.details(number) } : undefined;
  },
  run({ state, now, effect }, args) {
    const number = askedTicket(state, args.ticket);
    if (!number) return failed('Ticket details: which ticket', 'which_ticket', 'Which ticket is it? Tell me its number, or what it was about.');
    const known = state.tickets.find((t) => t.number === number);
    const read = effect?.read;
    if (!read || !read.ok) {
      const last = known ? ` Last I saw, ${ticketPhrase(known.summary)} was ${known.state.trim().toLowerCase()}.` : '';
      const why = read && !read.ok ? describeFailure('ServiceNow', read.error) : '';
      return failed(`Ticket details: ${number} not read`, 'details_unavailable', `I couldn't read it from ServiceNow just now.${why ? ` ${why}` : ''}${last}`);
    }
    const d = read.value;
    // Only the caller's own tickets come back, so anyone else's reads as not found.
    if (!d) return failed(`Ticket details: ${number} not theirs`, 'unknown_ticket', `I can only look up your own tickets, and I can't find ${spokenTicket(number)} among them.`);
    mergeTickets(state, [d], effect.mode, now);
    const lastUpdate = d.lastComment ? { text: d.lastComment.text, at: d.lastComment.at } : null;
    return {
      title: `Ticket details: ${d.number} ${d.state}${d.assignee ? `, ${d.assignee}` : ''}`,
      result: ok(detailsSay(d, now), { number: d.number, summary: d.summary, state: d.state, assignee: d.assignee, group: d.group, lastUpdate, resolution: d.resolution }),
    };
  },
});

function unknownTicket(state: SessionState, raw: string, title: string): Outcome {
  const open = state.tickets.filter(isOpen).map((t) => `${spokenTicket(t.number)}, ${echo(t.summary, 100)}`);
  return failed(title, 'unknown_ticket', `I can't find ticket ${echo(raw)} among your tickets.${open.length ? ` Your open ones are ${open.join('; ')}.` : ''}`, open);
}

const notSynced = (title: string) =>
  failed(title, 'not_synced', "That ticket only exists as a local copy because ServiceNow was unreachable, so I can't change it. I can raise it again instead.");

// The open ticket already raised for the scanned device, which is not hers.
function deviceTicket(state: SessionState, raw: string): OpenTicket | undefined {
  const t = state.asset?.ticket;
  return t && parseTicketNumber(raw) === t.number ? t : undefined;
}

const reportFrom = (state: SessionState, note: string) => `Also reported by ${state.employee.name} from the QR sticker on ${findAsset(state.asset?.id)?.name ?? 'the device'}: ${note}`;

const addTicketNote = tool({
  name: 'addTicketNote',
  description:
    `Step 1 of adding a comment to one of ${EMPLOYEE.firstName}'s tickets, or to the open ticket of a scanned device. Accepts spoken numbers like "I N C 12001" or "ticket 12001", or empty string for their latest open ticket. Reads the note back and returns a confirmation code: ask for their yes, then call confirmAction.`,
  params: {
    ticket: { description: 'Ticket number as said, or empty string for the latest open ticket', allowEmpty: true },
    note: { description: 'The comment to add, in plain words' },
  },
  run({ state, now }, args) {
    const t = findTicket(state, args.ticket);
    const shared = t ? undefined : deviceTicket(state, args.ticket);
    if (!t && !shared) return unknownTicket(state, args.ticket, 'Note: unknown ticket');
    if (t && !t.sysId) return notSynced(`Note: ${t.number} is local only`);
    const spoken = spokenTicket((t ?? shared)!.number);
    const note = echo(args.note, 160);
    if (shared) {
      const payload = { kind: 'note' as const, number: shared.number, sysId: shared.sysId, text: reportFrom(state, args.note), shared: true };
      return prepare(state, now, payload, `Add your report to ${shared.number}: ${clip(args.note, 120)}`, [], `Shall I add your report to ${spoken}, the ticket already open for this device: ${note}?`);
    }
    const payload = { kind: 'note' as const, number: t!.number, sysId: t!.sysId!, text: args.note, shared: false };
    return prepare(state, now, payload, `Add a note to ${t!.number}: ${clip(args.note, 120)}`, [], `Shall I add this note to ${spoken}: ${note}?`);
  },
});

const prepareEscalation = tool({
  name: 'prepareEscalation',
  description: `Step 1 of escalating one of ${EMPLOYEE.firstName}'s open tickets to high urgency, with a reason. IT is alerted. Returns a confirmation code for confirmAction.`,
  params: {
    ticket: { description: 'Ticket number as said, or empty string for the latest open ticket', allowEmpty: true },
    reason: { description: 'Why it is urgent, in plain words' },
  },
  run({ state, now }, args) {
    const t = findTicket(state, args.ticket);
    if (!t) return unknownTicket(state, args.ticket, 'Escalation: unknown ticket');
    if (!t.sysId) return notSynced(`Escalation: ${t.number} is local only`);
    if (!isOpen(t)) return failed(`Escalation: ${t.number} is closed`, 'ticket_closed', 'That ticket is already resolved. If the problem is back, I can raise a new one.');
    if (t.escalated) return failed(`Escalation: ${t.number} already escalated`, 'already_escalated', 'That ticket is already escalated to high urgency.');
    const out = prepare(state, now, { kind: 'escalation', number: t.number, sysId: t.sysId, reason: args.reason }, `Escalate ${t.number} to high urgency: ${args.reason}`, [], `Ready to escalate ${spokenTicket(t.number)} to high urgency because ${args.reason}.`);
    const e = state.employee;
    const alert = ticketMilestone(state, now, { number: t.number, title: t.summary, person: e.name, device: e.device.id }, 'waiting_employee', `Waiting for the employee to confirm escalation: ${args.reason}`);
    return { ...out, alerts: [alert] };
  },
});

export const TICKET_TOOLS = [prepareTicket, listMyTickets, getTicketDetails, addTicketNote, prepareEscalation];
