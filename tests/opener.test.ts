import { describe, expect, it } from 'vitest';
import { callOpener } from '@/lib/domain/opener';
import { DAY } from '@/lib/domain/time';
import { NOW, freshState } from './helpers';

const LINE = { kind: 'default', say: "I'm here to help you sort out any IT issue. What's going on?" };

describe('call opener', () => {
  it('only offers help, whatever the session holds', () => {
    expect(callOpener(freshState(), NOW)).toEqual(LINE);
    const busy = freshState();
    busy.tickets = [{ number: 'INC0012001', sysId: 's1', summary: 'VPN keeps disconnecting', state: 'Resolved', urgency: 3, source: 'live', createdAt: NOW - 3 * DAY, updatedAt: NOW - DAY }];
    expect(callOpener(busy, NOW)).toEqual(LINE);
  });
  it('is speakable as written', () => {
    expect(callOpener(freshState(), NOW).say).not.toMatch(/[;:]|\s-\s|[–—]|INC\d/);
  });
});
