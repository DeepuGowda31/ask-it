import type { Result } from './http';

export type Mode = 'live' | 'simulated';
export type Level = 1 | 2 | 3;

export interface NewTicket {
  shortDescription: string;
  description: string;
  urgency: Level;
  impact: Level;
  category: string;
  // Lets a lost create be found again and stops a retry from duplicating it.
  correlationId: string;
}

export interface TicketRef {
  number: string;
  sysId: string | null;
}

export interface RemoteTicket {
  number: string;
  sysId: string;
  summary: string;
  state: string;
  urgency: Level;
  createdAt: number | null;
  updatedAt: number | null;
}

// An open incident someone already raised for a device.
export interface OpenTicket {
  number: string;
  sysId: string;
  summary: string;
}

export interface TicketAdapter {
  mode: Mode;
  create(ticket: NewTicket): Promise<Result<{ number: string; sysId: string }>>;
  find(correlationId: string): Promise<Result<{ number: string; sysId: string } | null>>;
  resolve(ref: TicketRef, notes: string): Promise<Result<null>>;
  listMine(): Promise<Result<RemoteTicket[]>>;
  // The newest open incident raised for a catalog device, by anyone.
  findOpenForAsset(assetId: string): Promise<Result<OpenTicket | null>>;
  addNote(ref: TicketRef, text: string): Promise<Result<null>>;
  escalate(ref: TicketRef, reason: string): Promise<Result<null>>;
  // After a resolution: the caller confirmed the fix (Closed) or said it still fails (In Progress, high urgency).
  close(ref: TicketRef, note: string): Promise<Result<null>>;
  reopen(ref: TicketRef, note: string): Promise<Result<null>>;
}

export interface Ref {
  id: string;
  name: string;
}

export interface DeskIncident {
  number: string;
  sysId: string;
  summary: string;
  priority: number;
  priorityLabel: string;
  state: string;
  stateLabel: string;
  holdReason: string | null;
  assignee: Ref | null;
  group: Ref | null;
  caller: string | null;
  category: string | null;
  urgency: Level;
  impact: Level;
  openedAt: number | null;
  // When it was resolved: the simulated desk, and live rows read by resolvedSince.
  resolvedAt?: number | null;
}

export interface WorkNote {
  at: number | null;
  author: string;
  text: string;
}

export type PriorityFilter = 'critical' | 'high' | 'moderate' | 'low' | 'urgent';
export type StateFilter = 'new' | 'in_progress' | 'on_hold' | 'resolved' | 'closed' | 'canceled';
export type Opened = 'today' | 'yesterday' | 'last_24h' | 'this_week' | 'last_7_days' | 'this_month';
export type QueueSort = 'priority' | 'newest' | 'oldest';
export type AssigneeFilter = { kind: 'none' } | { kind: 'any' } | { kind: 'name'; name: string };

// Filters over open incidents; every field is optional except the sort. Names match by substring.
export interface QueueQuery {
  priority?: PriorityFilter;
  state?: StateFilter;
  assignee?: AssigneeFilter;
  group?: string;
  category?: string;
  opened?: Opened;
  // Opened at or after / before, epoch ms.
  since?: number;
  before?: number;
  words?: string[];
  sort: QueueSort;
}
export type NameMatch = 'exact' | 'starts' | 'like';

// An engineer in one or more desk teams and the open incidents assigned to them.
export interface Resource {
  id: string;
  name: string;
  teams: string[];
  open: { number: string; summary: string; priority: number; priorityLabel: string }[];
}

// The IT desk view of the incident queue. Every text input is sanitised by the caller and checked again here.
export interface DeskAdapter {
  mode: Mode;
  listOpen(query: QueueQuery, limit: number): Promise<Result<DeskIncident[]>>;
  get(number: string): Promise<Result<DeskIncident | null>>;
  search(words: string[]): Promise<Result<DeskIncident[]>>;
  workNotes(sysId: string): Promise<Result<WorkNote[]>>;
  findUsers(name: string, match: NameMatch): Promise<Result<Ref[]>>;
  findGroups(name: string): Promise<Result<Ref[]>>;
  groupMembers(groupId: string): Promise<Result<Ref[]>>;
  // Active people in the named teams, by name, with their open incidents; teams come in the order asked.
  roster(teams: readonly string[]): Promise<Result<Resource[]>>;
  // When incidents were opened and resolved since a moment, for the dashboard's daily bars.
  activity(since: number): Promise<Result<Activity>>;
  // Incidents resolved since a moment, newest first, each with resolvedAt.
  resolvedSince(since: number, limit: number): Promise<Result<DeskIncident[]>>;
  update(sysId: string, fields: Record<string, string>): Promise<Result<DeskIncident>>;
}

// When incidents were opened, and when they were resolved with when that same incident was opened.
export interface Activity {
  opened: number[];
  resolved: { at: number; openedAt: number | null }[];
}

export type AccountAction = 'unlock' | 'resetPassword' | 'resetMfa';

export interface AccountInfo {
  userId: string;
  email: string;
  locked: boolean;
  lastPasswordReset: number | null;
  factors: string[];
  // False when the tenant would not tell us, so "no MFA" is never claimed by mistake.
  factorsKnown: boolean;
}

export interface IdentityAdapter {
  mode: Mode;
  getUser(): Promise<Result<AccountInfo>>;
  // Emails a one-time code; the simulated adapter returns the code it "sent", live returns null.
  sendCode(): Promise<Result<string | null>>;
  // false means a wrong or expired code.
  verifyCode(code: string): Promise<Result<boolean>>;
  lifecycle(user: { userId: string; email: string }, action: AccountAction): Promise<Result<null>>;
  // Lockdown steps; ending sessions or tokens that do not exist counts as done.
  block(userId: string): Promise<Result<null>>;
  endSessions(userId: string): Promise<Result<null>>;
  revokeRefreshTokens(userId: string): Promise<Result<null>>;
}

export type StatusLevel = 'operational' | 'degraded' | 'outage' | 'maintenance' | 'unknown';

export interface LiveStatus {
  level: StatusLevel;
  summary: string;
  incidents: string[];
}

export type StatusFeed =
  | { kind: 'statuspage'; base: string; match?: string }
  | { kind: 'slack' }
  | { kind: 'google'; product: string };

export interface StatusSource {
  check(feed: StatusFeed): Promise<LiveStatus>;
}

export type CardStatus = 'opened' | 'in_progress' | 'waiting_employee' | 'resolved_by_askit' | 'ticket_raised' | 'escalated' | 'assigned' | 'on_hold' | 'resolved_by_it' | 'reopened';

// One milestone for an issue's live Slack card.
export interface CardUpdate {
  // Ticket number once one exists, else "<session>:<issue>".
  key: string;
  // Ticket number the card is also known by from now on.
  alias?: string;
  status: CardStatus;
  title: string;
  person: string;
  device?: string;
  ticket?: string;
  detail: string;
  at: number;
}

export type Channel = 'discord' | 'slack' | 'simulated';
export type Delivery = { ok: true; channel: Channel } | { ok: false; error: string };
