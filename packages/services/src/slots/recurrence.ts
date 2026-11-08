// Explicit wall-clock recurrence for posting slots (SC-03). Pure; no IO.
//  - A slot occurs on each listed ISO weekday (1=Mon … 7=Sun) at HH:MM local time in its own IANA zone.
//  - DST gap (the wall time does not exist, clocks go forward): that occurrence is SKIPPED and reported.
//  - DST fold (the wall time happens twice, clocks go back): the EARLIER instant is used, i.e. the
//    pre-transition offset (e.g. 01:30 BST/+01:00 rather than 01:30 GMT/+00:00 in Europe/London).
//  - The slot's zone is stored on the slot; changing a workspace/brand zone never moves a slot or a schedule.
import { resolveWallTime, wallClock } from '@social-lite/core';

export interface SlotRule { weekdays: number[]; localTime: string; timezone: string }

export type Occurrence =
  | { kind: 'ok'; localDate: string; local: string; instant: Date; offset: string; fold: boolean }
  | { kind: 'gap'; localDate: string; local: string; message: string };

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO weekday (1=Mon..7=Sun) of a calendar date (zone-independent). */
export function isoWeekday(localDate: string): number {
  const d = new Date(`${localDate}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function addDays(localDate: string, n: number): string {
  const d = new Date(`${localDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Occurrences strictly after `after`, scanning `days` calendar days in the slot zone (inclusive of today),
 * in chronological order. Gaps are included (kind 'gap') so callers can report skipped occurrences.
 */
export function occurrencesAfter(rule: SlotRule, after: Date, days = 56): Occurrence[] {
  const w = wallClock(after, rule.timezone);
  const today = `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
  const set = new Set(rule.weekdays);
  const out: Occurrence[] = [];
  for (let i = 0; i <= days; i++) {
    const localDate = addDays(today, i);
    if (!set.has(isoWeekday(localDate))) continue;
    const local = `${localDate}T${rule.localTime}`;
    const r = resolveWallTime(local, rule.timezone);
    if (r.kind === 'gap') {
      // Only report gaps that are in the future relative to `after` (compare on the calendar day).
      if (i > 0 || rule.localTime > `${pad(w.h)}:${pad(w.mi)}`) out.push({ kind: 'gap', localDate, local, message: r.message });
      continue;
    }
    if (r.kind === 'invalid') continue;
    const pick = r.kind === 'ambiguous' ? r.options[0]! : { instant: r.instant, offset: r.offset };
    if (pick.instant.getTime() <= after.getTime()) continue;
    out.push({ kind: 'ok', localDate, local, instant: pick.instant, offset: pick.offset, fold: r.kind === 'ambiguous' });
  }
  return out;
}
