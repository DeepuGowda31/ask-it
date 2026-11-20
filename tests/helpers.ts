import { createSessionState } from '@/lib/domain/seed';
import type { SeedOptions } from '@/lib/domain/seed';
import { zonedTime } from '@/lib/domain/time';

// Wednesday 18 Nov 2026, 9:30 AM IST.
export const NOW = zonedTime('2026-11-18', 9 * 60 + 30);

export const freshState = (now = NOW, seed: SeedOptions = { tickets: 'simulated' }) => createSessionState('NMB-7K2', now, seed);

import { expect, vi } from 'vitest';
import { beginTool, computeEffect, runTool } from '@/lib/domain/tools';
import type { Deps } from '@/lib/domain/tools/shared';
import { SimulatedDesk, SimulatedIdentity, SimulatedTickets } from '@/lib/integrations/simulated';
import { SimulatedKnowledge } from '@/lib/integrations/servicenow-kb';
import type { LiveStatus } from '@/lib/integrations/types';
import type { SessionState } from '@/lib/domain/types';

const OPERATIONAL: LiveStatus = { level: 'operational', summary: 'All Systems Operational', incidents: [] };

interface Overrides {
  tickets?: Partial<Deps['tickets']>;
  identity?: Partial<Deps['identity']>;
  desk?: Partial<Deps['desk']>;
  knowledge?: Partial<Deps['knowledge']>;
  status?: Deps['status'];
  notifyMode?: Deps['notifyMode'];
  code?: string;
}

// Simulated deps over `state`, with any adapter methods replaced.
export function makeDeps(state: SessionState, now: number, o: Overrides = {}): Deps {
  const tickets = new SimulatedTickets(state);
  const identity = new SimulatedIdentity(state, () => Number(o.code ?? '421987'));
  return {
    tickets: Object.assign(tickets, o.tickets),
    identity: Object.assign(identity, o.identity),
    desk: Object.assign(new SimulatedDesk(state, now), o.desk),
    knowledge: Object.assign(new SimulatedKnowledge(), o.knowledge),
    status: o.status ?? { check: vi.fn(async () => OPERATIONAL) },
    notifyMode: o.notifyMode ?? 'simulated',
  };
}

// Runs a tool the way the server does: claim, then the effect once, then the pure reducer.
// `reload` stands in for the stored session the effect polls and the reducer then reads.
export async function call(state: SessionState, name: string, args: Record<string, unknown> = {}, o: Overrides & { now?: number; claim?: string; reload?: () => Promise<SessionState> } = {}) {
  const now = o.now ?? NOW;
  const claim = o.claim ?? `claim-${Math.random()}`;
  const begun = beginTool(name, state, args, now, claim) ?? state;
  const effect = await computeEffect(name, begun, args, now, makeDeps(begun, now, o), claim, o.reload);
  const out = runTool(name, o.reload ? await o.reload() : begun, args, now, effect, claim);
  expect(out.result.say, 'say must be speakable').toSatisfy(speakable);
  return out;
}

export const codeOf = (result: { data?: unknown }) => (result.data as { confirmationCode: string }).confirmationCode;

// A two-step tool as the agent runs it: prepare, then confirmAction with its code, both with the same overrides.
export async function confirmed(state: SessionState, name: string, args: Record<string, unknown> = {}, o: Parameters<typeof call>[3] = {}) {
  const prep = await call(state, name, args, o);
  const code = (prep.result.data as { confirmationCode?: string } | undefined)?.confirmationCode;
  return code ? call(prep.state, 'confirmAction', { code }, o) : prep;
}

// Text the employee hears: never tool names, brackets or status codes.
const TOOL_NAME = /\b(listQueue|requestUpdate|countIncidents|showDashboard|showImpact|openIncident|prepareIncidentUpdate|checkServiceStatus|followOutage|searchKnowledge|startTroubleshooting|reportStep|markResolved|verifyIdentity|checkIdentity|getAccountStatus|prepareAccountAction|prepareSecurityLockdown|prepareTicket|listMyTickets|addTicketNote|prepareEscalation|confirmAction|cancelAction|wrapUpCall|confirmFix|runDiagnostics|listResources|showResource|scheduleReminder)\b/;
function speakable(say: string) {
  return !TOOL_NAME.test(say) && !/[()[\]{}]|HTTP|\b[45]\d\d\b/.test(say);
}
