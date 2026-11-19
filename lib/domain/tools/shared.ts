import type { KnowledgeSource } from '@/lib/integrations/servicenow-kb';
import type { DeskAdapter, IdentityAdapter, Mode, StatusSource, TicketAdapter } from '@/lib/integrations/types';
import { ACTION_TTL_MS, createPending } from '../actions';
import type { ActionPayload, Alert, Metrics, Persona, SessionState, ToolResult } from '../types';

// Everything a tool may reach outside the session. Built per call; simulated adapters read the snapshot.
export interface Deps {
  tickets: TicketAdapter;
  identity: IdentityAdapter;
  desk: DeskAdapter;
  knowledge: KnowledgeSource;
  status: StatusSource;
  // IT channel alerts are sent after the tool answers; tools only need to know whether a webhook exists.
  notifyMode: Mode;
}

interface ParamSpec {
  description: string;
  enum?: readonly string[];
  allowEmpty?: boolean;
}

export type Args = Record<string, string>;

interface EffectCtx {
  state: SessionState;
  now: number;
  deps: Deps;
  claim: string;
  // The session as stored now, for effects that wait on another request.
  reload: () => Promise<SessionState | null>;
}

interface RunCtx<E> {
  // A private copy: handlers may mutate it.
  state: SessionState;
  now: number;
  effect: E | undefined;
  claim: string;
  // The persona of the call; left out when the caller is not a call.
  persona?: Persona;
}

export interface Outcome {
  result: ToolResult;
  title: string;
  minutesSaved?: number;
  actionCode?: string;
  metrics?: Partial<Omit<Metrics, 'minutesSaved'>>;
  // IT channel messages queued by this call, delivered by the server after the response.
  alerts?: Alert[];
}

// One tool. Outbound calls live in `effect`, which runs once outside the state update; `run` is pure.
export interface ToolDef<E = unknown> {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  // Calls that may use this tool; employee only when left out.
  personas?: Persona[];
  // Rough minutes of IT or employee time a successful call saves.
  minutesSaved?: number;
  // Claims the work before the effect runs, so a duplicate call cannot repeat it. Mutates a private copy.
  begin?(state: SessionState, args: Args, now: number, claim: string, persona?: Persona): boolean;
  effect?(ctx: EffectCtx, args: Args): Promise<E | undefined>;
  run(ctx: RunCtx<E>, args: Args): Outcome;
}

export const tool = <E>(def: ToolDef<E>): ToolDef => def as ToolDef;

export const ok = (say: string, data?: unknown, next?: string): ToolResult => ({ ok: true, say, ...(next ? { next } : {}), ...(data === undefined ? {} : { data }) });

export const fail = (error: string, say: string, suggestions?: string[], next?: string): ToolResult => ({
  ok: false,
  error,
  say,
  ...(next ? { next } : {}),
  ...(suggestions?.length ? { suggestions } : {}),
});

export const failed = (title: string, error: string, say: string, suggestions?: string[], next?: string): Outcome => ({ title, result: fail(error, say, suggestions, next) });

const CONFIRM_NEXT = 'Ask for a clear yes, then call confirmAction with confirmationCode. Never say the code aloud.';

// Stores a pending action and asks the agent for a spoken yes.
export function prepare(state: SessionState, now: number, payload: ActionPayload, summary: string, warnings: string[], lead: string, extraNext = '', data: Record<string, unknown> = {}): Outcome {
  const action = createPending(state, now, payload, summary, warnings);
  const caution = warnings.length ? ` Heads-up: ${warnings.join(' ')}` : '';
  const next = warnings.length ? `Read the heads-up and only go ahead if Priya insists. ${extraNext}${CONFIRM_NEXT}` : `${extraNext}${CONFIRM_NEXT}`;
  return {
    title: summary,
    actionCode: action.code,
    result: ok(`${lead}${caution}`, {
      status: 'awaiting_confirmation',
      confirmationCode: action.code,
      summary,
      warnings,
      expiresInSeconds: ACTION_TTL_MS / 1000,
      ...data,
    }, next),
  };
}

// The spoken note on an IT channel message, honest about simulated Slack.
export const alertSay = (mode: Mode) => (mode === 'live' ? "I'm alerting the IT channel now." : 'The IT channel alert is simulated because no webhook is set up.');

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
