import { describe, expect, it, vi } from 'vitest';
import { success } from '@/lib/integrations/http';
import { beginTool, computeEffect, runTool } from '@/lib/domain/tools';
import { MINUTE } from '@/lib/domain/time';
import { NOW, call, codeOf, freshState, makeDeps } from './helpers';

async function preparedTicket() {
  const prep = await call(freshState(), 'prepareTicket', { summary: 'Monitor flickers', urgency: 'medium', details: '' });
  return { state: prep.state, code: codeOf(prep.result) };
}

describe('confirmAction', () => {
  it('is idempotent: a second confirm changes nothing and calls nothing', async () => {
    const create = vi.fn(async () => success({ number: 'INC0012001', sysId: 's1' }));
    const { state, code } = await preparedTicket();
    const first = await call(state, 'confirmAction', { code }, { tickets: { create } });
    const second = await call(first.state, 'confirmAction', { code }, { tickets: { create } });
    expect(second.status).toBe(200);
    expect(second.result.data).toMatchObject({ alreadyDone: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(second.state.tickets.filter((t) => t.number === 'INC0012001')).toHaveLength(1);
    expect(second.state.metrics.ticketsRaised).toBe(1);
  });
  it('accepts the code spoken as words', async () => {
    const { state, code } = await preparedTicket();
    const words = [...code].map((d) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][Number(d)]).join(' ');
    expect((await call(state, 'confirmAction', { code: words })).status).toBe(200);
  });
  it('refuses an expired code without calling ServiceNow', async () => {
    const create = vi.fn();
    const { state, code } = await preparedTicket();
    const out = await call(state, 'confirmAction', { code }, { now: NOW + 5 * MINUTE + 1, tickets: { create } });
    expect(out.result.error).toBe('action_expired');
    expect(create).not.toHaveBeenCalled();
  });
  it('refuses unknown and cancelled codes', async () => {
    const { state, code } = await preparedTicket();
    expect((await call(state, 'confirmAction', { code: '9999' })).result.error).toBe('unknown_code');
    const cancelled = await call(state, 'cancelAction', { code });
    expect(cancelled.result.say).toMatch(/discarded/i);
    expect((await call(cancelled.state, 'confirmAction', { code })).result.error).toBe('action_cancelled');
  });
  it('lets exactly one of two concurrent confirms commit', async () => {
    const { state, code } = await preparedTicket();
    const claimed = beginTool('confirmAction', state, { code }, NOW, 'A');
    expect(claimed?.pending[0]).toMatchObject({ status: 'committing', claim: 'A' });
    expect(beginTool('confirmAction', claimed!, { code }, NOW, 'B')).toBeNull();
    const loser = runTool('confirmAction', claimed!, { code }, NOW, undefined, 'B');
    expect(loser.result.error).toBe('in_progress');
    const winner = await call(claimed!, 'confirmAction', { code }, { claim: 'A' });
    expect(winner.status).toBe(200);
  });
  it('lets a new call take over a commit that was abandoned', async () => {
    const { state, code } = await preparedTicket();
    const claimed = beginTool('confirmAction', state, { code }, NOW, 'A')!;
    expect(beginTool('confirmAction', claimed, { code }, NOW + 10_000, 'B')).toBeNull();
    const retaken = beginTool('confirmAction', claimed, { code }, NOW + 16_000, 'B');
    expect(retaken?.pending[0].claim).toBe('B');
  });
});

describe('concurrent confirms of different tickets', () => {
  it('never gives two simulated tickets the same number', async () => {
    const a = await call(freshState(), 'prepareTicket', { summary: 'Monitor flickers', urgency: 'low', details: '' });
    const b = await call(a.state, 'prepareTicket', { summary: 'Dock not charging', urgency: 'low', details: '' });
    const [codeA, codeB] = [codeOf(a.result), codeOf(b.result)];
    let s = beginTool('confirmAction', b.state, { code: codeA }, NOW, 'A')!;
    s = beginTool('confirmAction', s, { code: codeB }, NOW, 'B')!;
    const deps = makeDeps(s, NOW);
    const [effA, effB] = await Promise.all([computeEffect('confirmAction', s, { code: codeA }, NOW, deps, 'A'), computeEffect('confirmAction', s, { code: codeB }, NOW, deps, 'B')]);
    s = runTool('confirmAction', s, { code: codeA }, NOW, effA, 'A').state;
    s = runTool('confirmAction', s, { code: codeB }, NOW, effB, 'B').state;
    const numbers = s.tickets.filter((t) => t.raisedHere).map((t) => t.number).sort();
    expect(numbers).toEqual(['INC0012001', 'INC0012002']);
  });
});

describe('cancelAction', () => {
  it('cannot cancel after confirm', async () => {
    const { state, code } = await preparedTicket();
    const done = await call(state, 'confirmAction', { code });
    const out = await call(done.state, 'cancelAction', { code });
    expect(out.result.error).toBe('already_done');
    expect(out.state.tickets[0].number).toBe('INC0012001');
  });
  it('cannot cancel a commit in progress, and handles unknown codes', async () => {
    const { state, code } = await preparedTicket();
    const claimed = beginTool('confirmAction', state, { code }, NOW, 'A')!;
    expect((await call(claimed, 'cancelAction', { code })).result.error).toBe('in_progress');
    expect((await call(state, 'cancelAction', { code: '1' })).result.error).toBe('unknown_code');
  });
  it('makes a second cancel harmless', async () => {
    const { state, code } = await preparedTicket();
    const once = await call(state, 'cancelAction', { code });
    const twice = await call(once.state, 'cancelAction', { code });
    expect(twice.status).toBe(200);
    expect(twice.result.say).toMatch(/already discarded/i);
  });
});
