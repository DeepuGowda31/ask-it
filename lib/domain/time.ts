// Times are shown in the employee's zone, Bengaluru (Asia/Kolkata).
const TZ = 'Asia/Kolkata';
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(ms: number, tz = TZ) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute };
}

const offsetAt = (ms: number, tz: string) => {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MINUTE) * MINUTE;
};

// UTC instant of a wall-clock time (minutes after midnight) on an ISO date in `tz`.
export function zonedTime(isoDay: string, minuteOfDay: number, tz = TZ): number {
  const [y, m, d] = isoDay.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d) + minuteOfDay * MINUTE;
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function isoDate(ms: number, tz = TZ): string {
  const p = zonedParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "2:30 PM"
export function formatTime(ms: number, tz = TZ): string {
  const { hour, minute } = zonedParts(ms, tz);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

// "Wednesday 18 November 2026"
export function longDate(isoDay: string): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}
