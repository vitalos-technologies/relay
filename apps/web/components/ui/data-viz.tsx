'use client';
// V3 design system: metric tiles, chart panels and a dependency-free SVG line chart.
// Rules (docs/V3_DESIGN_SYSTEM.md): null = missing (never drawn as 0, lines break), previous period is neutral + dashed,
// every series has a label (legend + dash pattern, never colour alone), each chart has a keyboard summary and a table view.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, Sparkles, ChartLine, Table2 } from 'lucide-react';
import { cn } from './cn';
import { Segmented } from './field';
import { InfoTip } from './tooltip';

// ------------------------------------------------------------------ formatting
export type MetricUnit = 'count' | 'percent' | 'minutes' | 'seconds';

export function fmtMetric(v: number | null | undefined, unit: MetricUnit = 'count', compact = true): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (unit === 'percent') return `${(v * 100).toFixed(v * 100 >= 10 ? 1 : 2)}%`;
  if (unit === 'minutes') return v >= 600 ? `${Math.round(v / 60).toLocaleString('en-GB')} h` : `${Math.round(v).toLocaleString('en-GB')} min`;
  if (unit === 'seconds') return v >= 120 ? `${(v / 60).toFixed(1)} min` : `${Math.round(v)} s`;
  if (compact && Math.abs(v) >= 10_000) return new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  return Math.round(v).toLocaleString('en-GB');
}

// ------------------------------------------------------------------ delta chip
export type DeltaState = 'up' | 'down' | 'flat' | 'new' | 'insufficient';

/** Change vs the previous period: icon + text (never colour alone). Up is not automatically "good". */
export function DeltaChip({ state, pct, className }: { state: DeltaState; pct: number | null; className?: string }) {
  const Icon = state === 'up' ? ArrowUpRight : state === 'down' ? ArrowDownRight : state === 'new' ? Sparkles : Minus;
  const text = state === 'new' ? 'New' : state === 'insufficient' ? 'No baseline' : state === 'flat' ? 'No change'
    : `${pct !== null ? `${pct > 0 ? '+' : ''}${(pct * 100).toFixed(Math.abs(pct) < 0.1 ? 1 : 0)}%` : ''}`;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium tabular', state === 'up' ? 'text-success' : state === 'down' ? 'text-danger' : 'text-muted', className)}>
      <Icon aria-hidden className="size-3.5" />
      {text}
      <span className="sr-only"> vs previous period</span>
    </span>
  );
}

// ------------------------------------------------------------------ metric card
export function MetricCard({
  label, value, unit = 'count', delta, foot, info, href, icon, tone, className, onClick,
}: {
  label: ReactNode; value: number | string | null; unit?: MetricUnit; delta?: { state: DeltaState; pct: number | null } | null;
  foot?: ReactNode; info?: ReactNode; href?: string; icon?: ReactNode; tone?: 'danger' | 'warn' | null; className?: string; onClick?: () => void;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-[13px] text-muted">
        {icon ? <span aria-hidden className="[&>svg]:size-4">{icon}</span> : null}
        <span className="min-w-0 truncate">{label}</span>
        {info ? <InfoTip>{info}</InfoTip> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={cn('text-[24px] font-semibold leading-none tracking-[-0.02em] tabular sm:text-[28px]', tone === 'danger' && 'text-danger', tone === 'warn' && 'text-warn')}>
          {typeof value === 'string' ? value : fmtMetric(value, unit)}
        </span>
        {delta ? <DeltaChip state={delta.state} pct={delta.pct} /> : null}
      </div>
      {foot ? <div className="mt-2 truncate text-xs text-subtle">{foot}</div> : null}
    </>
  );
  const cls = cn('block min-w-0 rounded-[var(--radius-card)] border border-border bg-surface p-3.5 text-left sm:p-4', (href || onClick) && 'transition-colors hover:border-border-strong hover:bg-raised/40', className);
  if (href) return <a href={href} className={cls}>{body}</a>;
  if (onClick) return <button type="button" onClick={onClick} className={cls}>{body}</button>;
  return <div className={cls}>{body}</div>;
}

// ------------------------------------------------------------------ chart panel (chart ↔ table)
export function ChartPanel({
  title, actions, summary, chart, table, footer, className, info, id,
}: {
  title: ReactNode; actions?: ReactNode; summary: string; chart: ReactNode; table: ReactNode; footer?: ReactNode; className?: string; info?: ReactNode; id?: string;
}) {
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const hid = useId();
  return (
    <section aria-labelledby={id ?? hid} className={cn('min-w-0 rounded-[var(--radius-card)] border border-border bg-surface', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <h2 id={id ?? hid} className="flex min-w-0 items-center gap-1 text-[14px] font-semibold">{title}{info ? <InfoTip>{info}</InfoTip> : null}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <Segmented
            size="sm"
            label="Display as"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'chart', label: <span className="sr-only sm:not-sr-only">Chart</span>, icon: <ChartLine aria-hidden className="size-3.5" /> },
              { value: 'table', label: <span className="sr-only sm:not-sr-only">Table</span>, icon: <Table2 aria-hidden className="size-3.5" /> },
            ]}
          />
        </div>
      </div>
      <p className="sr-only" aria-live="polite">{summary}</p>
      <div className="px-4 pb-4 pt-3">{mode === 'chart' ? chart : <div className="max-h-[360px] overflow-auto">{table}</div>}</div>
      {footer ? <div className="border-t border-border px-4 py-2.5 text-xs text-muted">{footer}</div> : null}
    </section>
  );
}

// ------------------------------------------------------------------ legend
export interface SeriesStyle { color: string; dash?: string; label: string }

export function Legend({ items, className }: { items: SeriesStyle[]; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted', className)} aria-label="Legend">
      {items.map((s) => (
        <li key={s.label} className="inline-flex items-center gap-1.5">
          <svg width="18" height="8" aria-hidden><line x1="1" y1="4" x2="17" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} strokeLinecap="round" /></svg>
          {s.label}
        </li>
      ))}
    </ul>
  );
}

export const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
export const SERIES_DASHES = [undefined, '6 3', '2 3', '8 3 2 3', '1 4'];

// ------------------------------------------------------------------ line chart
export interface LineSeries extends SeriesStyle { key: string; values: Array<number | null> }

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/**
 * Multi-series line chart over a shared x domain (labels). Null breaks the line; a lone point is drawn as a dot.
 * Keyboard: focus the plot, ←/→ move the crosshair, Home/End jump. Tooltip lists every series at that x.
 */
export function LineChart({
  labels, series, previous, unit = 'count', height = 240, xLabel, ariaLabel,
}: {
  labels: string[]; series: LineSeries[]; previous?: LineSeries | null; unit?: MetricUnit; height?: number;
  xLabel?: (label: string, i: number) => string; ariaLabel: string;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const all = [...series, ...(previous ? [previous] : [])];
  const max = niceMax(Math.max(0, ...all.flatMap((s) => s.values.filter((v): v is number => v !== null))));
  const padL = 44, padR = 12, padT = 12, padB = 26;
  const w = Math.max(width, 200);
  const iw = w - padL - padR, ih = height - padT - padB;
  const n = labels.length;
  const x = (i: number) => padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => padT + ih - (v / max) * ih;
  const fmtX = xLabel ?? ((l: string) => l);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const xticks = n <= 1 ? [0] : n <= 8 ? labels.map((_, i) => i) : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];

  const paths = (s: LineSeries) => {
    const segs: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> = [];
    s.values.forEach((v, i) => {
      if (v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v)]);
    });
    if (cur.length) segs.push(cur);
    return segs;
  };

  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === 'Home') setHover(0);
    else if (e.key === 'End') setHover(n - 1);
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };
  const tipLeft = hover !== null ? Math.min(Math.max(x(hover) + 10, 8), w - 188) : 0;

  return (
    <div ref={wrap} className="relative w-full select-none">
      <svg
        width={w}
        height={height}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - r.left;
          const i = n <= 1 ? 0 : Math.round(((px - padL) / iw) * (n - 1));
          setHover(Math.max(0, Math.min(n - 1, i)));
        }}
        className="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
            <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--subtle)" className="tabular">{fmtMetric(t, unit)}</text>
          </g>
        ))}
        {xticks.map((i) => (
          <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'} fontSize="11" fill="var(--subtle)">{fmtX(labels[i] ?? '', i)}</text>
        ))}
        {previous ? paths(previous).map((seg, k) => (
          seg.length > 1
            ? <polyline key={`p${k}`} points={seg.map((p) => p.join(',')).join(' ')} fill="none" stroke={previous.color} strokeWidth={1.5} strokeDasharray={previous.dash ?? '4 4'} strokeLinejoin="round" strokeLinecap="round" />
            : <circle key={`p${k}`} cx={seg[0]![0]} cy={seg[0]![1]} r={2} fill={previous.color} />
        )) : null}
        {series.map((s) => paths(s).map((seg, k) => (
          seg.length > 1
            ? <polyline key={`${s.key}${k}`} points={seg.map((p) => p.join(',')).join(' ')} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
            : <circle key={`${s.key}${k}`} cx={seg[0]![0]} cy={seg[0]![1]} r={3} fill={s.color} />
        )))}
        {hover !== null ? (
          <g aria-hidden>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ih} stroke="var(--border-strong)" strokeWidth={1} />
            {series.map((s) => s.values[hover] !== null && s.values[hover] !== undefined
              ? <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} /> : null)}
          </g>
        ) : null}
      </svg>
      {hover !== null ? (
        <div role="status" className="pointer-events-none absolute top-1 z-10 w-[180px] rounded-lg border border-border bg-raised px-3 py-2 text-xs shadow-[var(--shadow)]" style={{ left: tipLeft }}>
          <p className="mb-1 font-medium text-fg">{fmtX(labels[hover] ?? '', hover)}</p>
          <ul className="flex flex-col gap-0.5">
            {all.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <svg width="12" height="6" aria-hidden><line x1="0" y1="3" x2="12" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} /></svg>
                <span className="min-w-0 flex-1 truncate text-muted">{s.label}</span>
                <span className="font-medium tabular text-fg">{s.values[hover] === null || s.values[hover] === undefined ? 'No data' : fmtMetric(s.values[hover]!, unit, false)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ horizontal bars (comparisons, shares)
export function BarList({
  rows, unit = 'count', max, className, label,
}: {
  rows: Array<{ key: string; label: ReactNode; value: number | null; note?: ReactNode; href?: string }>; unit?: MetricUnit; max?: number; className?: string; label: string;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <ul className={cn('flex flex-col gap-2.5', className)} aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="min-w-0">
          <div className="mb-1 flex items-center justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2 truncate">{r.label}</span>
            <span className="shrink-0 font-medium tabular">{r.value === null ? <span className="font-normal text-muted">{r.note ?? 'No data'}</span> : fmtMetric(r.value, unit, false)}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken" aria-hidden>
            {r.value !== null ? <div className="h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${Math.max(2, (r.value / top) * 100)}%` }} /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Small ratio meter with text (coverage). */
export function CoverageMeter({ ratio, label, className }: { ratio: number | null; label: ReactNode; className?: string }) {
  const pct = ratio === null ? null : Math.round(ratio * 100);
  return (
    <span className={cn('inline-flex items-center gap-2 text-xs text-muted', className)}>
      <span aria-hidden className="relative h-1.5 w-16 overflow-hidden rounded-full bg-sunken">
        {pct !== null ? <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--chart-2)]" style={{ width: `${pct}%` }} /> : null}
      </span>
      {label}
    </span>
  );
}

/** Helper: memoised series styling by stable key order (colour follows the entity, never its rank). */
export function useSeriesStyles(keys: string[]) {
  const sig = keys.join('|');
  return useMemo(() => {
    const ks = sig ? sig.split('|') : [];
    const m = new Map<string, { color: string; dash?: string }>();
    // Fixed order, never cycled: callers fold anything past the 5th series into the table view.
    ks.slice(0, SERIES_COLORS.length).forEach((k, i) => m.set(k, { color: SERIES_COLORS[i]!, dash: SERIES_DASHES[i] }));
    return m;
  }, [sig]);
}
