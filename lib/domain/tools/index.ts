import { ACTION_TOOLS } from './confirm';
import { IDENTITY_TOOLS } from './identity';
import { fail, type Args, type Deps, type ToolDef } from './shared';
import { SUPPORT_TOOLS } from './support';
import { TICKET_TOOLS } from './ticketing';
import { ITDESK_TOOLS } from './itdesk';
import { REPORT_TOOLS } from './report';
import { WRAPUP_TOOLS } from './wrapup';
import { FOLLOW_UP_TOOLS } from './followup';
import { DIAGNOSTICS_TOOLS } from './diagnostics';
import type { Alert, Persona, SessionState, ToolResult } from '../types';

// One registry for Agora tools, MCP and the route; every param is a required string, "" means not given.
export const TOOLS: ToolDef[] = [...SUPPORT_TOOLS, ...IDENTITY_TOOLS, ...TICKET_TOOLS, ...ACTION_TOOLS, ...DIAGNOSTICS_TOOLS, ...FOLLOW_UP_TOOLS, ...WRAPUP_TOOLS, ...ITDESK_TOOLS, ...REPORT_TOOLS];

const BY_NAME = new Map(TOOLS.map((t) => [t.name.toLowerCase(), t]));
export const getTool = (name: string) => BY_NAME.get(name.toLowerCase());

const personasOf = (def: ToolDef): Persona[] => def.personas ?? ['employee'];
export const toolsFor = (persona: Persona) => TOOLS.filter((t) => personasOf(t).includes(persona));
export const toolAllowed = (name: string, persona: Persona) => {
  const def = getTool(name);
  return Boolean(def && personasOf(def).includes(persona));
};
export const parsePersona = (raw: unknown): Persona => (raw === 'itdesk' ? 'itdesk' : 'employee');

const MAX_LENGTH = 2000;
const MAX_EVENTS = 300;

export function validateArgs(def: ToolDef, raw: unknown): { args: Args } | { error: string } {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const args: Args = {};
  for (const [key, spec] of Object.entries(def.params)) {
    const v = input[key];
    const s = v === undefined || v === null ? '' : String(v).trim();
    if (!s && !spec.allowEmpty) return { error: `${key} is required` };
    if (s.length > MAX_LENGTH) return { error: `${key} is too long` };
    const canonical = spec.enum && s ? spec.enum.find((e) => e.toLowerCase() === s.toLowerCase()) : s;
    if (canonical === undefined) return { error: `${key} must be one of: ${spec.enum!.join(', ')}` };
    args[key] = canonical;
  }
  return { args };
}

interface ToolRun {
  status: number;
  result: ToolResult;
  state: SessionState;
  alerts: Alert[];
}

// Pure: returns a new state with the change and a timeline event; the input is never mutated.
export function runTool(name: string, current: SessionState, rawArgs: unknown, now: number, effect?: unknown, claim = '', persona?: Persona): ToolRun {
  const def = getTool(name);
  if (!def) return { status: 404, result: fail('unknown_tool', `There is no tool called ${name}.`), state: current, alerts: [] };
  const state = structuredClone(current);
  const parsed = validateArgs(def, rawArgs);
  const outcome =
    'error' in parsed
      ? { title: `${def.name}: ${parsed.error}`, result: fail('invalid_arguments', `I couldn't run that: ${parsed.error}.`) }
      : def.run({ state, now, effect, claim, persona }, parsed.args);
  const success = outcome.result.ok;
  const minutesSaved = success ? ('minutesSaved' in outcome ? outcome.minutesSaved : undefined) ?? def.minutesSaved ?? 0 : 0;
  if (success && 'metrics' in outcome) {
    for (const [k, n] of Object.entries(outcome.metrics ?? {})) state.metrics[k as keyof typeof state.metrics] += n;
  }
  state.metrics.minutesSaved += minutesSaved;
  state.seq += 1;
  state.events.push({
    id: state.seq,
    at: now,
    kind: 'tool',
    tool: def.name,
    ok: success,
    title: outcome.title,
    minutesSaved,
    ...(success && 'actionCode' in outcome && outcome.actionCode ? { actionCode: outcome.actionCode } : {}),
  });
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  return { status: success ? 200 : 422, result: outcome.result, state, alerts: ('alerts' in outcome && outcome.alerts) || [] };
}

// Claims work before the effect runs (confirmAction). Returns the claimed state, or null when nothing was claimed.
export function beginTool(name: string, current: SessionState, rawArgs: unknown, now: number, claim: string, persona?: Persona): SessionState | null {
  const def = getTool(name);
  const parsed = def?.begin ? validateArgs(def, rawArgs) : null;
  if (!def?.begin || !parsed || 'error' in parsed) return null;
  const state = structuredClone(current);
  return def.begin(state, parsed.args, now, claim, persona) ? state : null;
}

// Runs a tool's outbound calls once, against a snapshot, outside the state update.
export async function computeEffect(name: string, snapshot: SessionState, rawArgs: unknown, now: number, deps: Deps, claim: string, reload: () => Promise<SessionState | null> = async () => snapshot): Promise<unknown> {
  const def = getTool(name);
  const parsed = def?.effect ? validateArgs(def, rawArgs) : null;
  if (!def?.effect || !parsed || 'error' in parsed) return undefined;
  return def.effect({ state: snapshot, now, deps, claim, reload }, parsed.args);
}

export const hasEffect = (name: string) => Boolean(getTool(name)?.effect);

// JSON Schema for a tool's parameters, shared by the Agora tool config and MCP.
export function toolJsonSchema(def: ToolDef) {
  return {
    type: 'object' as const,
    properties: Object.fromEntries(
      Object.entries(def.params).map(([k, p]) => [k, { type: 'string' as const, description: p.description, ...(p.enum ? { enum: [...p.enum] } : {}) }]),
    ),
    required: Object.keys(def.params),
    additionalProperties: false,
  };
}
