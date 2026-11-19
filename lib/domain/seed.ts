import type { Mode } from '@/lib/integrations/types';
import { EMPLOYEE } from './company';
import { seedBacklog } from './desk-seed';
import { DAY, MINUTE } from './time';
import type { Outage, SessionState, TicketRecord } from './types';

export interface SeedOptions {
  tickets: Mode;
  // Real master incident for the internal outage in live mode.
  outageIncident?: string;
}

const simTickets = (now: number): TicketRecord[] => [
  { number: 'INC0011994', sysId: 'sim-INC0011994', summary: 'Figma licence request', state: 'In Progress', urgency: 3, source: 'simulated', createdAt: now - 2 * DAY, updatedAt: now - DAY },
  { number: 'INC0011987', sysId: 'sim-INC0011987', summary: 'Outlook calendar not syncing', state: 'Resolved', urgency: 3, source: 'simulated', createdAt: now - 6 * DAY, updatedAt: now - 5 * DAY },
];

const concurOutage = (incident: string, now: number): Outage => ({ id: 'OUT-1', service: 'concur', title: 'SAP Concur expense submissions failing', incident, affected: 14, since: now - 95 * MINUTE, followed: false });

// Live mode never gets simulated tickets; the outage only exists there when a real incident backs it.
function outagesFor(seed: SeedOptions, now: number): Outage[] {
  if (seed.tickets === 'simulated') return [concurOutage('INC0011950', now)];
  return seed.outageIncident && /^INC\d{7}$/.test(seed.outageIncident) ? [concurOutage(seed.outageIncident, now)] : [];
}

// Fictional demo data. Each session gets its own copy, so several demos can run at once.
export function createSessionState(id: string, now: number, seed: SeedOptions = { tickets: 'simulated' }): SessionState {
  return {
    id,
    createdAt: now,
    employee: structuredClone(EMPLOYEE),
    account: {
      email: EMPLOYEE.email,
      userId: 'auth0|sim-priya',
      // Locked so the unlock story works in simulated mode.
      locked: true,
      lastPasswordReset: now - 83 * DAY,
      factors: ['otp'],
      factorsKnown: true,
      source: 'simulated',
      checkedAt: null,
    },
    verification: { status: 'none', sentAt: null, approvedAt: null, expiresAt: null, attempts: 0, checking: [], simulatedCode: null },
    troubleshooting: null,
    lastResolution: null,
    issue: null,
    lockdown: null,
    diagnostics: null,
    followUp: null,
    itdesk: { queue: [], current: null, lastUpdate: null, board: null, backlog: seed.tickets === 'simulated' ? seedBacklog(now) : [] },
    tickets: seed.tickets === 'simulated' ? simTickets(now) : [],
    outages: outagesFor(seed, now),
    pending: [],
    documents: [],
    notifications: [],
    events: [],
    metrics: { resolvedByAgent: 0, ticketsRaised: 0, duplicatesAvoided: 0, accountActions: 0, ticketsUpdatedByVoice: 0, minutesSaved: 0 },
    call: { active: false },
    seq: 0,
    counter: 100,
  };
}
