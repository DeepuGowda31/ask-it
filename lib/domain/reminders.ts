import { DAY, MINUTE, formatTime, isoDate, longDate, zonedTime } from './time';

// Reminders: Priya asks ASK IT to check back; when one is due her page rings like a follow-up.

export const MAX_PENDING_REMINDERS = 5;
export const MAX_AHEAD_MS = 7 * DAY;

const AMOUNT: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
const UNIT_MS: Record<string, number> = { min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE, hr: 60 * MINUTE, hrs: 60 * MINUTE, hour: 60 * MINUTE, hours: 60 * MINUTE };
const MORNING = 10 * 60;
const EVENING = 18 * 60;

const TIME = '(noon|midnight|(\\d{1,2})(?::(\\d{2}))? ?([ap]m)?)';
const RELATIVE = /^in (?:(half an hour)|(\d{1,3}|[a-z]+) (min|mins|minutes?|hr|hrs|hours?))$/;
const TOMORROW = new RegExp(`^tomorrow(?: at)?(?: ${TIME})?$`);
const TIME_TOMORROW = new RegExp(`^(?:at )?${TIME} tomorrow$`);
const TODAY = new RegExp(`^(?:today )?(?:at )?${TIME}$`);

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/\b([ap])\.m\b\.?/g, '$1m')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,]+$/, '')
    .replace(/^(?:please )?(?:remind me|check back(?: with me)?|call me(?: back)?)\s*/, '');
}

// Minutes after midnight. Without am or pm a working day is assumed: 7 to 11 is morning, 12 noon, 1 to 6 afternoon.
function clock(m: RegExpMatchArray, at: number): number | null {
  const word = m[at];
  if (word === 'noon') return 12 * 60;
  if (word === 'midnight') return 0;
  const hour = Number(m[at + 1]);
  const minute = Number(m[at + 2] ?? 0);
  const meridiem = m[at + 3];
  if (minute > 59) return null;
  if (meridiem) return hour >= 1 && hour <= 12 ? ((hour % 12) + (meridiem === 'pm' ? 12 : 0)) * 60 + minute : null;
  if (hour > 23) return null;
  return (hour >= 1 && hour <= 6 ? hour + 12 : hour) * 60 + minute;
}

// India time has no daylight saving, so a day is always 24 hours.
const onDay = (now: number, days: number, minuteOfDay: number) => zonedTime(isoDate(now + days * DAY), minuteOfDay);

// When "remind me ..." means, in India time; null when it is not one of the forms below. Past times are returned for the caller to refuse.
export function parseWhen(text: string, now: number): number | null {
  const q = normalize(text);
  const rel = q.match(RELATIVE);
  if (rel) {
    if (rel[1]) return now + 30 * MINUTE;
    const n = /^\d+$/.test(rel[2]) ? Number(rel[2]) : AMOUNT[rel[2]];
    return n === undefined ? null : now + n * UNIT_MS[rel[3]];
  }
  if (q === 'tomorrow morning') return onDay(now, 1, MORNING);
  if (q === 'this evening') return onDay(now, 0, EVENING);
  const tomorrow = q.match(TOMORROW) ?? q.match(TIME_TOMORROW);
  if (tomorrow) {
    const minute = tomorrow[1] ? clock(tomorrow, 1) : MORNING;
    return minute === null ? null : onDay(now, 1, minute);
  }
  const today = q.match(TODAY);
  const minute = today ? clock(today, 1) : null;
  if (minute === null) return null;
  const at = onDay(now, 0, minute);
  return at > now ? at : onDay(now, 1, minute);
}

function dayWord(at: number, now: number) {
  const day = isoDate(at);
  if (day === isoDate(now)) return 'today';
  if (day === isoDate(now + DAY)) return 'tomorrow';
  return longDate(day).split(' ')[0];
}

// "tomorrow at 10 AM", "on Saturday at 9:30 AM"
export function spokenWhen(at: number, now: number): string {
  const day = dayWord(at, now);
  return `${day === 'today' || day === 'tomorrow' ? day : `on ${day}`} at ${formatTime(at).replace(':00 ', ' ')}`;
}

// "tomorrow 10:00 AM", for the screen.
export const reminderLabel = (at: number, now: number) => `${dayWord(at, now)} ${formatTime(at)}`;
