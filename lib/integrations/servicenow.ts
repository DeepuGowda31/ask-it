import { failure, requestJson, success, type Http, type Result } from './http';
import { assetMarker, findAsset } from '@/lib/domain/assets';
import type { Level, NewTicket, OpenTicket, RemoteTicket, TicketAdapter, TicketRef } from './types';

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
const LIST_FIELDS = 'number,short_description,state,urgency,sys_created_on,sys_updated_on,sys_id';
const TICKET_NUMBER = /^INC\d{7}$/;
const CORRELATION_ID = /^askit:[A-Za-z0-9-]+:[A-Za-z0-9]+$/;

// Caller sys_ids survive across requests in the same process.
const CALLERS = new Map<string, string>();

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
  return {
    number,
    sysId,
    summary: String(field(row, 'short_description', 'display_value') ?? ''),
    state: String(field(row, 'state', 'display_value') ?? ''),
    urgency: parseLevel(field(row, 'urgency', 'value')),
    createdAt: parseTime(field(row, 'sys_created_on', 'value')),
    updatedAt: parseTime(field(row, 'sys_updated_on', 'value')),
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
    const caller = await this.callerId();
    if (!caller.ok) return caller;
    const body = {
      short_description: t.shortDescription,
      description: t.description,
      urgency: String(t.urgency),
      impact: String(t.impact),
      category: t.category,
      caller_id: caller.value,
      contact_type: 'virtual_agent',
      correlation_id: t.correlationId,
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
      sysparm_query: `caller_id=${caller.value}^ORDERBYDESCsys_created_on`,
      sysparm_limit: '10',
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

  resolve(ref: TicketRef, notes: string) {
    return this.patch(ref, { state: '6', close_code: this.cfg.closeCode, close_notes: notes });
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
