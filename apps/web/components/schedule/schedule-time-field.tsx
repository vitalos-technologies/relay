'use client';
import { useMemo } from 'react';
import { CalendarClock } from 'lucide-react';
import { offsetMinutes, resolveWallTime, type WallTimeResolution } from '@social-lite/core';
import { allTimeZones, fmtDateTime, fmtTime, zoneAbbr } from '@/lib/client/format';
import { useBrowserTimeZone } from '@/lib/client/hooks';
import { isApiError } from '@/lib/client/api';
import { Banner, Field, Input, RadioGroup, Select } from '@/components/ui';

export interface WallTimeValue { local: string; tz: string; offset: string | null }

export function resolveValue(v: WallTimeValue): WallTimeResolution & { chosen?: { instant: Date; offset: string } } {
  if (!v.local) return { kind: 'invalid', message: 'Choose a date and time.' };
  const r = resolveWallTime(v.local, v.tz);
  if (r.kind === 'ambiguous' && v.offset) {
    const pick = r.options.find((o) => o.offset === v.offset);
    if (pick) return { ...r, chosen: pick };
  }
  return r;
}

/** Instant the value will be scheduled for, or null when it cannot be resolved without more input. */
export function resolvedInstant(v: WallTimeValue): Date | null {
  const r = resolveValue(v);
  if (r.kind === 'ok') return r.instant;
  if (r.kind === 'ambiguous' && r.chosen) return r.chosen.instant;
  return null;
}

/**
 * Detects the server's "ambiguous_time" conflict (DST fold). Accepts either a dedicated code or
 * details.reason, and offset options as strings or objects; falls back to local computation.
 */
export function ambiguityFromError(e: unknown, v: WallTimeValue): string[] | null {
  if (!isApiError(e) || e.status !== 409) return null;
  const d = e.details ?? {};
  const isAmb = e.code === 'ambiguous_time' || d.reason === 'ambiguous_time' || d.code === 'ambiguous_time' || Array.isArray(d.options) || Array.isArray(d.offsets);
  if (!isAmb) return null;
  const raw = (Array.isArray(d.options) ? d.options : Array.isArray(d.offsets) ? d.offsets : []) as unknown[];
  const offsets = raw
    .map((o) => (typeof o === 'string' ? o : (o as { offset?: string })?.offset))
    .filter((x): x is string => typeof x === 'string' && /^[+-]\d{2}:\d{2}$/.test(x));
  if (offsets.length) return offsets;
  const r = resolveWallTime(v.local, v.tz);
  return r.kind === 'ambiguous' ? r.options.map((o) => o.offset) : null;
}

export function ScheduleTimeField({
  value, onChange, preferredZones, label = 'Date and time', requireFuture = true, serverAmbiguity,
}: {
  value: WallTimeValue;
  onChange: (v: WallTimeValue) => void;
  preferredZones: Array<{ tz: string; label: string }>;
  label?: string;
  requireFuture?: boolean;
  /** offsets the server reported as valid for an ambiguous time */
  serverAmbiguity?: string[] | null;
}) {
  const browser = useBrowserTimeZone();
  const zones = useMemo(() => allTimeZones(), []);
  const res = resolveValue(value);
  const preferred = preferredZones.filter((z, i, a) => a.findIndex((x) => x.tz === z.tz) === i);
  const instant = res.kind === 'ok' ? res.instant : res.kind === 'ambiguous' && res.chosen ? res.chosen.instant : null;
  const past = instant && requireFuture && instant.getTime() < Date.now() - 30_000;

  const ambOptions = res.kind === 'ambiguous'
    ? res.options
    : serverAmbiguity?.length
      ? serverAmbiguity.map((o) => ({ offset: o, instant: null as Date | null }))
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={label}>
          <Input type="datetime-local" value={value.local} onChange={(e) => onChange({ ...value, local: e.target.value, offset: null })} />
        </Field>
        <Field label="Time zone" info="The schedule keeps this zone — your browser’s zone is never assumed.">
          <Select value={value.tz} onChange={(e) => onChange({ ...value, tz: e.target.value, offset: null })}>
            {preferred.length ? (
              <optgroup label="Suggested">
                {preferred.map((z) => <option key={`p-${z.tz}`} value={z.tz}>{z.label}</option>)}
              </optgroup>
            ) : null}
            <optgroup label="All time zones">
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </optgroup>
          </Select>
        </Field>
      </div>

      {res.kind === 'gap' ? (
        <Banner tone="danger" role="alert" title="That time doesn’t exist">{res.message}</Banner>
      ) : res.kind === 'invalid' && value.local ? (
        <Banner tone="danger" role="alert">{res.message}</Banner>
      ) : null}

      {ambOptions ? (
        <div className="rounded-lg bg-warn-soft p-4">
          <RadioGroup
            name="offset"
            legend={`${value.local.replace('T', ' ')} occurs twice (clocks go back). Which one?`}
            value={value.offset ?? ''}
            onChange={(o) => onChange({ ...value, offset: o })}
            options={ambOptions.map((o, i) => ({
              value: o.offset,
              label: `${i === 0 ? 'First' : 'Second'} · UTC${o.offset}${o.instant ? ` (${zoneAbbr(o.instant, value.tz)})` : ''}`,
              description: o.instant ? `${o.instant.toISOString().slice(11, 16)} UTC` : undefined,
            }))}
          />
        </div>
      ) : null}

      {instant ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]" aria-live="polite">
          <CalendarClock aria-hidden className="size-4 text-muted" />
          <strong className="font-semibold">{fmtDateTime(instant, value.tz)} {zoneAbbr(instant, value.tz)}</strong>
          <span className="text-muted">· {instant.toISOString().slice(11, 16)} UTC</span>
          {browser && browser !== value.tz && offsetMinutes(instant, browser) !== offsetMinutes(instant, value.tz) ? (
            <span className="text-subtle">· {fmtTime(instant, browser)} {zoneAbbr(instant, browser)} yours</span>
          ) : null}
        </p>
      ) : null}
      {past ? <Banner tone="warn" role="alert">That time has passed.</Banner> : null}
    </div>
  );
}

/** Whether the field is complete and valid for submission. */
export function wallTimeReady(v: WallTimeValue, requireFuture = true): boolean {
  const i = resolvedInstant(v);
  if (!i) return false;
  return !requireFuture || i.getTime() >= Date.now() - 30_000;
}
