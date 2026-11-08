// V3.5 service-level calculation (brief §12). Pure functions; used by services/inbox/cases.ts and tests.
// Definitions (also returned by the care report and documented in docs/v3-5/INBOX_AND_CARE.md):
//  - Clock start: the earliest unanswered customer message on the conversation the case is created from; case creation
//    time when nothing is waiting for a reply.
//  - First response: the first reply SENT through the provider (state 'sent') on a linked conversation after the clock start.
//    Automated acknowledgements count only when the policy says count_automated = true. Internal notes never count.
//  - Pauses: the clock does not run while the case is 'waiting' (waiting on the customer) or 'resolved'.
//  - Business hours: weekly windows in the policy time zone; holidays (local dates) have no business time.
//    No business hours (null) = 24/7.
//  - Reopened cases: first response is NOT re-measured; the resolution clock resumes from the reopen time and the
//    reopen is counted. Breaches already recorded stay recorded.
import { resolveWallTime, wallClock } from '../time.js';

export interface BusinessCalendar {
  timezone: string;
  business_hours: Array<{ day: number; start: string; end: string }> | null;
  holidays: string[];
}

export const SLA_DEFINITIONS: Record<string, string> = {
  clock_start: 'Earliest unanswered customer message when the case is created; the creation time if nothing is waiting.',
  first_response: 'First provider-confirmed reply after the clock starts. Internal notes never count; automated acknowledgements count only if the policy allows.',
  pauses: 'The clock stops while the case is waiting on the customer or resolved.',
  business_hours: 'Only time inside the policy’s weekly hours counts; holidays have no business time. No hours set = 24/7.',
  reopened: 'Reopening resumes the resolution clock from the reopen time; first response is not re-measured. Reopens are counted.',
  backlog: 'Cases open, reopened or waiting at the end of the window.',
};

const MAX_DAYS = 400;
const DAY = 86_400_000;

function localDate(instant: Date, tz: string): { y: number; mo: number; d: number } {
  const w = wallClock(instant, tz);
  return { y: w.y, mo: w.mo, d: w.d };
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (x: { y: number; mo: number; d: number }) => `${x.y}-${pad(x.mo)}-${pad(x.d)}`;

function nextDate(x: { y: number; mo: number; d: number }): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(x.y, x.mo - 1, x.d) + DAY);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Local wall time → instant. Spring-forward gaps move to the next valid minute; folds take the earlier instant. */
function instantAt(date: string, hhmm: string, tz: string): Date {
  let [h, m] = hhmm.split(':').map(Number) as [number, number];
  if (h === 24 && m === 0) {
    const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
    const n = nextDate({ y, mo, d });
    return instantAt(isoDate(n), '00:00', tz);
  }
  for (let i = 0; i < 180; i++) {
    const r = resolveWallTime(`${date}T${pad(h)}:${pad(m)}`, tz);
    if (r.kind === 'ok') return r.instant;
    if (r.kind === 'ambiguous') return r.options[0]!.instant;
    if (r.kind === 'invalid') throw new Error(r.message);
    m++; if (m === 60) { m = 0; h++; }
  }
  throw new Error('unresolvable local time');
}

/** Business windows [start, end) as instants for one local date. */
export function windowsOn(date: { y: number; mo: number; d: number }, cal: BusinessCalendar): Array<[number, number]> {
  const iso = isoDate(date);
  if (cal.holidays.includes(iso)) return [];
  const startOfDay = instantAt(iso, '00:00', cal.timezone).getTime();
  const endOfDay = instantAt(iso, '24:00', cal.timezone).getTime();
  if (!cal.business_hours) return [[startOfDay, endOfDay]];
  const dow = new Date(Date.UTC(date.y, date.mo - 1, date.d)).getUTCDay();
  return cal.business_hours
    .filter((w) => w.day === dow && w.start < w.end)
    .map((w) => [instantAt(iso, w.start, cal.timezone).getTime(), instantAt(iso, w.end, cal.timezone).getTime()] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

/** Business milliseconds in [start, end). */
export function businessMsBetween(start: Date, end: Date, cal: BusinessCalendar): number {
  if (end <= start) return 0;
  if (!cal.business_hours && !cal.holidays.length) return end.getTime() - start.getTime();
  let date = localDate(new Date(start.getTime() - DAY), cal.timezone);
  let total = 0;
  for (let i = 0; i < MAX_DAYS + 2; i++) {
    for (const [a, b] of windowsOn(date, cal)) {
      const s = Math.max(a, start.getTime());
      const e = Math.min(b, end.getTime());
      if (e > s) total += e - s;
    }
    if (instantAt(isoDate(date), '00:00', cal.timezone).getTime() > end.getTime()) break;
    date = nextDate(date);
  }
  return total;
}

/** The instant at which `ms` business milliseconds have elapsed after `start`. null when beyond the search horizon. */
export function addBusinessMs(start: Date, ms: number, cal: BusinessCalendar): Date | null {
  if (ms <= 0) return start;
  if (!cal.business_hours && !cal.holidays.length) return new Date(start.getTime() + ms);
  let remaining = ms;
  let date = localDate(new Date(start.getTime() - DAY), cal.timezone);
  for (let i = 0; i < MAX_DAYS; i++) {
    for (const [a, b] of windowsOn(date, cal)) {
      const s = Math.max(a, start.getTime());
      if (b <= s) continue;
      const span = b - s;
      if (span >= remaining) return new Date(s + remaining);
      remaining -= span;
    }
    date = nextDate(date);
  }
  return null;
}

export interface SlaClock {
  /** When the clock started. */
  start: Date;
  /** Business ms spent paused so far (closed pauses). */
  pausedBusinessMs: number;
  /** Open pause, if the case is currently waiting/resolved. */
  pausedSince: Date | null;
}

/** Due instant for a target (minutes of business time), or null while paused / no target. */
export function dueAt(clock: SlaClock, targetMinutes: number | null, cal: BusinessCalendar): Date | null {
  if (targetMinutes === null || clock.pausedSince) return null;
  return addBusinessMs(clock.start, targetMinutes * 60_000 + clock.pausedBusinessMs, cal);
}

/** Business minutes elapsed on the clock at `at` (pauses excluded). */
export function elapsedBusinessMinutes(clock: SlaClock, at: Date, cal: BusinessCalendar): number {
  const until = clock.pausedSince && clock.pausedSince < at ? clock.pausedSince : at;
  return Math.max(0, Math.round((businessMsBetween(clock.start, until, cal) - clock.pausedBusinessMs) / 60_000));
}
