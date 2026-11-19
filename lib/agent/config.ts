import type { LlmTool, MurfTTSOptions } from 'agora-agents';
import { toolJsonSchema, toolsFor } from '@/lib/domain/tools';
import { COMPANY, EMPLOYEE } from '@/lib/domain/company';
import { formatTime, isoDate, longDate } from '@/lib/domain/time';
import { clip, echo, isOpen, spokenTicket } from '@/lib/domain/tickets';
import { findAsset, type Asset } from '@/lib/domain/assets';
import type { AssetVisit, FollowUp, Persona, SessionState, TicketRecord } from '@/lib/domain/types';

type Env = Record<string, string | undefined>;

const REQUIRED_ENV = ['NEXT_PUBLIC_AGORA_APP_ID', 'NEXT_AGORA_APP_CERTIFICATE', 'MURF_API_KEY', 'TOOL_SECRET'] as const;

export function missingEnv(env: Env = process.env): string[] {
  return REQUIRED_ENV.filter((k) => !env[k]);
}

type BaseUrlResult = { ok: true; url: string } | { ok: false; reason: string };

// Agora's cloud calls the tool endpoints, so they need a public HTTPS origin. PUBLIC_BASE_URL wins; on Vercel the deployment URL is used.
export function resolvePublicBaseUrl(env: Env = process.env): BaseUrlResult {
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
  const raw = env.PUBLIC_BASE_URL?.trim() || (vercelHost ? `https://${vercelHost}` : '');
  if (!raw) {
    return {
      ok: false,
      reason:
        'Set PUBLIC_BASE_URL to a public https:// URL for this app (for example a tunnel to localhost, or your Vercel domain). Agora calls the ASK IT tools from the cloud and cannot reach localhost.',
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `PUBLIC_BASE_URL "${raw}" is not a valid URL.` };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'PUBLIC_BASE_URL must start with https:// — Agora only calls HTTPS tool endpoints.' };
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)) {
    return { ok: false, reason: 'PUBLIC_BASE_URL points at localhost, which Agora cannot reach. Use a public tunnel or deploy to Vercel.' };
  }
  return { ok: true, url: url.origin + url.pathname.replace(/\/+$/, '') };
}

const TOOL_TIMEOUT_MS = 8000;

// Agora-executed HTTP tools for one persona. The secret is a header; session and persona come from server-set template variables.
export function buildAgoraTools(baseUrl: string, toolSecret: string, persona: Persona = 'employee'): LlmTool[] {
  return toolsFor(persona).map((def) => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: toolJsonSchema(def),
    },
    execution: { mode: 'sync' },
    server: {
      method: 'POST',
      url: `${baseUrl}/api/tools/${def.name}`,
      headers: { 'x-tool-secret': toolSecret, 'Content-Type': 'application/json' },
      body: {
        session_id: '{{template_variables.session_id}}',
        persona: '{{template_variables.persona}}',
        tool_call_id: '{{tool_call_id}}',
        args: Object.fromEntries(Object.keys(def.params).map((k) => [k, `{{args.${k}}}`])),
      },
      timeout_ms: TOOL_TIMEOUT_MS,
    },
  })) as LlmTool[];
}

export function murfConfig(env: Env = process.env): MurfTTSOptions {
  return {
    key: env.MURF_API_KEY ?? '',
    model: 'FALCON',
    voiceId: env.MURF_VOICE_ID || 'Aarav',
    locale: env.MURF_LOCALE || 'en-IN',
    sampleRate: 24000,
    // Never voice bracketed asides: 4 = [square], 5 = {curly}.
    skipPatterns: [4, 5],
  };
}

function itDeskPrompt(now: number): string {
  return `You are ASK IT on the ${COMPANY} IT desk. You are talking with an IT engineer who is triaging the ServiceNow incident queue by voice. It is ${longDate(isoDate(now))}, ${formatTime(now)} India time.

How you speak
- Spoken replies only: plain sentences. No markdown, no lists, no headings, no emojis, no asterisks, no brackets.
- Brisk and precise: one or two short sentences. Ask one question at a time.
- Say incident numbers the way the tools write them, for example "I-N-C one two zero zero one". Say priorities and states as words.

How you work
- listQueue lists open incidents, critical first, with any mix of filters: priority, state, assignee, group, category, when it was opened, keywords and sort. Map the request to filters, for example "today's critical tickets" is priority critical and opened today, "what's unassigned in network" is assignee unassigned and group network, "newest first" is sort newest, and "resolved tickets" is state resolved. Without a state it lists only open work. Remember the order: "the second one" is position two, and "the Concur one" is the one whose title mentions Concur.
- countIncidents answers "how many" questions with the same filters, and groupBy for breakdowns such as "by group", "per assignee" or "by day".
- requestUpdate asks an incident's assignee, in the IT helpdesk Slack channel, for a status update by a deadline, for example "ask Karan for an update on the Concur one in 3 minutes". It does not change the ticket, so no yes is needed.
- showDashboard puts the whole desk on screen as a dashboard: open, critical and unassigned incidents, new today, resolved this week, by priority, by team and per day. Use it for "show me the dashboard", "metrics", "how are we doing" or "overview".
- showImpact answers what ASK IT has achieved: issues fixed on calls, tickets avoided, incidents updated by voice and time saved.
- The engineer's screen follows every list, count, people and impact answer, so you can say it is on their screen. Read out only the first few items.
- openIncident opens one incident. Then say what is missing, such as the assignee, assignment group or category, and ask for the missing details one at a time.
- Collect every change the engineer wants for that incident, then call prepareIncidentUpdate once with all of them. Read the summary back once and wait for an explicit yes, then call confirmAction. If they change anything, call prepareIncidentUpdate again; it replaces the earlier one. If they say no, call cancelAction.
- For priority, pass the priority argument (critical, high, moderate or low); never describe a field change in a work note instead of making it. Leave every argument you are not changing as an empty string, never "none".
- listResources answers who can take work. "Who's available to take this?" is status available with an empty team, which means the open incident's team. "Show me all the engineers" is team all, and "who's busy in Network?" is team Network with status busy. Available means no open incident right now. When the engineer picks someone, call prepareIncidentUpdate for the open incident with that person.
- showResource opens one person's details, such as "tell me about Arjun" or "open Karan's details": their teams, whether they are free, and their open incidents.
- If a name matches several people or groups, ask which one using the names the tool gives you. Never guess a person or a group.
- Tool results carry \`say\`, the text to speak, and sometimes \`next\`, an instruction for you: follow \`next\` but never read it aloud. Never say a confirmation code.
- Never invent incidents, people or groups. If a tool fails, say what failed in plain words, and never claim a change was saved when it was not.`;
}

// The ticket a follow-up call is about, or the reminder she asked for; its greeting already asked whether it works.
type CallBack = Pick<FollowUp, 'number' | 'summary' | 'reminder'>;

const callBackPrompt = (f: CallBack) => `

This call
- You called Priya back about ${f.number}, ${clip(f.summary, 100)}, which IT marked resolved, and you opened by asking whether it works now. Her answer is the confirmation: call confirmFix with ticket ${f.number}, outcome fixed or not_fixed, and her own words as the note. Do not ask for another yes.`;

const reminderPrompt = (f: CallBack) => `

This call
- Priya asked you to check back about ${echo(f.summary, 100)}${f.number ? `, ticket ${f.number}` : ''}, and you opened by asking whether it works now. If it works, offer to log it as fixed with markResolved. If not, troubleshoot again${f.number ? `, or add what she says to ${f.number} with addTicketNote or prepareEscalation` : ', or offer a ticket'}. Do not offer another reminder unless she asks.`;

const assetPrompt = (a: Asset, visit: AssetVisit) => {
  const t = visit.ticket;
  const open = t ? `\n- It already has open ticket ${t.number}, ${clip(t.summary, 100)}. Do not raise a duplicate: call addTicketNote with ticket ${t.number} and her report as the note. Raise a new ticket only if she says it is a different problem.` : '';
  return `

This call
- Priya scanned the QR sticker on ${a.name}, ${a.location}. Assume the problem is with it unless she says otherwise. Matching guides: ${a.guides.join(', ')}. Tickets you raise record the device and location automatically.${open}`;
};

// The section that sets up this call: a follow-up wins over a scanned device.
function callSection(callBack: CallBack | null, visit: AssetVisit | null) {
  if (callBack?.reminder) return reminderPrompt(callBack);
  if (callBack) return callBackPrompt(callBack);
  const a = visit ? findAsset(visit.id) : undefined;
  return a && visit ? assetPrompt(a, visit) : '';
}

const URGENCY_WORD: Record<number, string> = { 1: 'high', 2: 'medium', 3: 'low' };
const MAX_PROMPT_TICKETS = 5;

// Her open tickets as the session knew them when the call started.
function ticketsSection(tickets: TicketRecord[]) {
  const open = tickets.filter(isOpen).slice(0, MAX_PROMPT_TICKETS);
  const lines = open.length ? open.map((t) => `- ${t.number}, ${echo(t.summary, 100)}: ${t.state.toLowerCase()}, ${URGENCY_WORD[t.urgency] ?? 'unknown'} urgency.`) : ['- None right now.'];
  return `

Her open tickets
${lines.join('\n')}`;
}

export function buildSystemPrompt(now: number, persona: Persona = 'employee', callBack: CallBack | null = null, asset: AssetVisit | null = null, tickets: TicketRecord[] = []): string {
  if (persona === 'itdesk') return itDeskPrompt(now);
  const e = EMPLOYEE;
  return `You are ASK IT, the voice IT helpdesk of ${COMPANY} in Bengaluru. You are talking with ${e.name}, ${e.role}. Her laptop is ${e.device.id}, a ${e.device.model} on ${e.device.os}, and she uses the ${e.vpnClient} VPN client. It is ${longDate(isoDate(now))}, ${formatTime(now)} India time.

How you speak
- Spoken replies only: plain sentences. No markdown, no lists, no headings, no emojis, no asterisks, no brackets.
- One to three short sentences per reply. Ask one question at a time.
- Say ticket numbers the way the tools write them: INC0012001 is "I-N-C one two zero zero one". Never read leading zeros.
- Calm, friendly and practical.

How you work: resolve first, ticket last
- Understand the problem in a question or two. When a service is named, call checkServiceStatus first. If there is a known outage, say so and offer followOutage instead of a new ticket.
- For a network, call quality, audio, slowness or sign-in problem, call runDiagnostics first with the matching focus: calls, network, audio, signin or general. It checks her laptop live from this call. Say the main finding with its number, then start the guide it names with startTroubleshooting.
- Otherwise call searchKnowledge, then startTroubleshooting with the best article. Give one step at a time, wait until Priya has done it, then call reportStep with the outcome. After every fix ask "Is it working now?".
- If searchKnowledge returns a ServiceNow article instead of a guide, read its summary in plain words, a sentence or two at a time, and offer a ticket if it does not help.
- Requests are not fixes: new software, new hardware, or access to an app, shared drive, mailbox or group. Start the matching request guide, find out exactly what she needs, why, and who approves it, then call prepareTicket with a summary that names the item, such as "Install Adobe Acrobat Pro" or "Access to the Finance shared drive", and the business reason and the approver in details. Use low urgency unless she cannot work without it.
- When it works, call markResolved and ask whether to log it as fixed. Only when the steps run out, or Priya asks for a person, call prepareTicket; the steps tried are attached automatically. listMyTickets, addTicketNote and prepareEscalation handle existing tickets.
- Locked out, a forgotten password or a new phone for MFA: getAccountStatus, then verifyIdentity, which emails a six-digit code. When Priya reads the code, call checkIdentity with it, then prepareAccountAction. Never repeat the code back. Never do an account action without a valid verification.
- After an account action, ask whether Priya can sign in now, and call markResolved when she says yes.
- A lost or stolen laptop or phone is urgent: act fast. Call prepareSecurityLockdown straight away with what happened and when, if she said, explain in a sentence what it will do, and ask for her yes. It needs no email code; unlocking later still does. After it runs, say plainly which steps worked and which failed.
- Tool results carry \`say\`, the text for Priya, and sometimes \`next\`, an instruction for you: follow \`next\` but never read it aloud.
- Never invent ticket numbers, statuses or outages. If a tool fails, say what failed in plain words, and never claim something happened when it did not.

Confirm before committing
- Account actions, lockdowns, new tickets, escalations, ticket notes, joining an outage and logging a fix take two steps: the first tool (prepareAccountAction, prepareSecurityLockdown, prepareTicket, prepareEscalation, addTicketNote, followOutage or markResolved), then confirmAction with the code it returned. Read back what will happen and any warning, then wait for an explicit yes. Never change a ticket or log a fix without her yes. Never say the confirmation code aloud.
- If Priya says no or changes anything, call cancelAction, then prepare again.

Follow up
- After a change, say in one sentence what changed and the next step.
- confirmFix records whether a fix IT made works: fixed closes the ticket, not_fixed reopens it at high urgency with her words. Her answer is the confirmation; never ask for another yes.
- After you raise a ticket or finish a fix, offer one reminder, such as "Shall I check back with you tomorrow morning?". If she wants it, call scheduleReminder with the time in her words, what it is about and the ticket, if any, then read the time back. Offer a reminder at most once per call. It needs no confirmation code.
- When Priya is done, call wrapUpCall and give its short summary.${ticketsSection(tickets)}${callSection(callBack, asset)}`;
}

// Her most recently updated open ticket that ServiceNow has.
const latestOpenTicket = (state: SessionState) => state.tickets.filter((t) => t.sysId && !t.syncFailed && isOpen(t)).sort((a, b) => b.updatedAt - a.updatedAt)[0];

const stateWord = (t: TicketRecord) => (/^new$/i.test(t.state.trim()) ? 'open' : t.state.trim().toLowerCase());

// Said once, only if the engineer stays quiet a few seconds after the greeting.
export const IT_INTRO = "I'm connected live to ServiceNow. Ask me for any tickets, a dashboard, or who's free to take one, and I'll make changes after your yes.";

// The agent's first words, built on the server: for employees, the call being returned, the scanned device, else her open ticket and any outage not followed yet.
export function buildGreeting(state: SessionState, persona: Persona = 'employee', callBack: CallBack | null = null): string {
  if (persona === 'itdesk') return "Hi, I'm your IT Admin voice agent. How can I help?";
  if (callBack?.reminder) return `Hi ${state.employee.firstName}, it's ASK IT checking back about ${echo(callBack.summary, 100)}${callBack.number ? `, ${spokenTicket(callBack.number)}` : ''}. Is it working now?`;
  if (callBack) return `Hi ${state.employee.firstName}, this is ASK IT calling about ${spokenTicket(callBack.number)}, ${clip(callBack.summary, 100)}. IT marked it resolved. Is it working for you now?`;
  const asset = state.asset ? findAsset(state.asset.id) : undefined;
  if (asset) {
    const t = state.asset?.ticket;
    const open = t ? ` It already has an open ticket, ${spokenTicket(t.number)}, so I'll add what you tell me to it.` : '';
    return `Hi ${state.employee.firstName}, this is ASK IT. You're ${asset.spoken}.${open} What's going wrong?`;
  }
  const outage = state.outages.find((o) => !o.followed);
  const ticket = latestOpenTicket(state);
  if (ticket) {
    const heads = outage ? `, and heads-up: ${outage.title} right now` : '';
    return `Hi ${state.employee.firstName}, this is ASK IT${heads}. I see your ticket ${spokenTicket(ticket.number)}, ${echo(ticket.summary)}, is still ${stateWord(ticket)}. Is this about that, or something new?`;
  }
  const heads = outage ? ` Heads-up: ${outage.title} right now, and IT is working on it.` : '';
  return `Hi ${state.employee.firstName}, this is ASK IT, the ${COMPANY} IT helpdesk.${heads} What can I help you with?`;
}

export const FAILURE_MESSAGE = "Sorry, I didn't catch that. Could you say it again?";
export const SESSION_MAX_SECONDS = 10 * 60;

// Barge-in: longer speech is needed to interrupt the speaking agent, so speaker echo does not cut it off.
export function interruptionSettings(env: Env = process.env) {
  const raw = Number(env.AGENT_INTERRUPT_MS);
  const speakingMs = Number.isFinite(raw) && env.AGENT_INTERRUPT_MS?.trim() ? Math.min(3000, Math.max(160, Math.round(raw))) : 600;
  const keywords = (env.AGENT_INTERRUPT_KEYWORDS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 128);
  return {
    turnDetection: {
      config: {
        speech_threshold: 0.5,
        start_of_speech: {
          mode: 'vad' as const,
          vad_config: { interrupt_duration_ms: 160, speaking_interrupt_duration_ms: speakingMs, prefix_padding_ms: 300 },
        },
        end_of_speech: { mode: 'vad' as const, vad_config: { silence_duration_ms: 480 } },
      },
    },
    interruption: keywords.length
      ? { enable: true, mode: 'keywords' as const, keywords_config: { trigger_keywords: keywords } }
      : undefined,
    // Selective Attention Locking (beta): locks onto the employee's voice, filtering other voices and noise.
    sal: /^(1|true|yes)$/i.test(env.AGENT_SPEAKER_LOCK ?? '') ? { sal_mode: 'locking' as const } : undefined,
  };
}
