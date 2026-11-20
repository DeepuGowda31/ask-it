import type { Mode } from '@/lib/integrations/types';
import { addDocument, queueAlert } from '../actions';
import { deviceLabel } from '../company';
import { isOpen } from '../tickets';
import { formatTime, isoDate, longDate } from '../time';
import type { SessionState } from '../types';
import { isVerified } from './identity';
import { ok, plural, tool } from './shared';

const ACTION_LABEL = { unlock: 'account unlocked', resetPassword: 'password reset link sent', resetMfa: 'MFA reset' };

// A lockdown counts as done only for the steps that went through.
function lockdownLabel(state: SessionState) {
  const steps = state.lockdown?.steps ?? [];
  const failed = steps.filter((s) => !s.ok).length;
  return !failed ? 'security lockdown' : failed === steps.length ? 'security lockdown failed' : 'security lockdown, partly done';
}

function facts(state: SessionState) {
  const here = state.tickets.filter((t) => t.raisedHere);
  return {
    resolved: here.filter((t) => !isOpen(t)),
    raised: here.filter(isOpen),
    escalated: state.tickets.filter((t) => t.escalated),
    followed: state.outages.filter((o) => o.followed),
    accountActions: state.pending.flatMap((a) => (a.status !== 'done' ? [] : a.payload.kind === 'account' ? [ACTION_LABEL[a.payload.action]] : a.payload.kind === 'lockdown' ? [lockdownLabel(state)] : [])),
    waiting: state.pending.filter((a) => a.status === 'pending'),
    open: state.tickets.filter(isOpen),
  };
}

const line = (number: string, summary: string, extra = '') => `${number} ${summary}${extra}${number.startsWith('LOCAL') ? ' (not in ServiceNow)' : ''}`;
const listOr = (items: string[]) => (items.length ? items.join('; ') : 'none');

// Plain text for the IT channel.
function summaryText(state: SessionState): string {
  const f = facts(state);
  const e = state.employee;
  return [
    `ASK IT call summary for ${e.name} (${e.device.id}).`,
    `Resolved without IT: ${listOr(f.resolved.map((t) => line(t.number, t.summary)))}.`,
    `Tickets raised: ${listOr(f.raised.map((t) => line(t.number, t.summary)))}.`,
    `Escalated: ${listOr(f.escalated.map((t) => t.number))}.`,
    `Outages followed: ${listOr(f.followed.map((o) => `${o.incident} ${o.title}`))}.`,
    `Account actions: ${listOr(f.accountActions)}.`,
  ].join(' ');
}

function summaryMarkdown(state: SessionState, now: number): string {
  const f = facts(state);
  const e = state.employee;
  const bullets = (items: string[]) => (items.length ? items.map((i) => `- ${i}`) : ['- None.']);
  const next = [
    ...f.open.map((t) => `${t.number} · ${t.summary} is ${t.state.toLowerCase()}; IT will follow up.`),
    ...f.waiting.map((a) => `Not confirmed: ${a.summary}.`),
  ];
  return [
    `# Call summary · ${e.name}`,
    '',
    `- **When:** ${longDate(isoDate(now))}, ${formatTime(now)}`,
    `- **Device:** ${deviceLabel(e)}`,
    `- **Identity:** ${isVerified(state, now) ? 'verified by email code' : 'not verified'}`,
    '',
    '## Resolved without IT',
    '',
    ...bullets(f.resolved.map((t) => line(t.number, t.summary))),
    '',
    '## Tickets raised',
    '',
    ...bullets(f.raised.map((t) => line(t.number, t.summary, `, ${t.state.toLowerCase()}`))),
    '',
    '## Escalations',
    '',
    ...bullets(f.escalated.map((t) => `${t.number} · ${t.summary}`)),
    '',
    '## Outages followed',
    '',
    ...bullets(f.followed.map((o) => `${o.incident} · ${o.title}${o.affected === null ? '' : ` (${o.affected} affected)`}`)),
    '',
    '## Account actions',
    '',
    ...bullets(f.accountActions),
    '',
    '## Next steps',
    '',
    ...bullets(next),
  ].join('\n');
}

function spokenSummary(state: SessionState): string {
  const f = facts(state);
  const parts = [
    f.resolved.length ? `${plural(f.resolved.length, 'issue')} resolved without IT` : '',
    f.raised.length ? `${plural(f.raised.length, 'ticket')} raised` : '',
    f.escalated.length ? `${plural(f.escalated.length, 'ticket')} escalated` : '',
    f.followed.length ? `following ${plural(f.followed.length, 'outage')}` : '',
    f.accountActions.length ? f.accountActions.join(' and ') : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing changed in this call';
}

const postSay = (mode: Mode) =>
  mode === 'live' ? "I'm posting the summary to the IT channel now." : 'The summary is on your screen; posting to the IT channel is simulated because no webhook is set up.';

const wrapUpCall = tool<Mode>({
  name: 'wrapUpCall',
  description: 'End-of-call summary from what actually happened: issues resolved, tickets raised or escalated, outages followed, account actions and next steps. Posts it to the IT channel and shows it as a document.',
  params: {},
  minutesSaved: 3,
  async effect({ deps }) {
    return deps.notifyMode;
  },
  run({ state, now, effect }) {
    const alert = queueAlert(state, now, 'callSummary', summaryText(state));
    addDocument(state, now, { kind: 'callSummary', title: `Call summary · ${formatTime(now)}`, markdown: summaryMarkdown(state, now) });
    return { title: 'Call summary ready', alerts: [alert], result: ok(`Here's the wrap-up: ${spokenSummary(state)}. ${postSay(effect ?? 'simulated')}`, { posting: true }) };
  },
});

export const WRAPUP_TOOLS = [wrapUpCall];
