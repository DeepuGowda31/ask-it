import { describe, expect, it } from 'vitest';
import { pickSessionCode } from '@/lib/client/session-code';

describe('pickSessionCode', () => {
  it.each([
    ['ABC-DEF', 'XYZ-234', 'ABC-DEF'],
    [' abc-def ', null, 'ABC-DEF'],
    ['', 'XYZ-234', 'XYZ-234'],
    ['not-a-code', 'XYZ-234', 'XYZ-234'],
    ['', null, null],
    ['', 'garbage', null],
    ['ABC-DE1', null, null],
  ])('url %j and stored %j give %j', (fromUrl, stored, expected) => {
    expect(pickSessionCode(fromUrl, stored)).toBe(expected);
  });
});
