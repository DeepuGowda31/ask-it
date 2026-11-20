import type { Mode } from '@/lib/integrations/types';
import { EMPLOYEE } from './company';
import { seedBacklog } from './desk-seed';
import { DAY, MINUTE } from './time';
import type { Outage, SessionState, TicketRecord } from './types';

export interface SeedOptions {
  tickets: Mode;
  // Set when Auth0 is live: the account starts unknown and is read from Auth0.
  liveIdentity?: { email: string };
}

const simTickets = (now: number): TicketRecord[] => [
  { number: 'INC0011994', sysId: 'sim-INC0011994', summary: 'Figma licence request', state: 'In Progress', urgency: 3, source: 'simulated', createdAt: now - 2 * DAY, updatedAt: now - DAY },
  { number: 'INC0011987', sysId: 'sim-INC0011987', summary: 'Outlook calendar not syncing', state: 'Resolved', urgency: 3, source: 'simulated', createdAt: now - 6 * DAY, updatedAt: now - 5 * DAY },
];

const simOutage = (now: number): Outage => ({ id: 'OUT-1', service: 'concur', title: 'SAP Concur expense submissions failing', incident: 'INC0011950', affected: 14, since: now - 95 * MINUTE, followed: false });

const simAccount = (now: number): SessionState['account'] => ({
  email: EMPLOYEE.email,
  userId: 'auth0|sim-priya',
  // Locked so the unlock story works in simulated mode.
  locked: true,
  lastPasswordReset: now - 83 * DAY,
  factors: ['otp'],
  factorsKnown: true,
  source: 'simulated',
  checkedAt: null,
});

const unknownAccount = (email: string): SessionState['account'] => ({ email, userId: null, locked: null, lastPasswordReset: null, factors: [], factorsKnown: false, source: 'live', checkedAt: null });

// Fictional demo data in simulated mode; live parts start empty or unknown. Each session gets its own copy, so several demos can run at once.
export function createSessionState(id: string, now: number, seed: SeedOptions = { tickets: 'simulated' }): SessionState {
  return {
    id,
    createdAt: now,
    employee: structuredClone(EMPLOYEE),
    account: seed.liveIdentity ? unknownAccount(seed.liveIdentity.email) : simAccount(now),
    verification: { status: 'none', sentAt: null, approvedAt: null, expiresAt: null, attempts: 0, checking: [], simulatedCode: null },
    troubleshooting: null,
    lastResolution: null,
    issue: null,
    lockdown: null,
    diagnostics: null,
    followUp: null,
    itdesk: { queue: [], current: null, lastUpdate: null, board: null, backlog: seed.tickets === 'simulated' ? seedBacklog(now) : [] },
    tickets: seed.tickets === 'simulated' ? simTickets(now) : [],
    // Live: the outage is read from its ServiceNow incident (lib/domain/sync.ts), never seeded.
    outages: seed.tickets === 'simulated' ? [simOutage(now)] : [],
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
