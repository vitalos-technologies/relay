// Wall-clock <-> UTC conversion with explicit DST handling (SC-01..SC-03).
// Uses only Intl (IANA tz database bundled with Node/ICU). No browser timezone is ever assumed.

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a zone. */
export function wallClock(instant: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = Object.fromEntries(partsFormatter(tz).formatToParts(instant).map((p) => [p.type, p.value]));
  return { y: +parts.year!, mo: +parts.month!, d: +parts.day!, h: +parts.hour!, mi: +parts.minute!, s: +parts.second! };
}

/** Offset of tz at instant, in minutes east of UTC (Europe/London summer = +60). */
export function offsetMinutes(instant: Date, tz: string): number {
  const w = wallClock(instant, tz);
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

export function formatOffset(mins: number): string {
  const sign = mins >= 0 ? '+' : '-';
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

export type WallTimeResolution =
  | { kind: 'ok'; instant: Date; offset: string }
  | { kind: 'gap'; message: string }
  | { kind: 'ambiguous'; options: Array<{ instant: Date; offset: string }>; message: string }
  | { kind: 'invalid'; message: string };

/**
 * Resolve a local wall time (YYYY-MM-DDTHH:mm[:ss]) in an IANA zone.
 * - Nonexistent times (spring-forward gap) => 'gap' (SC-02: reject).
 * - Repeated times (fall-back fold) => 'ambiguous' with both offsets; caller must choose.
 */
export function resolveWallTime(local: string, tz: string): WallTimeResolution {
  if (!isValidTimeZone(tz)) return { kind: 'invalid', message: `Unknown time zone "${tz}"` };
  const m = LOCAL_RE.exec(local);
  if (!m) return { kind: 'invalid', message: 'Time must be in the form YYYY-MM-DDTHH:mm' };
  const [y, mo, d, h, mi, s] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(asUtc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    return { kind: 'invalid', message: 'That date or time does not exist on the calendar' };
  }
  // Candidate offsets: those in effect around the wall time (±36h covers every real transition).
  const candidates = new Set<number>();
  for (const deltaH of [-36, -24, -12, -6, -3, 0, 3, 6, 12, 24, 36]) {
    candidates.add(offsetMinutes(new Date(asUtc + deltaH * 3_600_000), tz));
  }
  const matches: Array<{ instant: Date; offset: string }> = [];
  for (const off of [...candidates].sort((a, b) => b - a)) {
    const instant = new Date(asUtc - off * 60_000);
    const w = wallClock(instant, tz);
    if (w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi && w.s === s) {
      if (!matches.some((x) => x.instant.getTime() === instant.getTime())) matches.push({ instant, offset: formatOffset(off) });
    }
  }
  matches.sort((a, b) => a.instant.getTime() - b.instant.getTime());
  if (matches.length === 0) {
    return { kind: 'gap', message: `${local.replace('T', ' ')} does not exist in ${tz} because clocks go forward. Choose a different time.` };
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous', options: matches,
      message: `${local.replace('T', ' ')} happens twice in ${tz} because clocks go back. Choose ${matches.map((x) => `UTC${x.offset}`).join(' or ')}.`,
    };
  }
  return { kind: 'ok', instant: matches[0]!.instant, offset: matches[0]!.offset };
}

/** Resolve with an explicit offset choice for ambiguous wall times. */
export function resolveWallTimeWithOffset(local: string, tz: string, offset?: string | null): WallTimeResolution {
  const r = resolveWallTime(local, tz);
  if (r.kind !== 'ambiguous') return r;
  if (!offset) return r;
  const pick = r.options.find((o) => o.offset === offset);
  return pick ? { kind: 'ok', instant: pick.instant, offset: pick.offset } : r;
}

/** Format an instant as local wall time string YYYY-MM-DDTHH:mm in tz. */
export function toLocalInput(instant: Date, tz: string): string {
  const w = wallClock(instant, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.y}-${p(w.mo)}-${p(w.d)}T${p(w.h)}:${p(w.mi)}`;
}

export function formatInZone(instant: Date | string, tz: string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz }).format(typeof instant === 'string' ? new Date(instant) : instant);
}

export function zoneAbbreviation(instant: Date, tz: string): string {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }).formatToParts(instant);
  return p.find((x) => x.type === 'timeZoneName')?.value ?? tz;
}
