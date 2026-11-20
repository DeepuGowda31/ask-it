import type { DeskIncident } from '../integrations/types';
import type { PersonCard, SessionState } from './types';

type Board = NonNullable<SessionState['itdesk']['board']>;

const OPEN = new Set(['1', '2', '3']);

// One card after a saved change: the incident sits only with its open assignee.
function follow(card: PersonCard, i: DeskIncident): PersonCard {
  const mine = OPEN.has(i.state) && i.assignee?.name === card.name;
  if (!mine && !card.open.some((t) => t.number === i.number)) return card;
  const rest = card.open.filter((t) => t.number !== i.number);
  const open = mine ? [...rest, { number: i.number, summary: i.summary, priority: i.priority, priorityLabel: i.priorityLabel }].sort((a, b) => a.priority - b.priority) : rest;
  return { ...card, open };
}

// Keeps the people on screen true right after an assignment is saved, before ServiceNow is read again.
export function followAssignment(board: Board, i: DeskIncident): Board {
  if (board.kind === 'person') return { ...board, person: follow(board.person, i) };
  if (board.kind !== 'people') return board;
  const people = board.people.map((p) => follow(p, i));
  // Counts cover the whole team; only people on screen can change between free and busy here.
  const freed = people.filter((p, n) => !p.open.length && board.people[n].open.length).length;
  const taken = people.filter((p, n) => p.open.length && !board.people[n].open.length).length;
  return { ...board, people, available: board.available + freed - taken, busy: board.busy + taken - freed };
}
