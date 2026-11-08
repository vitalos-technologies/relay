// Formatting helpers. Every time is shown in an explicit IANA zone with its abbreviation;
// the browser zone is never assumed for schedules.
import { formatInZone, toLocalInput, zoneAbbreviation } from '@social-lite/core';

export function fmtTime(instant: string | Date, tz: string): string {
  return formatInZone(instant, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
export function fmtDate(instant: string | Date, tz: string): string {
  return formatInZone(instant, tz, { weekday: 'short', day: 'numeric', month: 'short' });
}
export function fmtDateTime(instant: string | Date, tz: string): string {
  return formatInZone(instant, tz, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
export function zoneAbbr(instant: string | Date, tz: string): string {
  try {
    return zoneAbbreviation(typeof instant === 'string' ? new Date(instant) : instant, tz);
  } catch {
    return tz;
  }
}
export function localDateKey(instant: string | Date, tz: string): string {
  return toLocalInput(typeof instant === 'string' ? new Date(instant) : instant, tz).slice(0, 10);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' }) : null;
export function fmtRelative(instant: string | Date, now: number = Date.now()): string {
  const t = typeof instant === 'string' ? new Date(instant).getTime() : instant.getTime();
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (!rtf) return new Date(t).toISOString();
  if (abs < 45) return diff < 0 ? 'just now' : 'in a few seconds';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86_400), 'day');
}

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat('en-GB').format(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', editor: 'Editor', approver: 'Approver', viewer: 'Viewer',
};

export function allTimeZones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) return fn('timeZone');
  } catch {
    /* ignore */
  }
  return ['Europe/London', 'UTC', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney'];
}

export function postTitle(p: { title?: string | null; excerpt?: string | null; post_title?: string | null }): string {
  const t = (p.title ?? p.post_title ?? '').trim();
  if (t) return t;
  const e = (p.excerpt ?? '').trim();
  return e ? (e.length > 60 ? `${e.slice(0, 60)}…` : e) : 'Untitled post';
}
