import type { Result } from '@/lib/integrations/http';
import type { KbArticle } from '@/lib/integrations/servicenow-kb';
import type { LiveStatus, NewTicket } from '@/lib/integrations/types';
import { issueMilestone } from '../cards';
import { ARTICLES, findArticle, type Article } from '../kb';
import { confident, rankKnowledge, searchKnowledge, tokenize } from '../search';
import { SERVICES, findService, outageName } from '../services';
import { clip, echo, parseTicketNumber, spokenTicket, ticketDescription } from '../tickets';
import type { Outage, SessionState } from '../types';
import { failed, ok, plural, prepare, tool, type Outcome } from './shared';

const SERVICE_NAMES = SERVICES.map((s) => s.name.replace(/^the /, ''));

function liveSay(name: string, live: LiveStatus): string {
  const first = live.incidents[0] ?? live.summary;
  switch (live.level) {
    case 'operational':
      return `${name} reports no issues right now, so the problem is probably on your side. Let's troubleshoot.`;
    case 'maintenance':
      return `${name} is under planned maintenance right now${live.incidents[0] ? `: ${live.incidents[0]}` : ''}. It should come back on its own.`;
    case 'unknown':
      return `I couldn't reach the ${name} status page just now, so I can't confirm whether it's up.`;
    default:
      return `${name} has a reported problem: ${first}. It's on their side, so there's nothing to fix on your laptop. I'd wait for their update.`;
  }
}

function outageSay(o: Outage): string {
  const follow = o.followed ? "You're already on that incident, so you'll get updates." : 'I can add you to that incident instead of raising a duplicate ticket.';
  const affected = o.affected === null ? '' : `, with ${o.affected} people affected`;
  return `Yes, there's a known outage: ${o.title}. IT is tracking it as ${spokenTicket(o.incident)}${affected}. ${follow}`;
}

const checkServiceStatus = tool<LiveStatus>({
  name: 'checkServiceStatus',
  description:
    'Check for a known outage before troubleshooting. Internal systems (VPN, office Wi-Fi, Outlook and email, SAP Concur, printers) come from the IT outage board. GitHub, Jira, Confluence, Slack, Gmail, Google Meet, Google Drive, Dropbox, Figma and ChatGPT come from their live public status pages.',
  params: { service: { description: 'Service name, e.g. VPN, Wi-Fi, Outlook, SAP Concur, GitHub, Slack, Gmail' } },
  minutesSaved: 2,
  async effect({ deps }, args) {
    const feed = findService(args.service)?.feed;
    return feed ? deps.status.check(feed) : undefined;
  },
  run({ state, effect }, args) {
    const service = findService(args.service);
    if (!service) {
      return failed(`Status: unknown service "${args.service}"`, 'unknown_service', `I don't have a status feed for ${echo(args.service)}. I can check ${SERVICE_NAMES.join(', ')}.`, SERVICE_NAMES);
    }
    const name = service.name;
    if (!service.feed) {
      const outage = state.outages.find((o) => o.service === service.key);
      if (outage) {
        const next = outage.followed ? undefined : 'If she wants to be added, call followOutage now; its read-back is the only yes to ask for.';
        return { title: `Status: ${outage.title}`, result: ok(outageSay(outage), { service: name, level: 'outage', source: 'internal', incident: outage.incident, affected: outage.affected, followed: outage.followed }, next) };
      }
      return { title: `Status: ${name} · no known issues`, result: ok(`There are no known issues with ${name} right now, so let's troubleshoot on your side.`, { service: name, level: 'operational', source: 'internal' }) };
    }
    const live = effect ?? { level: 'unknown', summary: '', incidents: [] };
    return { title: `Status: ${name} · ${live.level}`, result: ok(liveSay(name, live), { service: name, source: 'live', ...live }) };
  },
});

function findOutage(state: SessionState, raw: string): Outage | undefined {
  const q = raw.trim();
  if (!q) return state.outages.length === 1 ? state.outages[0] : undefined;
  const number = parseTicketNumber(q);
  const byNumber = number ? state.outages.find((o) => o.incident === number) : undefined;
  const service = findService(q);
  return byNumber ?? (service ? state.outages.find((o) => o.service === service.key) : undefined);
}

const followOutage = tool({
  name: 'followOutage',
  description:
    'Step 1 of adding Priya as affected to the master incident of a known outage, instead of raising a duplicate ticket; she then gets updates when it is fixed. Reads the outage back and returns a confirmation code: ask for her yes, then call confirmAction.',
  params: { incident: { description: 'Master incident like INC0011950, the service name, or empty string for the current outage', allowEmpty: true } },
  run({ state, now }, args) {
    const outage = findOutage(state, args.incident);
    if (!outage) {
      const known = state.outages.map((o) => `${o.title}, ${spokenTicket(o.incident)}`).join('; ');
      return failed('Follow outage: not found', 'unknown_outage', `I can't find an active outage matching that. ${known ? `Current outages: ${known}.` : 'There are no active outages.'}`);
    }
    const spoken = spokenTicket(outage.incident);
    if (outage.followed) return { title: `Already following ${outage.incident}`, result: ok(`You're already on ${spoken}, so you'll get an update when it's fixed.`, { alreadyFollowing: true }) };
    const lead = `Shall I add you to the ${outageName(outage).replace(/^the /, '')} outage, ${spoken}, as affected?`;
    return prepare(state, now, { kind: 'outage', incident: outage.incident }, `Join outage ${outage.incident} as affected: ${outage.title}`, [], lead);
  },
});

// Brackets are never voiced, so they are dropped from titles read out.
const spokenTitles = (kb: KbArticle[]) => kb.map((a) => `"${a.title.replace(/[()[\]{}]/g, '').replace(/\s+/g, ' ').trim()}"`).join('; ');
const READ_ARTICLE = 'To use a ServiceNow article, read its summary to Priya in plain words, a sentence or two at a time.';

const searchKnowledgeTool = tool<Result<KbArticle[]>>({
  name: 'searchKnowledge',
  description:
    'Search the IT knowledge base of guided fixes for a MacBook: network and VPN, sign-in and MFA, Outlook and shared mailboxes, meeting audio, video and screen sharing, monitors, docks, Bluetooth and printers, slow or hot laptops, disk and battery, Microsoft 365, OneDrive, SharePoint and Slack, phishing, and requests for software, hardware or access. When no guide fits well, ServiceNow knowledge articles are added.',
  params: { query: { description: 'The problem in a few words, e.g. "vpn keeps dropping"' } },
  minutesSaved: 1,
  async effect({ deps }, args) {
    return confident(rankKnowledge(args.query)[0]) ? undefined : deps.knowledge.search(tokenize(args.query).join(' '));
  },
  run({ effect }, args) {
    const hits = rankKnowledge(args.query).map((h) => h.article);
    const kb = effect?.ok ? effect.value.slice(0, 2) : [];
    const serviceNow = kb.length ? { serviceNow: kb } : {};
    const found = kb.length === 1 ? 'an article' : 'two articles';
    if (!hits.length && kb.length) {
      return {
        title: `Knowledge: ServiceNow ${kb[0].number}`,
        result: ok(`I don't have a guided fix for that, but ServiceNow has ${found}: ${spokenTitles(kb)}. Shall I read it to you?`, { articles: [], ...serviceNow }, `${READ_ARTICLE} If it does not help, offer prepareTicket.`),
      };
    }
    if (!hits.length) return failed(`Knowledge: nothing for "${args.query}"`, 'no_results', "I couldn't find a guide for that. Tell me a bit more, or I can raise a ticket.");
    const [top, ...rest] = hits;
    const others = rest.length ? ` Also possible: ${rest.map((a) => a.title).join('; ')}.` : '';
    const articles = hits.map((a) => ({ id: a.id, title: a.title, steps: a.steps.length }));
    if (kb.length) {
      return {
        title: `Knowledge: ${top.title} · ServiceNow ${kb[0].number}`,
        result: ok(
          `ServiceNow has ${found} that may fit: ${spokenTitles(kb)}. I also have a guide, "${top.title}". Which sounds closer to your problem?`,
          { articles, ...serviceNow },
          `If a guide fits, call startTroubleshooting with its id. ${READ_ARTICLE}`,
        ),
      };
    }
    return {
      title: `Knowledge: ${top.title}`,
      result: ok(
        `Best match: "${top.title}", ${plural(top.steps.length, 'step')}.${others} Shall we go through it step by step?`,
        { articles },
        'If it fits, call startTroubleshooting with its id.',
      ),
    };
  },
});

const stepSay = (a: Article, i: number) => `Step ${i + 1} of ${a.steps.length}: ${a.steps[i].text} ${a.steps[i].check}`;

const startTroubleshooting = tool({
  name: 'startTroubleshooting',
  description: 'Start a guided fix from a knowledge base article. Returns step 1; give one step at a time and report each with reportStep.',
  params: {
    articleId: { description: `Article id from searchKnowledge: ${ARTICLES.map((a) => a.id).join(', ')}` },
    issue: { description: "Priya's problem in her words, or empty string", allowEmpty: true },
  },
  run({ state, now }, args) {
    const article = findArticle(args.articleId);
    if (!article) {
      const close = searchKnowledge(`${args.issue} ${args.articleId}`);
      const hint = close.length ? ` The closest is "${close[0].title}". Shall I use that?` : '';
      const next = close.length ? `If she agrees, call startTroubleshooting with articleId ${close[0].id}.` : undefined;
      return failed(`Guided fix: unknown article "${args.articleId}"`, 'unknown_article', `I don't have that guide.${hint}`, close.map((a) => a.id), next);
    }
    state.troubleshooting = { articleId: article.id, title: article.title, issue: args.issue || article.title, stepIndex: 0, status: 'active', startedAt: now, log: [] };
    const alert = issueMilestone(state, now, 'in_progress', `Guided fix started: ${article.title}`, { title: args.issue || article.title, fresh: true });
    return { title: `Guided fix started: ${article.title}`, alerts: [alert], result: ok(stepSay(article, 0), { articleId: article.id, step: 1, of: article.steps.length }) };
  },
});

const reportStep = tool({
  name: 'reportStep',
  description: 'Report how the current guided-fix step went: fixed (problem solved), not_fixed (did it, still broken), done (step completed), skipped. Returns the next step, or says the steps ran out.',
  params: {
    outcome: { description: 'fixed, not_fixed, done or skipped', enum: ['fixed', 'not_fixed', 'done', 'skipped'] },
    note: { description: 'What Priya saw, or empty string', allowEmpty: true },
  },
  run({ state, now }, args) {
    const t = state.troubleshooting;
    const article = t ? findArticle(t.articleId) : undefined;
    if (!t || !article || t.status === 'resolved' || t.status === 'ticketed') {
      return failed('Step report: no guided fix running', 'no_troubleshooting', "We haven't started a guided fix. Tell me what's wrong and I'll find the right steps.");
    }
    if (t.status === 'fixed') return failed('Step report: already fixed', 'already_fixed', 'We already found the fix.', undefined, 'Call markResolved, or startTroubleshooting again if it broke.');
    if (t.status === 'exhausted') {
      return failed('Step report: no steps left', 'steps_finished', "We've already tried every step in this guide. Shall I raise a ticket with what we tried?", ['prepareTicket'], 'If she agrees, call prepareTicket.');
    }
    const outcome = args.outcome as 'fixed' | 'not_fixed' | 'done' | 'skipped';
    const i = t.stepIndex;
    t.log.push({ step: i + 1, text: article.steps[i].text, outcome, note: args.note, at: now });
    const title = `Step ${i + 1} ${outcome.replace('_', ' ')} · ${t.title}`;
    if (outcome === 'fixed') {
      t.status = 'fixed';
      return { title, result: ok("Great, glad it's working.", { fixed: true }, "Call markResolved with a one-line summary, then ask if there's anything else.") };
    }
    if (i + 1 >= article.steps.length) {
      t.status = 'exhausted';
      return {
        title,
        result: ok("That was the last step in the guide, and it's still not fixed. I can raise a ticket with everything we tried. Shall I?", { exhausted: true }, 'If she agrees, call prepareTicket; the steps tried are attached automatically.'),
      };
    }
    t.stepIndex = i + 1;
    return { title, result: ok(stepSay(article, i + 1), { step: i + 2, of: article.steps.length }) };
  },
});

// One resolution per guided fix, or per summary when there was none.
function resolutionKey(state: SessionState, summary: string): string {
  const t = state.troubleshooting;
  if (t && t.status !== 'ticketed') return `fix:${t.startedAt}`;
  return `note:${summary.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

function resolvedTicket(state: SessionState, summary: string, now: number): Omit<NewTicket, 'correlationId'> {
  const t = state.troubleshooting;
  return {
    shortDescription: `Resolved by ASK IT: ${summary}`.slice(0, 160),
    description: ticketDescription(state, t, `Resolution: ${summary}`, now),
    urgency: 3,
    impact: 3,
    category: (t && findArticle(t.articleId)?.category) || 'inquiry',
  };
}

const markResolved = tool({
  name: 'markResolved',
  description:
    'Step 1 of logging the issue as resolved by ASK IT once Priya says it works: on her yes, confirmAction creates a resolved incident in ServiceNow so the fix counts without an open ticket. The same resolution is logged once. Returns a confirmation code for confirmAction.',
  params: { summary: { description: 'One sentence: what was wrong and what fixed it' } },
  run({ state, now }, args): Outcome {
    const key = resolutionKey(state, args.summary);
    const last = state.lastResolution;
    if (last?.key === key && last.status === 'done') return { title: 'Already logged as resolved', result: ok("That's already logged as resolved, nothing changed.", { alreadyResolved: true, number: last.number }) };
    const payload = { kind: 'resolution' as const, key, summary: args.summary, ticket: resolvedTicket(state, args.summary, now) };
    return prepare(state, now, payload, `Log as fixed by ASK IT: ${clip(args.summary, 120)}`, [], `Shall I log this as fixed on the call: ${echo(args.summary, 120)}?`);
  },
});

export const SUPPORT_TOOLS = [checkServiceStatus, followOutage, searchKnowledgeTool, startTroubleshooting, reportStep, markResolved];

