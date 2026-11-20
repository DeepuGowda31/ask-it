import { describe, expect, it } from 'vitest';
import { TOOLS, getTool, runTool, toolJsonSchema, toolsFor, validateArgs } from '@/lib/domain/tools';
import { NOW, call, freshState } from './helpers';

describe('tool registry', () => {
  it('fits Agora: valid names, at most 32 tools per call, all params required strings', () => {
    expect(toolsFor('employee').length).toBeLessThanOrEqual(32);
    expect(TOOLS).toHaveLength(32);
    expect(toolsFor('itdesk').length).toBeLessThanOrEqual(32);
    expect(toolsFor('employee').map((t) => t.name).sort()).toEqual(
      [
        'addTicketNote',
        'cancelAction',
        'checkIdentity',
        'checkServiceStatus',
        'confirmAction',
        'confirmFix',
        'followOutage',
        'getAccountStatus',
        'getTicketDetails',
        'listMyTickets',
        'markResolved',
        'prepareAccountAction',
        'prepareEscalation',
        'prepareSecurityLockdown',
        'prepareTicket',
        'reportStep',
        'runDiagnostics',
        'scheduleReminder',
        'searchKnowledge',
        'startTroubleshooting',
        'verifyIdentity',
        'wrapUpCall',
      ].sort(),
    );
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/);
      expect(t.description.length).toBeLessThanOrEqual(1024);
      const schema = toolJsonSchema(t);
      expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
      for (const p of Object.values(schema.properties)) expect(p.type).toBe('string');
    }
  });
  it('says in every ticket-changing tool that it needs her yes first', () => {
    for (const name of ['addTicketNote', 'followOutage', 'markResolved', 'prepareTicket', 'prepareEscalation']) expect(getTool(name)!.description).toMatch(/Step 1 of .*confirm/i);
  });
  it('never mentions the old product in descriptions', () => {
    const text = JSON.stringify(TOOLS.map((t) => [t.description, toolJsonSchema(t)]));
    expect(text).not.toMatch(/okta|workday|copilot|calendar/i);
  });
  it('looks tools up case-insensitively', () => {
    expect(getTool('checkservicestatus')?.name).toBe('checkServiceStatus');
    expect(getTool('launchRocket')).toBeUndefined();
  });
});

describe('argument validation', () => {
  const def = getTool('reportStep')!;
  it('requires non-empty values unless "" means not given', () => {
    expect(validateArgs(def, {})).toEqual({ error: 'outcome is required' });
    expect(validateArgs(def, { outcome: 'Not_Fixed', note: '' })).toEqual({ args: { outcome: 'not_fixed', note: '' } });
    expect(validateArgs(def, { outcome: 'maybe', note: '' })).toEqual({ error: 'outcome must be one of: fixed, not_fixed, done, skipped' });
  });
  it('coerces numbers to strings and rejects very long text', () => {
    expect(validateArgs(getTool('confirmAction')!, { code: 4217 })).toEqual({ args: { code: '4217' } });
    expect(validateArgs(getTool('addTicketNote')!, { ticket: 'INC1', note: 'x'.repeat(2001) })).toEqual({ error: 'note is too long' });
  });
});

describe('runTool', () => {
  it('is pure and records one event per call', () => {
    const state = freshState();
    const before = structuredClone(state);
    const out = runTool('searchKnowledge', state, { query: 'vpn keeps dropping' }, NOW);
    expect(state).toEqual(before);
    expect(out.status).toBe(200);
    expect(out.state.events).toEqual([expect.objectContaining({ kind: 'tool', tool: 'searchKnowledge', ok: true })]);
  });
  it('answers unknown tools with 404 and bad arguments with 422', async () => {
    expect(runTool('launchRocket', freshState(), {}, NOW).status).toBe(404);
    const bad = await call(freshState(), 'reportStep', {});
    expect(bad.status).toBe(422);
    expect(bad.result.error).toBe('invalid_arguments');
  });
});
