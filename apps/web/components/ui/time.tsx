'use client';
import { offsetMinutes } from '@social-lite/core';
import { fmtDate, fmtDateTime, fmtTime, zoneAbbr } from '@/lib/client/format';
import { useBrowserTimeZone } from '@/lib/client/hooks';
import { cn } from './cn';

/**
 * An instant shown in an explicit zone with its abbreviation (e.g. "Fri 6 Nov 2026, 14:30 GMT").
 * If the viewer's browser zone differs, it is shown only as secondary information.
 */
export function TimeWithZone({
  instant, tz, format = 'datetime', showBrowser = false, className,
}: { instant: string | null | undefined; tz: string; format?: 'datetime' | 'time' | 'date'; showBrowser?: boolean; className?: string }) {
  const browser = useBrowserTimeZone();
  if (!instant) return <span className={cn('text-muted', className)}>—</span>;
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return <span className={className}>—</span>;
  const main = format === 'time' ? fmtTime(d, tz) : format === 'date' ? fmtDate(d, tz) : fmtDateTime(d, tz);
  const abbr = format === 'date' ? null : zoneAbbr(d, tz);
  const differs = showBrowser && browser && browser !== tz && offsetMinutes(d, browser) !== offsetMinutes(d, tz);
  return (
    <span className={cn('tabular', className)}>
      <time dateTime={d.toISOString()} title={`${tz} · ${d.toISOString()}`}>
        {main}
        {abbr ? <span className="ml-1 text-muted">{abbr}</span> : null}
      </time>
      {differs && browser ? (
        <span className="ml-2 text-xs text-subtle">
          ({fmtTime(d, browser)} {zoneAbbr(d, browser)} your time)
        </span>
      ) : null}
    </span>
  );
}
