import { describeFailure, type Result } from '@/lib/integrations/http';
import type { Level, Mode, OpenTicket, RemoteTicket } from '@/lib/integrations/types';
import { findAsset } from '../assets';
import { issueMilestone, ticketMilestone } from '../cards';
import { findArticle } from '../kb';
import { mentionsService, outageName } from '../services';
import { mergeTickets } from '../followup';
import { clip, echo, findTicket, isOpen, parseTicketNumber, spokenTicket, ticketDescription } from '../tickets';
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
  description: 'Step 1 of raising an IT ticket: after the guided fix ran out, when Priya asks for a person, or for a request such as software, hardware or access. The steps tried, her device and verification state are attached automatically. Returns a confirmation code for confirmAction.',
  params: {
    summary: { description: 'Short title, e.g. "VPN keeps dropping"' },
    urgency: { description: 'high (cannot work), medium or low', enum: ['high', 'medium', 'low'] },
    details: { description: 'Anything else Priya said, or empty string', allowEmpty: true },
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
    let extraNext = outage ? `If she prefers, call followOutage with ${outage.incident} instead of confirming. ` : '';
    let lead = `Ready to raise a ticket: "${echo(args.summary, 160)}", ${args.urgency} urgency${attached}.`;
    const asset = state.asset ? findAsset(state.asset.id) : undefined;
    const data: Record<string, unknown> = {};
    if (state.asset && asset) {
      const open = effect?.ok ? effect.value : null;
      if (effect?.ok) state.asset.ticket = open;
      if (open) {
        warnings.push(`${asset.name} already has an open ticket, ${spokenTicket(open.number)}, ${open.summary}. I can add your report to it instead, which avoids a duplicate ticket.`);
        extraNext += `Instead of confirming, call addTicketNote with ticket ${open.number} and her report as the note. `;
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

const listMyTickets = tool<{ mode: Mode; listed: Result<RemoteTicket[]> }>({
  name: 'listMyTickets',
  description: "Priya's IT tickets, refreshed from ServiceNow. If ServiceNow is unreachable, returns the last known list and says it may be stale.",
  params: { status: { description: 'open, resolved or all; empty string means open', enum: ['open', 'resolved', 'all'], allowEmpty: true } },
  minutesSaved: 2,
  async effect({ deps }) {
    return { mode: deps.tickets.mode, listed: await deps.tickets.listMine() };
  },
  run({ state, now, effect }, args) {
    const status = args.status || 'open';
    const listed = effect?.listed;
    if (effect && listed?.ok) mergeTickets(state, listed.value, effect.mode, now);
    const tickets = state.tickets.filter((t) => (status === 'all' ? true : status === 'open' ? isOpen(t) : !isOpen(t)));
    const stale = !listed?.ok;
    const warning = stale ? `I couldn't reach ServiceNow just now${listed && !listed.ok ? `: ${describeFailure('ServiceNow', listed.error)}` : '.'} So this list may be out of date. ` : '';
    const label = status === 'all' ? 'ticket' : `${status} ticket`;
    const spoken = tickets.slice(0, 3).map((t) => `${spokenTicket(t.number)}, ${echo(t.summary, 100)}, ${t.state.toLowerCase()}`);
    const say = `${warning}You have ${plural(tickets.length, label)}${spoken.length ? `: ${spoken.join('; ')}` : ''}.`;
    return { title: `Listed ${plural(tickets.length, label)}${stale ? ' (may be stale)' : ''}`, result: ok(say, { stale, tickets: tickets.map(ticketView) }) };
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
    'Step 1 of adding a comment to one of Priya\'s tickets, or to the open ticket of a scanned device. Accepts spoken numbers like "I N C 12001" or "ticket 12001", or empty string for her latest open ticket. Reads the note back and returns a confirmation code: ask for her yes, then call confirmAction.',
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
  description: 'Step 1 of escalating one of Priya\'s open tickets to high urgency, with a reason. IT is alerted. Returns a confirmation code for confirmAction.',
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

export const TICKET_TOOLS = [prepareTicket, listMyTickets, addTicketNote, prepareEscalation];
