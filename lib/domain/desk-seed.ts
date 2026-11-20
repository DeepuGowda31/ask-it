import type { Ref } from '@/lib/integrations/types';
import { EMPLOYEE } from './company';
import { DAY, MINUTE } from './time';
import type { OpenIncident } from './types';

// Simulated IT desk data: people, groups and an open queue with three P1s.
const user = (key: string, name: string): Ref => ({ id: `sim-user-${key}`, name });
const group = (key: string, name: string): Ref => ({ id: `sim-group-${key}`, name });

export const DESK_USERS = [
  user('ddan', 'David Dan'),
  user('dloo', 'David Loo'),
  user('dmiller', 'David Miller'),
  user('arao', 'Anita Rao'),
  user('knair', 'Karthik Nair'),
  user('sjoseph', 'Sam Joseph'),
  user('banglin', 'Beth Anglin'),
  user('fluddy', 'Fred Luddy'),
  user('bruggeri', 'Bow Ruggeri'),
  user('dgoodliffe', 'Don Goodliffe'),
  user('aiyer', 'Ananya Iyer'),
  user('rmenon', 'Rahul Menon'),
  user('arjunrao', 'Arjun Rao'),
  user('mkrishnan', 'Meera Krishnan'),
  user('vshetty', 'Vikram Shetty'),
  user('dprakash', 'Divya Prakash'),
  user('kmalhotra', 'Karan Malhotra'),
  user('njoshi', 'Neha Joshi'),
  user('sbabu', 'Suresh Babu'),
  user('pdas', 'Priyanka Das'),
  user('lnarayan', 'Lakshmi Narayan'),
  user('isheikh', 'Imran Sheikh'),
  user('npillai', 'Nisha Pillai'),
  user('akulkarni', 'Aditya Kulkarni'),
];

export const DESK_GROUPS = ['Network', 'Software', 'Hardware', 'Service Desk', 'Help Desk', 'Database', 'Field Services', 'Finance Systems', 'Payroll'].map((name) => group(name.toLowerCase().replace(' ', '-'), name));

// Group -> member names, the same people as the live instance's teams.
const MEMBERS: Record<string, string[]> = {
  'Service Desk': ['Beth Anglin', 'David Loo', 'Ananya Iyer', 'Rahul Menon'],
  Network: ['Fred Luddy', 'Bow Ruggeri', 'David Dan', 'David Loo', 'Arjun Rao'],
  Hardware: ['Beth Anglin', 'Bow Ruggeri', 'David Dan', 'David Loo', 'Don Goodliffe', 'Fred Luddy'],
  Software: ['Beth Anglin', 'David Loo', 'Don Goodliffe', 'Fred Luddy', 'Meera Krishnan'],
  Database: ['Beth Anglin', 'Fred Luddy', 'Vikram Shetty', 'Divya Prakash'],
  'Finance Systems': ['Karan Malhotra', 'Neha Joshi', 'Suresh Babu', 'Priyanka Das'],
  Payroll: ['Lakshmi Narayan', 'Imran Sheikh', 'Nisha Pillai', 'Aditya Kulkarni'],
  'Help Desk': ['Sam Joseph'],
  'Field Services': ['David Loo'],
};

// Group id -> member user ids.
export const DESK_MEMBERS: Record<string, string[]> = Object.fromEntries(
  DESK_GROUPS.map((g) => [g.id, (MEMBERS[g.name] ?? []).map((name) => DESK_USERS.find((u) => u.name === name)!.id)]),
);

export const PRIORITY_LABELS: Record<number, string> = { 1: 'Critical', 2: 'High', 3: 'Moderate', 4: 'Low', 5: 'Planning' };
export const STATE_LABELS: Record<string, string> = { '1': 'New', '2': 'In Progress', '3': 'On Hold', '6': 'Resolved', '7': 'Closed', '8': 'Canceled' };

const byName = (list: Ref[], name: string) => list.find((r) => r.name === name) ?? null;

type Row = [number: number, summary: string, urgency: 1 | 2 | 3, impact: 1 | 2 | 3, state: string, assignee: string | null, group: string | null, caller: string, category: string | null, ageMinutes: number, hold?: string];

const ROWS: Row[] = [
  [13001, 'Sales floor VPN down for 40 users', 1, 1, '1', null, null, 'Meera Pillai', null, 180],
  [13002, 'Payroll export failing in SAP', 1, 1, '2', 'Karthik Nair', 'Software', 'Arvind Menon', 'software', DAY / MINUTE],
  [13003, 'Email delivery delayed company-wide', 1, 1, '2', null, 'Service Desk', 'Farhan Qureshi', 'software', 300],
  [13004, 'Concur expense submissions failing', 1, 2, '2', 'Anita Rao', 'Software', EMPLOYEE.name, 'software', (2 * DAY) / MINUTE],
  [13005, 'Printer on floor 3 keeps jamming', 2, 3, '1', null, 'Field Services', 'Sneha Kulkarni', 'hardware', DAY / MINUTE],
  [13006, 'Laptop battery swelling on NB-1877', 2, 2, '3', 'David Loo', 'Hardware', 'Rahul Iyer', 'hardware', (4 * DAY) / MINUTE, '4'],
  [13007, 'Database backup job running slow', 2, 2, '1', null, 'Database', 'Emma Clarke', 'database', 360],
  [13008, 'Shared mailbox not syncing for HR', 2, 3, '1', 'Rahul Menon', 'Service Desk', 'Kavya Reddy', 'software', (3 * DAY) / MINUTE],
  [13009, 'Branch office Wi-Fi dropping every hour', 2, 2, '1', 'Arjun Rao', 'Network', 'Rohan Gupta', 'network', (2 * DAY) / MINUTE],
  [13010, 'Adobe licence activation failing', 3, 2, '1', 'Meera Krishnan', 'Software', 'Ishaan Verma', 'software', (3 * DAY) / MINUTE],
  [13011, 'Reporting replica lagging behind primary', 2, 3, '1', 'Vikram Shetty', 'Database', 'Emma Clarke', 'database', (2 * DAY) / MINUTE],
  [13012, 'Vendor payment file rejected by the bank', 2, 2, '1', 'Karan Malhotra', 'Finance Systems', 'Arvind Menon', 'software', (2 * DAY) / MINUTE],
  [13013, 'Invoice approvals stuck in the workflow', 3, 2, '1', 'Karan Malhotra', 'Finance Systems', 'Sneha Kulkarni', 'software', (5 * DAY) / MINUTE],
  [13014, 'Payslip PDFs not generating for October', 2, 3, '1', 'Lakshmi Narayan', 'Payroll', 'Farhan Qureshi', 'software', (3 * DAY) / MINUTE],
];

export function seedBacklog(now: number): OpenIncident[] {
  return ROWS.map(([n, summary, urgency, impact, state, assignee, groupName, caller, category, ageMinutes, hold]) => {
    const priority = urgency + impact - 1;
    return {
      number: `INC00${n}`,
      sysId: `sim-inc-${n}`,
      summary,
      priority,
      priorityLabel: PRIORITY_LABELS[priority],
      state,
      stateLabel: STATE_LABELS[state],
      holdReason: hold ?? null,
      assignee: assignee ? byName(DESK_USERS, assignee) : null,
      group: groupName ? byName(DESK_GROUPS, groupName) : null,
      caller,
      category,
      urgency,
      impact,
      openedAt: now - ageMinutes * MINUTE,
      notes: n === 13006 ? [{ at: now - DAY, author: 'david.loo', text: 'Replacement battery ordered from the vendor, waiting for delivery' }] : [],
    };
  });
}
