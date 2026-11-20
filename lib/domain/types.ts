import type { Dashboard } from './dashboard';
import type { AccountAction, CardStatus, CardUpdate, Channel, DeskIncident, Level, Mode, NewTicket, OpenTicket, Resource, WorkNote } from '@/lib/integrations/types';
import type { DiagnosticFocus, DiagnosticResults, Finding } from './diagnose';
import type { ReportPeriod } from './report';

// Who the call is for; set by the server when the call starts, never by the model.
export type Persona = 'employee' | 'itdesk';

export interface Employee {
  name: string;
  firstName: string;
  role: string;
  email: string;
  device: { id: string; model: string; os: string };
  vpnClient: string;
}

// Last known Auth0 account state; in simulated mode this is the account itself.
interface Account {
  email: string;
  userId: string | null;
  // null until Auth0 has been read: a live account is never guessed.
  locked: boolean | null;
  lastPasswordReset: number | null;
  factors: string[];
  factorsKnown: boolean;
  source: Mode;
  checkedAt: number | null;
  // The first read from Auth0 failed, so nothing above is known.
  readFailed?: boolean;
}

export type VerificationStatus = 'none' | 'pending' | 'approved' | 'expired' | 'failed';

export interface Verification {
  status: VerificationStatus;
  sentAt: number | null;
  approvedAt: number | null;
  expiresAt: number | null;
  // Attempts are reserved before the check runs, so parallel calls cannot exceed the limit.
  attempts: number;
  // Claims of checks still in flight.
  checking: string[];
  // Simulated mode only: the emailed code, shown on screen as a simulated inbox. Never in tool results.
  simulatedCode: string | null;
}

export type StepOutcome = 'fixed' | 'not_fixed' | 'done' | 'skipped';

interface StepLog {
  step: number;
  text: string;
  outcome: StepOutcome;
  note: string;
  at: number;
}

export interface Troubleshooting {
  articleId: string;
  title: string;
  issue: string;
  stepIndex: number;
  status: 'active' | 'fixed' | 'exhausted' | 'resolved' | 'ticketed';
  startedAt: number;
  log: StepLog[];
  ticket?: string;
}

export interface TicketRecord {
  number: string;
  sysId: string | null;
  summary: string;
  state: string;
  urgency: Level;
  source: Mode;
  createdAt: number;
  updatedAt: number;
  // ServiceNow does not match this record (create or update failed).
  syncFailed?: boolean;
  escalated?: boolean;
  raisedHere?: boolean;
  // When a ServiceNow list showed its state change.
  changedAt?: number;
  // When ServiceNow says it was resolved, when it says.
  resolvedAt?: number;
  // Logged by ASK IT for a fix made with the employee on a call.
  fixedOnCall?: true;
}

export interface Outage {
  id: string;
  // Internal service key, or '' when the incident names none.
  service: string;
  title: string;
  incident: string;
  // null when ServiceNow gives no count to say.
  affected: number | null;
  since: number | null;
  followed: boolean;
  syncFailed?: boolean;
}

export type ActionPayload =
  | { kind: 'ticket'; ticket: Omit<NewTicket, 'correlationId'> }
  | { kind: 'escalation'; number: string; sysId: string | null; reason: string }
  | { kind: 'account'; action: AccountAction }
  | { kind: 'incident'; number: string; sysId: string; fields: Record<string, string>; changes: string[]; alert?: string }
  | { kind: 'lockdown'; what: string; when: string }
  // `text` is what ServiceNow gets; `shared` marks the open ticket of a scanned device, which is not hers.
  | { kind: 'note'; number: string; sysId: string; text: string; shared: boolean }
  | { kind: 'outage'; incident: string }
  // `account` is when the account fix it also covers started.
  | { kind: 'resolution'; key: string; summary: string; ticket: Omit<NewTicket, 'correlationId'>; account?: number };

export interface PendingAction {
  code: string;
  summary: string;
  warnings: string[];
  payload: ActionPayload;
  status: 'pending' | 'committing' | 'done' | 'cancelled';
  // Set while one confirmAction call owns the commit.
  claim?: string;
  claimedAt?: number;
  createdAt: number;
  expiresAt: number;
  outcome?: string;
  // Failed or unconfirmed commit attempts; a retry looks the ticket up first.
  tries?: number;
  // Local ticket kept while the commit has not reached ServiceNow.
  localRef?: string;
}

export type LockdownStep = 'block' | 'sessions' | 'refreshTokens' | 'mfa' | 'incident';

// The last lost-device lockdown; the IT channel alert's delivery lives on its notification.
export interface Lockdown {
  at: number;
  steps: { step: LockdownStep; ok: boolean; reason?: string }[];
  incident: string | null;
  alertId: string;
}

// The last laptop check: requested by the tool, run and posted by the employee's browser.
export interface Diagnostics {
  id: string;
  focus: DiagnosticFocus;
  status: 'requested' | 'done' | 'timeout';
  requestedAt: number;
  doneAt?: number;
  results?: DiagnosticResults;
  findings?: Finding[];
}

// The last resolution logged, so the same fix is never logged twice.
interface Resolution {
  key: string;
  status: 'done';
  number: string;
}

// Account actions that worked on this call; logged once as a resolved incident by markResolved, wrap up or the end of the call.
export interface AccountFix {
  actions: AccountAction[];
  at: number;
  status: 'open' | 'logging' | 'logged';
  claim?: string;
  claimedAt?: number;
  // The record it was logged as.
  number?: string;
}

// A fix record ServiceNow did not take, kept as a local ticket; wrap up or the end of the call tries it once more.
interface UnsyncedFix {
  localRef: string;
  ticket: NewTicket;
  claim?: string;
  claimedAt?: number;
}

// A ticket IT resolved outside ASK IT, or a due reminder; the employee page rings until it is answered or snoozed.
export interface FollowUp {
  // For a reminder: its ticket, or "" when it has none.
  number: string;
  summary: string;
  // For a reminder: when it was due.
  resolvedAt: number;
  status: 'ringing' | 'snoozed' | 'answered';
  snoozedUntil?: number;
  // Set when this ring is a reminder the employee asked for.
  reminder?: string;
}

// A check-back the employee asked for; it rings their page once when due.
export interface Reminder {
  id: string;
  at: number;
  about: string;
  ticket: string | null;
  createdAt: number;
  status: 'pending' | 'rung';
}

interface FollowUpLog {
  // Resolutions waiting their turn, newest first.
  queue: FollowUp[];
  // Tickets already rung for, so one resolution never rings twice.
  rung: string[];
}

export type FixOutcome = 'fixed' | 'not_fixed';

// The caller's answer to a follow-up, claimed so a repeated confirmFix commits once.
export interface FixCheck {
  number: string;
  outcome: FixOutcome;
  status: 'committing' | 'done';
  claim?: string;
  claimedAt?: number;
  at: number;
  say?: string;
}

// The device a QR sticker named; its open ticket takes the caller's report instead of a duplicate.
export interface AssetVisit {
  id: string;
  ticket: OpenTicket | null;
}

export interface DocumentRecord {
  id: string;
  kind: 'callSummary';
  title: string;
  markdown: string;
  createdAt: number;
}

export interface Notification {
  id: string;
  kind: 'ticketRaised' | 'ticketEscalated' | 'callSummary' | 'issueStatus' | 'updateRequest';
  text: string;
  // Delivered after the tool answers: queued, then sent or failed.
  status: 'queued' | 'sent' | 'failed';
  channel: Channel | null;
  ok: boolean;
  error?: string;
  at: number;
}

// A message for the IT channel; with a card it also updates that issue's live Slack card.
export interface Alert {
  id: string;
  text: string;
  card?: CardUpdate;
}

// The employee's current issue, which has one live Slack card.
export interface Issue {
  id: string;
  title: string;
  status: CardStatus;
  ticket?: string;
}

export interface Metrics {
  resolvedByAgent: number;
  ticketsRaised: number;
  duplicatesAvoided: number;
  accountActions: number;
  ticketsUpdatedByVoice: number;
  minutesSaved: number;
}

export type OpenIncident = DeskIncident & { notes: WorkNote[] };

export type GroupBy = 'priority' | 'state' | 'assignee' | 'group' | 'category' | 'opened';

export type ResourceStatus = 'available' | 'busy' | 'all';

// An engineer as the dashboard shows them: names only, never sys_ids.
export type PersonCard = Omit<Resource, 'id'>;

// What the IT dashboard shows for the engineer's last question: a list, a count, ASK IT's impact, or people.
// `query` is the list or count filters as asked, and `syncedAt` the last time ServiceNow was read again for it.
type DeskBoard =
  | { kind: 'list'; title: string; total: number; more: boolean; at: number; query?: Record<string, string>; syncedAt?: number }
  | { kind: 'count'; title: string; total: number; more: boolean; groupBy: GroupBy | null; groups: { label: string; count: number }[]; at: number; query?: Record<string, string>; syncedAt?: number }
  | { kind: 'impact'; at: number }
  | ({ kind: 'dashboard'; at: number; syncedAt?: number } & Dashboard)
  // Counts cover the whole team; people are the ones shown.
  | { kind: 'people'; title: string; status: ResourceStatus; available: number; busy: number; people: PersonCard[]; at: number }
  | { kind: 'person'; person: PersonCard; at: number };

// A report the engineer asked for: the IT page builds and downloads it, then it is ready or failed.
// `startedAt` is when a request claimed the build, so two tabs never build it twice.
export interface ReportRequest {
  id: string;
  period: ReportPeriod;
  requestedAt: number;
  status: 'pending' | 'ready' | 'failed';
  startedAt?: number;
  finishedAt?: number;
  filename?: string;
}

interface ItDesk {
  // The last list read out, so "the second one" can be resolved.
  queue: DeskIncident[];
  current: OpenIncident | null;
  lastUpdate: { number: string; changes: string[]; at: number } | null;
  // The last status update asked of an incident's assignee in the IT channel.
  updateRequest?: { number: string; assignee: string; due: number; at: number } | null;
  // Simulated mode only: the incident table itself.
  backlog: OpenIncident[];
  // Missing in sessions saved before boards existed.
  board?: DeskBoard | null;
  // What the engineer asked to see last: the open incident or the board. Missing in older sessions.
  focus?: 'incident' | 'board';
  // The last report asked for; missing in sessions saved before reports existed.
  report?: ReportRequest | null;
}

export interface SessionEvent {
  id: number;
  at: number;
  kind: 'tool' | 'call';
  tool?: string;
  ok: boolean;
  title: string;
  detail?: string;
  minutesSaved?: number;
  // Set on prepare steps so lists can show the action's live status.
  actionCode?: string;
}

interface CallState {
  active: boolean;
  persona?: Persona;
  agentId?: string;
  startedAt?: number;
  endedAt?: number;
  endReason?: string;
  // When the intro was sent; it is said at most once per call.
  introAt?: number;
  // An employee call's opener, chosen when the call started.
  opener?: string;
}

export interface SessionState {
  id: string;
  createdAt: number;
  employee: Employee;
  account: Account;
  verification: Verification;
  troubleshooting: Troubleshooting | null;
  lastResolution: Resolution | null;
  issue: Issue | null;
  // Missing in sessions saved before lockdowns existed.
  lockdown?: Lockdown | null;
  // Missing in sessions saved before laptop checks existed.
  diagnostics?: Diagnostics | null;
  // Missing in sessions saved before follow-up calls existed.
  followUp?: FollowUp | null;
  followUpLog?: FollowUpLog;
  fixChecks?: FixCheck[];
  // Missing in sessions saved before QR stickers existed.
  asset?: AssetVisit | null;
  // Missing in sessions saved before reminders existed.
  reminders?: Reminder[];
  // Missing in sessions saved before fixes on the call were logged.
  accountFix?: AccountFix | null;
  unsyncedFix?: UnsyncedFix | null;
  // The tickets listMyTickets last answered with, for the screen. Missing in older sessions.
  ticketList?: { status: 'open' | 'resolved' | 'all'; period: string; numbers: string[]; at: number } | null;
  itdesk: ItDesk;
  tickets: TicketRecord[];
  outages: Outage[];
  pending: PendingAction[];
  documents: DocumentRecord[];
  notifications: Notification[];
  events: SessionEvent[];
  metrics: Metrics;
  call: CallState;
  seq: number;
  counter: number;
}

// Shape every tool returns: `say` is for the employee, `next` is an instruction for the agent only.
export interface ToolResult {
  ok: boolean;
  say: string;
  next?: string;
  error?: string;
  data?: unknown;
  suggestions?: string[];
}
