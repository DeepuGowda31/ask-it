import { Auth0Identity, auth0Config } from '@/lib/integrations/auth0';
import { createStatusChecker } from '@/lib/integrations/saas-status';
import { ServiceNowTickets, serviceNowConfig } from '@/lib/integrations/servicenow';
import { ServiceNowDesk, queueWindowDays } from '@/lib/integrations/servicenow-desk';
import { ServiceNowKnowledge, SimulatedKnowledge } from '@/lib/integrations/servicenow-kb';
import { SimulatedDesk, SimulatedIdentity, SimulatedTickets } from '@/lib/integrations/simulated';
import { slackConfig } from '@/lib/integrations/slack';
import type { StatusSource } from '@/lib/integrations/types';
import type { Deps } from '@/lib/domain/tools/shared';
import type { SeedOptions } from '@/lib/domain/seed';
import type { SessionState } from '@/lib/domain/types';
import type { Integrations } from '@/lib/domain/view';

type Env = Record<string, string | undefined>;

// All outbound calls of one tool run finish within this, well under Agora's 10 s tool timeout.
const EFFECT_BUDGET_MS = 6500;

export type DepsFactory = (state: SessionState, now: number) => Deps;

// A Slack bot or a webhook makes IT channel alerts live.
const hasWebhook = (env: Env) => Boolean(slackConfig(env) || env.DISCORD_WEBHOOK_URL?.trim() || env.SLACK_WEBHOOK_URL?.trim());

export function integrationModes(env: Env = process.env): Integrations {
  return {
    tickets: serviceNowConfig(env) ? 'live' : 'simulated',
    identity: auth0Config(env) ? 'live' : 'simulated',
    notify: hasWebhook(env) ? 'live' : 'simulated',
    status: 'live',
  };
}

// One checker per process so its cache is shared; it reads global fetch at call time.
function statusChecker(): StatusSource {
  const g = globalThis as typeof globalThis & { __askitStatus?: StatusSource };
  return (g.__askitStatus ??= createStatusChecker({ fetch: (input, init) => fetch(input, init) }));
}

export function buildDeps(state: SessionState, now: number, env: Env = process.env, fetchImpl: typeof fetch = fetch): Deps {
  const http = { fetch: fetchImpl, deadline: now + EFFECT_BUDGET_MS };
  const tickets = serviceNowConfig(env);
  const identity = auth0Config(env);
  return {
    tickets: tickets ? new ServiceNowTickets(tickets, http) : new SimulatedTickets(state),
    identity: identity ? new Auth0Identity(identity, http) : new SimulatedIdentity(state),
    desk: tickets ? new ServiceNowDesk(tickets, http, queueWindowDays(env)) : new SimulatedDesk(state),
    knowledge: tickets ? new ServiceNowKnowledge(tickets, http) : new SimulatedKnowledge(),
    status: statusChecker(),
    notifyMode: hasWebhook(env) ? 'live' : 'simulated',
  };
}

// Live ServiceNow never gets simulated tickets; its outage needs a real incident.
export function seedOptions(env: Env = process.env): SeedOptions {
  return { tickets: serviceNowConfig(env) ? 'live' : 'simulated', outageIncident: env.SERVICENOW_OUTAGE_INCIDENT?.trim() || undefined };
}
