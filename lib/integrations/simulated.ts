import { randomInt } from 'node:crypto';
import { DESK_GROUPS, DESK_MEMBERS, DESK_USERS, PRIORITY_LABELS, STATE_LABELS } from '@/lib/domain/desk-seed';
import { nextSimNumber } from '@/lib/domain/tickets';
import { matchesQuery, sortIncidents } from '@/lib/domain/queue-query';
import type { OpenIncident, SessionState } from '@/lib/domain/types';
import { failure, success } from './http';
import type { DeskAdapter, DeskIncident, IdentityAdapter, Level, NameMatch, OpenTicket, QueueQuery, RemoteTicket, Resource, TicketAdapter, TicketRef } from './types';

// Someone already reported the 3rd floor printer, so a scan there shows the duplicate path.
const OPEN_FOR_ASSET: Record<string, OpenTicket> = {
  'printer-3f': { number: 'INC0011962', sysId: 'sim-INC0011962', summary: 'Printer by the 3rd floor pantry jams on every page' },
};

// Stand-ins used when no ServiceNow or Auth0 credentials are set; their backend is the session state.

export class SimulatedTickets implements TicketAdapter {
  readonly mode = 'simulated';

  private created = new Set<string>();

  constructor(private state: SessionState) {}

  private known(ref: TicketRef) {
    return this.created.has(ref.number) || this.state.tickets.some((t) => t.number === ref.number && t.sysId !== null) || this.state.outages.some((o) => o.incident === ref.number) || this.state.asset?.ticket?.number === ref.number;
  }

  private touch(ref: TicketRef) {
    return Promise.resolve(this.known(ref) ? success(null) : failure<null>({ kind: 'not_found' }));
  }

  // Simulated creates never lose their answer.
  async find() {
    return success(null);
  }

  async create() {
    const number = nextSimNumber(this.state);
    this.created.add(number);
    return success({ number, sysId: `sim-${number}` });
  }

  async findOpenForAsset(assetId: string) {
    const visit = this.state.asset;
    return success(visit?.id === assetId && visit.ticket ? visit.ticket : (OPEN_FOR_ASSET[assetId] ?? null));
  }

  resolve(ref: TicketRef) {
    return this.touch(ref);
  }

  addNote(ref: TicketRef) {
    return this.touch(ref);
  }

  escalate(ref: TicketRef) {
    return this.touch(ref);
  }

  close(ref: TicketRef) {
    return this.touch(ref);
  }

  reopen(ref: TicketRef) {
    return this.touch(ref);
  }

  async listMine() {
    const mine = this.state.tickets.filter((t): t is typeof t & { sysId: string } => t.source === 'simulated' && t.sysId !== null);
    return success(mine.map((t): RemoteTicket => ({ number: t.number, sysId: t.sysId, summary: t.summary, state: t.state, urgency: t.urgency, createdAt: t.createdAt, updatedAt: t.updatedAt })));
  }
}

export class SimulatedIdentity implements IdentityAdapter {
  readonly mode = 'simulated';

  constructor(
    private state: SessionState,
    private random: () => number = () => randomInt(0, 1_000_000),
  ) {}

  async getUser() {
    const a = this.state.account;
    return success({ userId: a.userId ?? 'auth0|sim-priya', email: a.email, locked: a.locked, lastPasswordReset: a.lastPasswordReset, factors: a.factors, factorsKnown: a.factorsKnown });
  }

  async sendCode() {
    return success(String(this.random()).padStart(6, '0'));
  }

  async verifyCode(code: string) {
    return success(code === this.state.verification.simulatedCode);
  }

  async lifecycle() {
    return success(null);
  }

  async block() {
    return success(null);
  }

  async endSessions() {
    return success(null);
  }

  async revokeRefreshTokens() {
    return success(null);
  }
}

const nameIs = (match: NameMatch, name: string, q: string) => {
  const n = name.toLowerCase();
  return match === 'exact' ? n === q : match === 'starts' ? n.startsWith(q) : n.includes(q);
};

const plain = ({ notes: _notes, ...incident }: OpenIncident): DeskIncident => incident;

export class SimulatedDesk implements DeskAdapter {
  readonly mode = 'simulated';

  constructor(private state: SessionState) {}

  private open() {
    return this.state.itdesk.backlog.filter((i) => ['1', '2', '3'].includes(i.state)).sort((a, b) => a.priority - b.priority || (a.openedAt ?? 0) - (b.openedAt ?? 0));
  }

  async listOpen(query: QueueQuery, limit: number) {
    return success(sortIncidents(this.state.itdesk.backlog.filter((i) => matchesQuery(i, query)), query.sort).slice(0, limit).map(plain));
  }

  async get(number: string) {
    const hit = this.state.itdesk.backlog.find((i) => i.number === number);
    return success(hit ? plain(hit) : null);
  }

  async search(words: string[]) {
    return success(this.open().filter((i) => words.every((w) => i.summary.toLowerCase().includes(w))).slice(0, 5).map(plain));
  }

  async workNotes(sysId: string) {
    return success(this.state.itdesk.backlog.find((i) => i.sysId === sysId)?.notes.slice(0, 2) ?? []);
  }

  async findUsers(name: string, match: NameMatch) {
    return success(DESK_USERS.filter((u) => nameIs(match, u.name, name.toLowerCase())));
  }

  async findGroups(name: string) {
    return success(DESK_GROUPS.filter((g) => g.name.toLowerCase().includes(name.toLowerCase())));
  }

  async groupMembers(groupId: string) {
    const ids = DESK_MEMBERS[groupId] ?? [];
    return success(DESK_USERS.filter((u) => ids.includes(u.id)).sort((a, b) => a.name.localeCompare(b.name)));
  }

  // The simulated table keeps no resolution times, so only new incidents show in the daily bars.
  async activity(since: number) {
    return success({ opened: this.state.itdesk.backlog.map((i) => i.openedAt).filter((t): t is number => t !== null && t >= since), resolved: [] as number[] });
  }

  async roster(teams: readonly string[]) {
    const people = new Map<string, Resource>();
    for (const g of teams.flatMap((t) => DESK_GROUPS.filter((g) => g.name === t))) {
      for (const u of DESK_USERS.filter((u) => DESK_MEMBERS[g.id]?.includes(u.id))) {
        const person = people.get(u.id) ?? { ...u, teams: [], open: this.open().filter((i) => i.assignee?.id === u.id).map((i) => ({ number: i.number, summary: i.summary, priority: i.priority, priorityLabel: i.priorityLabel })) };
        person.teams.push(g.name);
        people.set(u.id, person);
      }
    }
    return success([...people.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async update(sysId: string, fields: Record<string, string>) {
    const hit = this.state.itdesk.backlog.find((i) => i.sysId === sysId);
    if (!hit) return failure<DeskIncident>({ kind: 'not_found' });
    const next: DeskIncident = { ...plain(hit) };
    if ('assigned_to' in fields) next.assignee = DESK_USERS.find((u) => u.id === fields.assigned_to) ?? null;
    if ('assignment_group' in fields) next.group = DESK_GROUPS.find((g) => g.id === fields.assignment_group) ?? null;
    if (fields.state) Object.assign(next, { state: fields.state, stateLabel: STATE_LABELS[fields.state] ?? fields.state });
    if (fields.state && fields.state !== '3') next.holdReason = null;
    if (fields.hold_reason) next.holdReason = fields.hold_reason;
    if (fields.category) next.category = fields.category;
    if (fields.urgency) next.urgency = Number(fields.urgency) as Level;
    if (fields.impact) next.impact = Number(fields.impact) as Level;
    next.priority = next.urgency + next.impact - 1;
    next.priorityLabel = PRIORITY_LABELS[next.priority];
    return success(next);
  }
}
