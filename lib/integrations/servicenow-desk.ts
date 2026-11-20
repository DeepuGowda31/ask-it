import { failure, success, type Http, type Result } from './http';
import { serviceNowRequest, type ServiceNowConfig } from './servicenow';
import type { Activity, DeskAdapter, DeskIncident, Level, NameMatch, PriorityFilter, QueueQuery, QueueSort, Ref, Resource, StateFilter, WorkNote } from './types';

const FIELDS = 'number,sys_id,short_description,priority,state,hold_reason,assigned_to,assignment_group,caller_id,category,urgency,impact,opened_at';
const OPEN = 'active=true^stateIN1,2,3';
const DEFAULT_WINDOW_DAYS = 30;
const PRIORITY: Record<PriorityFilter, string> = { critical: '^priority=1', high: '^priority=2', moderate: '^priority=3', low: '^priorityIN4,5', urgent: '^priorityIN1,2' };
const STATE: Record<StateFilter, string> = { new: '^state=1', in_progress: '^state=2', on_hold: '^state=3', resolved: '', closed: '', canceled: '' };
// Finished states sit outside the open set, so they replace it as the base query.
const DONE: Partial<Record<StateFilter, string>> = { resolved: 'state=6', closed: 'state=7', canceled: 'state=8' };
const ORDER: Record<QueueSort, string> = { priority: '^ORDERBYpriority^ORDERBYopened_at', newest: '^ORDERBYDESCopened_at', oldest: '^ORDERBYopened_at' };
const MINUTE = 60_000;
const ACTIVITY_LIMIT = 1000;
const MATCH: Record<NameMatch, string> = { exact: '=', starts: 'STARTSWITH', like: 'LIKE' };
const SYS_ID = /^[0-9a-f]{32}$/;
const TICKET_NUMBER = /^INC\d{7}$/;
const TEAM = /^[A-Za-z][A-Za-z ]{0,39}$/;
// Shared accounts that sit in groups but never take work.
const NOT_PEOPLE = new Set(['itil', 'admin', 'ITIL User', 'System Administrator']);

type Json = Record<string, unknown>;

// Days of incidents the desk reads out; 0 means no limit.
export function queueWindowDays(env: Record<string, string | undefined>): number {
  const raw = env.SERVICENOW_QUEUE_DAYS?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_WINDOW_DAYS;
}
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
// Values placed in a query: never an operator, newline or empty.
const safe = (v: string) => Boolean(v) && !/[\^\n\r=]/.test(v);
const rejected = <T>() => failure<T>({ kind: 'rejected' });

const part = (row: Json, name: string, which: 'value' | 'display_value') => {
  const f = row[name];
  const v = isRecord(f) ? f[which] : undefined;
  return typeof v === 'string' ? v : '';
};

function parseTime(value: string): number | null {
  const t = value ? Date.parse(`${value.replace(' ', 'T')}Z`) : NaN;
  return Number.isNaN(t) ? null : t;
}

// "1 - Critical" -> "Critical"
const priorityLabel = (row: Json) => part(row, 'priority', 'display_value').replace(/^\d+\s*-\s*/, '');
const level = (value: string): Level => (value === '1' || value === '2' ? Number(value) as Level : 3);
const ref = (row: Json, name: string): Ref | null => (part(row, name, 'value') ? { id: part(row, name, 'value'), name: part(row, name, 'display_value') } : null);

function toIncident(row: unknown): DeskIncident | null {
  if (!isRecord(row) || !part(row, 'number', 'value') || !part(row, 'sys_id', 'value')) return null;
  return {
    number: part(row, 'number', 'value'),
    sysId: part(row, 'sys_id', 'value'),
    summary: part(row, 'short_description', 'display_value'),
    priority: Number(part(row, 'priority', 'value')) || 5,
    priorityLabel: priorityLabel(row),
    state: part(row, 'state', 'value'),
    stateLabel: part(row, 'state', 'display_value'),
    holdReason: part(row, 'hold_reason', 'value') || null,
    assignee: ref(row, 'assigned_to'),
    group: ref(row, 'assignment_group'),
    caller: part(row, 'caller_id', 'display_value') || null,
    category: part(row, 'category', 'value') || null,
    urgency: level(part(row, 'urgency', 'value')),
    impact: level(part(row, 'impact', 'value')),
    openedAt: parseTime(part(row, 'opened_at', 'value')),
  };
}

export class ServiceNowDesk implements DeskAdapter {
  readonly mode = 'live';

  constructor(
    private cfg: ServiceNowConfig,
    private http: Http,
    private windowDays = 0,
    private now: () => number = Date.now,
  ) {}

  // gs.minutesAgoStart keeps the bound independent of the ServiceNow user's time zone.
  private minutesAgo(ms: number) {
    return `javascript:gs.minutesAgoStart(${Math.max(0, Math.floor((this.now() - ms) / MINUTE))})`;
  }

  // Encoded query for the filters, or null when a value could break out of the query.
  private filters(q: QueueQuery): string | null {
    const text = [q.assignee?.kind === 'name' ? q.assignee.name : '', q.group ?? '', q.category ?? '', ...(q.words ?? [])].filter((t) => t !== '');
    if (!text.every(safe)) return null;
    return [
      q.priority ? PRIORITY[q.priority] : '',
      q.state ? STATE[q.state] : '',
      q.assignee?.kind === 'none' ? '^assigned_toISEMPTY' : q.assignee?.kind === 'any' ? '^assigned_toISNOTEMPTY' : q.assignee ? `^assigned_to.nameLIKE${q.assignee.name}` : '',
      q.group ? `^assignment_group.nameLIKE${q.group}` : '',
      q.category ? `^category=${q.category}` : '',
      ...(q.words ?? []).map((w) => `^short_descriptionLIKE${w}`),
      q.since !== undefined ? `^opened_at>=${this.minutesAgo(q.since)}` : '',
      q.before !== undefined ? `^opened_at<${this.minutesAgo(q.before)}` : '',
    ].join('');
  }

  private get window() {
    return this.windowDays > 0 ? `^opened_at>=javascript:gs.daysAgoStart(${this.windowDays})` : '';
  }

  private get open() {
    return `${OPEN}${this.window}`;
  }

  private async rows(table: string, params: Record<string, string>): Promise<Result<unknown[]>> {
    const res = await serviceNowRequest(this.cfg, this.http, 'GET', `/api/now/table/${table}?${new URLSearchParams(params)}`);
    if (!res.ok) return res;
    const result = isRecord(res.value) ? res.value.result : undefined;
    return Array.isArray(result) ? success(result) : failure({ kind: 'bad_response' });
  }

  private async incidents(query: string, limit: number): Promise<Result<DeskIncident[]>> {
    const res = await this.rows('incident', { sysparm_query: query, sysparm_fields: FIELDS, sysparm_display_value: 'all', sysparm_limit: String(limit) });
    if (!res.ok) return res;
    const list = res.value.map(toIncident);
    return list.every((x): x is DeskIncident => x !== null) ? success(list) : failure({ kind: 'bad_response' });
  }

  private async refs(table: string, query: string, limit: number): Promise<Result<Ref[]>> {
    const res = await this.rows(table, { sysparm_query: query, sysparm_fields: 'sys_id,name', sysparm_limit: String(limit) });
    if (!res.ok) return res;
    return success(res.value.filter(isRecord).map((r) => ({ id: String(r.sys_id ?? ''), name: String(r.name ?? '') })).filter((r) => r.id && r.name));
  }

  listOpen(q: QueueQuery, limit: number) {
    const filters = this.filters(q);
    if (filters === null) return Promise.resolve(rejected<DeskIncident[]>());
    const done = q.state && DONE[q.state];
    return this.incidents(`${done ? `${done}${this.window}` : this.open}${filters}${ORDER[q.sort]}`, limit);
  }

  async get(number: string): Promise<Result<DeskIncident | null>> {
    if (!TICKET_NUMBER.test(number)) return rejected();
    const res = await this.incidents(`number=${number}`, 1);
    return res.ok ? success(res.value[0] ?? null) : res;
  }

  search(words: string[]) {
    if (!words.length || !words.every(safe)) return Promise.resolve(rejected<DeskIncident[]>());
    return this.incidents(`${this.open}${words.map((w) => `^short_descriptionLIKE${w}`).join('')}^ORDERBYpriority`, 5);
  }

  async workNotes(sysId: string): Promise<Result<WorkNote[]>> {
    if (!SYS_ID.test(sysId)) return rejected();
    const res = await this.rows('sys_journal_field', {
      sysparm_query: `element_id=${sysId}^element=work_notes^ORDERBYDESCsys_created_on`,
      sysparm_fields: 'value,sys_created_on,sys_created_by',
      sysparm_limit: '2',
    });
    if (!res.ok) return res;
    return success(res.value.filter(isRecord).map((r) => ({ at: parseTime(String(r.sys_created_on ?? '')), author: String(r.sys_created_by ?? ''), text: String(r.value ?? '') })));
  }

  findUsers(name: string, match: NameMatch) {
    if (!safe(name)) return Promise.resolve(rejected<Ref[]>());
    return this.refs('sys_user', `active=true^name${MATCH[match]}${name}`, 6);
  }

  findGroups(name: string) {
    if (!safe(name)) return Promise.resolve(rejected<Ref[]>());
    return this.refs('sys_user_group', `active=true^nameLIKE${name}`, 6);
  }

  async groupMembers(groupId: string): Promise<Result<Ref[]>> {
    if (!SYS_ID.test(groupId)) return rejected();
    const res = await this.rows('sys_user_grmember', { sysparm_query: `group=${groupId}^user.active=true^ORDERBYuser.name`, sysparm_fields: 'user', sysparm_display_value: 'all', sysparm_limit: '50' });
    if (!res.ok) return res;
    return success(res.value.filter(isRecord).map((r) => ref(r, 'user')).filter((u): u is Ref => u !== null && Boolean(u.name)));
  }

  // Members by team name, then all their open incidents in one query by sys_id.
  private async since(field: 'opened_at' | 'resolved_at', since: number, fields: string): Promise<Result<Json[]>> {
    const res = await this.rows('incident', { sysparm_query: `${field}>=${this.minutesAgo(since)}`, sysparm_fields: fields, sysparm_limit: String(ACTIVITY_LIMIT) });
    return res.ok ? success(res.value.filter(isRecord)) : res;
  }

  // Resolutions carry the same incident's opened_at, so the time to resolve is measured, not guessed.
  async activity(since: number): Promise<Result<Activity>> {
    const [opened, resolved] = await Promise.all([this.since('opened_at', since, 'opened_at'), this.since('resolved_at', since, 'resolved_at,opened_at')]);
    if (!opened.ok) return opened;
    if (!resolved.ok) return resolved;
    const time = (r: Json, field: string) => parseTime(String(r[field] ?? ''));
    return success({
      opened: opened.value.map((r) => time(r, 'opened_at')).filter((t): t is number => t !== null),
      resolved: resolved.value.flatMap((r) => {
        const at = time(r, 'resolved_at');
        return at === null ? [] : [{ at, openedAt: time(r, 'opened_at') }];
      }),
    });
  }

  async resolvedSince(since: number, limit: number): Promise<Result<DeskIncident[]>> {
    const res = await this.rows('incident', {
      sysparm_query: `resolved_at>=${this.minutesAgo(since)}^ORDERBYDESCresolved_at`,
      sysparm_fields: `${FIELDS},resolved_at`,
      sysparm_display_value: 'all',
      sysparm_limit: String(limit),
    });
    if (!res.ok) return res;
    const list = res.value.map((row): DeskIncident | null => {
      const i = toIncident(row);
      return i && isRecord(row) ? { ...i, resolvedAt: parseTime(part(row, 'resolved_at', 'value')) } : null;
    });
    return list.every((x): x is DeskIncident => x !== null) ? success(list) : failure({ kind: 'bad_response' });
  }

  async roster(teams: readonly string[]): Promise<Result<Resource[]>> {
    if (!teams.length || !teams.every((t) => TEAM.test(t))) return rejected();
    const members = await this.rows('sys_user_grmember', {
      sysparm_query: `group.nameIN${teams.join(',')}^group.active=true^user.active=true^ORDERBYuser.name`,
      sysparm_fields: 'user,group,user.user_name',
      sysparm_display_value: 'all',
      sysparm_limit: '500',
    });
    if (!members.ok) return members;
    const people = new Map<string, Resource>();
    for (const row of members.value.filter(isRecord)) {
      const user = ref(row, 'user');
      const team = part(row, 'group', 'display_value');
      if (!user?.name || !SYS_ID.test(user.id) || !teams.includes(team) || NOT_PEOPLE.has(user.name) || NOT_PEOPLE.has(part(row, 'user.user_name', 'value'))) continue;
      const person = people.get(user.id) ?? { ...user, teams: [], open: [] };
      if (!person.teams.includes(team)) person.teams.push(team);
      people.set(user.id, person);
    }
    if (!people.size) return success([]);
    const open = await this.rows('incident', {
      sysparm_query: `${this.open}^assigned_toIN${[...people.keys()].join(',')}^ORDERBYpriority`,
      sysparm_fields: 'number,short_description,priority,assigned_to',
      sysparm_display_value: 'all',
      sysparm_limit: '500',
    });
    if (!open.ok) return open;
    for (const row of open.value.filter(isRecord)) {
      const number = part(row, 'number', 'value');
      const person = people.get(part(row, 'assigned_to', 'value'));
      if (number && person) person.open.push({ number, summary: part(row, 'short_description', 'display_value'), priority: Number(part(row, 'priority', 'value')) || 5, priorityLabel: priorityLabel(row) });
    }
    return success([...people.values()].map((p) => ({ ...p, teams: p.teams.sort((a, b) => teams.indexOf(a) - teams.indexOf(b)) })));
  }

  // Raw values in; the record comes back with display values in the same call.
  async update(sysId: string, fields: Record<string, string>): Promise<Result<DeskIncident>> {
    if (!SYS_ID.test(sysId)) return rejected();
    const body = fields.state === '6' && !fields.close_code ? { ...fields, close_code: this.cfg.closeCode } : fields;
    const params = new URLSearchParams({ sysparm_display_value: 'all', sysparm_fields: FIELDS, sysparm_input_display_value: 'false' });
    const res = await serviceNowRequest(this.cfg, this.http, 'PATCH', `/api/now/table/incident/${encodeURIComponent(sysId)}?${params}`, body);
    if (!res.ok) return res;
    const incident = toIncident(isRecord(res.value) ? res.value.result : undefined);
    return incident ? success(incident) : failure({ kind: 'bad_response' });
  }
}
