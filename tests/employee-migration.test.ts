import { describe, expect, it } from 'vitest';
import { EMPLOYEE } from '@/lib/domain/company';
import { withCurrentEmployee } from '@/lib/domain/seed';
import { freshState } from './helpers';

describe('withCurrentEmployee', () => {
  it('gives a session saved under an older persona the current employee', () => {
    const old = freshState();
    old.employee = { ...old.employee, name: 'Priya Sharma', firstName: 'Priya', email: 'priya.sharma@nimbuslabs.example' };
    const next = withCurrentEmployee(old);
    expect(next.employee).toEqual(EMPLOYEE);
    expect(next.tickets).toBe(old.tickets);
  });
  it('returns the same state when the employee is already current', () => {
    const s = freshState();
    expect(withCurrentEmployee(s)).toBe(s);
  });
});
