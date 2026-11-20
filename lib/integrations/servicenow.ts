import { failure, requestJson, success, type Http, type Result } from './http';
import { assetMarker, findAsset } from '@/lib/domain/assets';
import type { Level, NewTicket, OpenTicket, RemoteTicket, TicketAdapter, TicketDetails, TicketRef } from './types';

type Env = Record<string, string | undefined>;

export interface ServiceNowConfig {
  instanceUrl: string;
  user: string;
  password: string;
  callerEmail: string;
  closeCode: string;
}

interface Timeouts {
  call: number;
  create: number;
}

const TIMEOUTS: Timeouts = { call: 4000, create: 5500 };
// Valid resolution code on current releases (note the en dash); override with SERVICENOW_CLOSE_CODE.
const CLOSE_CODE = 'Resolved – Permanent Fix Applied';
const LIST_FIELDS = 'number,short_description,state,urgency,sys_created_on,opened_at,sys_updated_on,sys_id,resolved_at,correlation_id';
const TICKET_NUMBER = /^INC\d{7}$/;
const CORRELATION_ID = /^askit:[A-Za-z0-9-]+:[A-Za-z0-9]+$/;

// Caller and group sys_ids survive across requests in the same process.
const CALLERS = new Map<string, string>();
// Fixes made on the call go to this group when the instance has it.
const FIX_GROUP = 'Service Desk';

// "2026-11-18 04:05:06", the UTC form ServiceNow stores.
const serviceNowTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export function serviceNowConfig(env: Env): ServiceNowConfig | null {
  const instanceUrl = env.SERVICENOW_INSTANCE_URL?.trim().replace(/\/+$/, '');
  const user = env.SERVICENOW_USER?.trim();
  const password = env.SERVICENOW_PASSWORD;
  const callerEmail = env.SERVICENOW_CALLER_EMAIL?.trim();
  const closeCode = env.SERVICENOW_CLOSE_CODE?.trim() || CLOSE_CODE;
  return instanceUrl && user && password && callerEmail ? { instanceUrl, user, password, callerEmail, closeCode } : null;
}

// One Table API call with Basic auth.
export function serviceNowRequest(cfg: ServiceNowConfig, http: Http, method: string, path: string, body?: unknown, timeoutMs = TIMEOUTS.call) {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const init: RequestInit = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  return requestJson(http, `${cfg.instanceUrl}${path}`, init, timeoutMs);
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const badResponse = <T>() => failure<T>({ kind: 'bad_response' });

function resultOf(body: unknown): unknown {
  return isRecord(body) ? body.result : undefined;
}

// With sysparm_display_value=all every field is { value, display_value }.
const field = (row: Json, name: string, part: 'value' | 'display_value') => {
  const f = row[name];
  return isRecord(f) ? f[part] : undefined;
};

// `value` dates are UTC "YYYY-MM-DD HH:mm:ss".
function parseTime(value: unknown): number | null {
  const t = typeof value === 'string' ? Date.parse(`${value.replace(' ', 'T')}Z`) : NaN;
  return Number.isNaN(t) ? null : t;
}

function parseLevel(value: unknown): Level {
  const n = parseInt(String(value), 10);
  return n === 1 || n === 2 ? n : 3;
}

function toRemote(row: unknown): RemoteTicket | null {
  if (!isRecord(row)) return null;
  const number = field(row, 'number', 'value');
  const sysId = field(row, 'sys_id', 'value');
  if (typeof number !== 'string' || typeof sysId !== 'string') return null;
  const resolvedAt = parseTime(field(row, 'resolved_at', 'value'));
  const correlationId = field(row, 'correlation_id', 'value');
  return {
    number,
    sysId,
    summary: String(field(row, 'short_description', 'display_value') ?? ''),
    state: String(field(row, 'state', 'display_value') ?? ''),
    urgency: parseLevel(field(row, 'urgency', 'value')),
    // When it was raised: opened_at, which may be backdated, else when the record was made.
    createdAt: parseTime(field(row, 'opened_at', 'value')) ?? parseTime(field(row, 'sys_created_on', 'value')),
    updatedAt: parseTime(field(row, 'sys_updated_on', 'value')),
    ...(resolvedAt === null ? {} : { resolvedAt }),
    ...(typeof correlationId === 'string' && correlationId ? { correlationId } : {}),
  };
}

export class ServiceNowTickets implements TicketAdapter {
  readonly mode = 'live';

  constructor(
    private cfg: ServiceNowConfig,
    private http: Http,
    private callers: Map<string, string> = CALLERS,
    private timeouts: Timeouts = TIMEOUTS,
  ) {}

  private call(method: string, path: string, body?: unknown, timeoutMs = this.timeouts.call) {
    return serviceNowRequest(this.cfg, this.http, method, path, body, timeoutMs);
  }

  // First matching row; `value` is never raw user text and may not contain the query operator.
  private async findOne(table: string, column: string, value: string, fields: string): Promise<Result<Json | null>> {
    if (value.includes('^')) return failure({ kind: 'rejected' });
    const params = new URLSearchParams({ sysparm_query: `${column}=${value}`, sysparm_fields: fields, sysparm_limit: '1' });
    const res = await this.call('GET', `/api/now/table/${table}?${params}`);
    if (!res.ok) return res;
    const rows = resultOf(res.value);
    if (!Array.isArray(rows)) return badResponse();
    return success(isRecord(rows[0]) ? rows[0] : null);
  }

  private async sysIdOf(number: string): Promise<Result<string>> {
    if (!TICKET_NUMBER.test(number)) return failure({ kind: 'not_found' });
    const row = await this.findOne('incident', 'number', number, 'sys_id');
    if (!row.ok) return row;
    return typeof row.value?.sys_id === 'string' ? success(row.value.sys_id) : failure({ kind: 'not_found' });
  }

  private async callerId(): Promise<Result<string>> {
    const key = `${this.cfg.instanceUrl}|${this.cfg.callerEmail}`;
    const cached = this.callers.get(key);
    if (cached) return success(cached);
    const row = await this.findOne('sys_user', 'email', this.cfg.callerEmail, 'sys_id');
    if (!row.ok) return row;
    const id = row.value?.sys_id;
    if (typeof id !== 'string' || !id) return failure({ kind: 'not_found' });
    this.callers.set(key, id);
    return success(id);
  }

  // The fix group's sys_id, '' when the instance has none; a failed lookup is not remembered and never blocks the create.
  private async fixGroupId(): Promise<string> {
    const key = `${this.cfg.instanceUrl}|group|${FIX_GROUP}`;
    const cached = this.callers.get(key);
    if (cached !== undefined) return cached;
    const params = new URLSearchParams({ sysparm_query: `name=${FIX_GROUP}^active=true`, sysparm_fields: 'sys_id', sysparm_limit: '1' });
    const res = await this.call('GET', `/api/now/table/sys_user_group?${params}`);
    const rows = res.ok ? resultOf(res.value) : undefined;
    if (!Array.isArray(rows)) return '';
    const id = isRecord(rows[0]) && typeof rows[0].sys_id === 'string' ? rows[0].sys_id : '';
    this.callers.set(key, id);
    return id;
  }

  // `checked` asks for the saved state back: an ACL on the field drops a change without an error.
  private async patch(ref: TicketRef, fields: Record<string, string>, checked = false): Promise<Result<null>> {
    // Simulated ids never go to the live API; look the number up instead.
    let sysId = ref.sysId && !ref.sysId.startsWith('sim-') ? ref.sysId : null;
    if (!sysId) {
      const found = await this.sysIdOf(ref.number);
      if (!found.ok) return found;
      sysId = found.value;
    }
    const query = checked ? `?${new URLSearchParams({ sysparm_fields: 'number,state' })}` : '';
    const res = await this.call('PATCH', `/api/now/table/incident/${encodeURIComponent(sysId)}${query}`, fields);
    if (!res.ok || !checked) return res.ok ? success(null) : res;
    const row = resultOf(res.value);
    if (!isRecord(row)) return badResponse();
    return row.state === fields.state ? success(null) : failure({ kind: 'rejected' });
  }

  async find(correlationId: string): Promise<Result<{ number: string; sysId: string } | null>> {
    if (!CORRELATION_ID.test(correlationId)) return failure({ kind: 'rejected' });
    const row = await this.findOne('incident', 'correlation_id', correlationId, 'number,sys_id');
    if (!row.ok) return row;
    const r = row.value;
    return success(r && typeof r.number === 'string' && typeof r.sys_id === 'string' ? { number: r.number, sysId: r.sys_id } : null);
  }

  async create(t: NewTicket): Promise<Result<{ number: string; sysId: string }>> {
    const [caller, group] = await Promise.all([this.callerId(), t.resolution ? this.fixGroupId() : '']);
    if (!caller.ok) return caller;
    const fix = t.resolution
      ? { state: '6', close_code: this.cfg.closeCode, close_notes: t.resolution.notes, resolved_at: serviceNowTime(t.resolution.at), ...(group ? { assignment_group: group } : {}) }
      : {};
    const body = {
      short_description: t.shortDescription,
      description: t.description,
      urgency: String(t.urgency),
      impact: String(t.impact),
      category: t.category,
      caller_id: caller.value,
      contact_type: 'virtual_agent',
      correlation_id: t.correlationId,
      ...fix,
    };
    const res = await this.call('POST', '/api/now/table/incident', body, this.timeouts.create);
    if (!res.ok) {
      // The incident may exist even though the answer was lost.
      if (res.error.kind !== 'timeout' && res.error.kind !== 'network') return res;
      const found = await this.find(t.correlationId);
      return found.ok && found.value ? success(found.value) : res;
    }
    const row = resultOf(res.value);
    if (!isRecord(row) || typeof row.number !== 'string' || typeof row.sys_id !== 'string') return badResponse();
    return success({ number: row.number, sysId: row.sys_id });
  }

  async listMine(): Promise<Result<RemoteTicket[]>> {
    const caller = await this.callerId();
    if (!caller.ok) return caller;
    const params = new URLSearchParams({
      sysparm_query: `caller_id=${caller.value}^ORDERBYDESCopened_at`,
      sysparm_limit: '25',
      sysparm_fields: LIST_FIELDS,
      sysparm_display_value: 'all',
    });
    const res = await this.call('GET', `/api/now/table/incident?${params}`);
    if (!res.ok) return res;
    const rows = resultOf(res.value);
    if (!Array.isArray(rows)) return badResponse();
    const tickets = rows.map(toRemote);
    return tickets.every((t): t is RemoteTicket => t !== null) ? success(tickets) : badResponse();
  }

  async details(number: string): Promise<Result<TicketDetails | null>> {
    if (!TICKET_NUMBER.test(number)) return failure({ kind: 'rejected' });
    const caller = await this.callerId();
    if (!caller.ok) return caller;
    const params = new URLSearchParams({
      sysparm_query: `number=${number}^caller_id=${caller.value}`,
      sysparm_fields: `${LIST_FIELDS},assigned_to,assignment_group,close_notes`,
      sysparm_display_value: 'all',
      sysparm_limit: '1',
    });
    const res = await this.call('GET', `/api/now/table/incident?${params}`);
    if (!res.ok) return res;
    const rows = resultOf(res.value);
    if (!Array.isArray(rows)) return badResponse();
    if (!rows.length) return success(null);
    const row = rows[0];
    const ticket = toRemote(row);
    if (!ticket || !isRecord(row)) return badResponse();
    const text = (name: string) => String(field(row, name, 'display_value') ?? '').trim() || null;
    return success({ ...ticket, assignee: text('assigned_to'), group: text('assignment_group'), lastComment: await this.lastComment(ticket.sysId), resolution: text('close_notes') });
  }

  // The newest comment on an incident; a failed read leaves it out.
  private async lastComment(sysId: string): Promise<TicketDetails['lastComment']> {
    if (!/^[A-Za-z0-9]+$/.test(sysId)) return null;
    // Comments ASK IT added for the caller are their own words, not an update from IT.
    const notMine = /^[\w.@-]+$/.test(this.cfg.user) ? `^sys_created_by!=${this.cfg.user}` : '';
    const params = new URLSearchParams({ sysparm_query: `element_id=${sysId}^element=comments${notMine}^ORDERBYDESCsys_created_on`, sysparm_fields: 'value,sys_created_on', sysparm_limit: '1' });
    const res = await this.call('GET', `/api/now/table/sys_journal_field?${params}`);
    const rows = res.ok ? resultOf(res.value) : undefined;
    const r = Array.isArray(rows) && isRecord(rows[0]) ? rows[0] : null;
    return r && typeof r.value === 'string' && r.value.trim() ? { text: r.value.trim(), at: parseTime(r.sys_created_on) } : null;
  }

  // Only catalog ids reach the query, so it cannot carry an operator.
  async findOpenForAsset(assetId: string): Promise<Result<OpenTicket | null>> {
    if (!findAsset(assetId)) return failure({ kind: 'rejected' });
    const params = new URLSearchParams({
      sysparm_query: `active=true^stateIN1,2,3^descriptionLIKE${assetMarker(assetId)}^ORDERBYDESCsys_created_on`,
      sysparm_fields: 'number,sys_id,short_description',
      sysparm_limit: '1',
    });
    const res = await this.call('GET', `/api/now/table/incident?${params}`);
    if (!res.ok) return res;
    const rows = resultOf(res.value);
    if (!Array.isArray(rows)) return badResponse();
    const r = rows[0];
    if (!isRecord(r)) return success(null);
    if (typeof r.number !== 'string' || typeof r.sys_id !== 'string') return badResponse();
    return success({ number: r.number, sysId: r.sys_id, summary: String(r.short_description ?? '') });
  }

  addNote(ref: TicketRef, text: string) {
    return this.patch(ref, { comments: text });
  }

  escalate(ref: TicketRef, reason: string) {
    return this.patch(ref, { urgency: '1', impact: '2', comments: reason });
  }

  // Resolved -> Closed; the close code and notes stay from the resolution.
  close(ref: TicketRef, note: string) {
    return this.patch(ref, { state: '7', work_notes: note }, true);
  }

  // Resolved -> In Progress at high urgency.
  reopen(ref: TicketRef, note: string) {
    return this.patch(ref, { state: '2', urgency: '1', work_notes: note }, true);
  }
}
