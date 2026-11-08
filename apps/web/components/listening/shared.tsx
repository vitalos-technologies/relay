'use client';
// Listening UI building blocks: coverage statement (every chart states its sources, history, sample and query version),
// sentiment chip (inferred + uncertainty, correction shown), dataset banner, range select, labels.
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { ChevronDown, CircleAlert, FlaskConical } from 'lucide-react';
import type { ListeningCoverage, SentimentLabel, ObservationDto, SearchRole } from '@social-lite/core/contracts/v35-listening';
import { fmtRelative } from '@/lib/client/format';
import { Badge, Banner, InfoTip, Select, cn } from '@/components/ui';

export const ROLE_LABEL: Record<SearchRole, string> = { own: 'Own brand', competitor: 'Competitor', topic: 'Topic' };
export const SENTIMENT_LABEL: Record<SentimentLabel, string> = { positive: 'Positive', negative: 'Negative', neutral: 'Neutral', mixed: 'Mixed', unscored: 'Not scored' };
export const KIND_LABEL: Record<ObservationDto['kind'], string> = { comment: 'Comment', mention: 'Mention', review: 'Review' };
export const RANGES = [1, 7, 30, 90] as const;

export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
export const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

export function RangeSelect({ value, onChange, className }: { value: number; onChange: (d: number) => void; className?: string }) {
  return (
    <Select aria-label="Period" value={String(value)} onChange={(e) => onChange(Number(e.target.value))} className={cn('w-36', className)}>
      {RANGES.map((d) => <option key={d} value={d}>{d === 1 ? 'Last 24 hours' : `Last ${d} days`}</option>)}
    </Select>
  );
}

export function SimulatedBanner({ coverage }: { coverage: ListeningCoverage | null | undefined }) {
  if (coverage?.dataset !== 'simulated') return null;
  return (
    <Banner tone="info" icon={<FlaskConical aria-hidden className="size-4 text-info" />} title="Simulated data">
      From simulated channels only — not real customers.
    </Banner>
  );
}

const STATE_TEXT: Record<ListeningCoverage['state'], string> = {
  matches: '', no_matches: 'No matches — sources were collecting.', not_collected: 'Nothing collected — no source is monitored for this brand.',
  incomplete: 'No matches, but collection was incomplete.',
};

/** One-line coverage statement + expandable details. Required next to every listening number. */
export function CoverageNote({ coverage, className, compact }: { coverage: ListeningCoverage; className?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const srcs = coverage.sources.filter((s) => s.channels > 0);
  const src = srcs.length ? srcs.map((s) => `${s.label}${s.channels > 1 ? ` ×${s.channels}` : ''}`).join(', ') : 'No source';
  const warn = coverage.incomplete.length > 0 || coverage.partial_window || coverage.state === 'not_collected';
  return (
    <div className={cn('text-xs text-muted', className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex min-w-0 items-start gap-1.5">
        {warn ? <CircleAlert aria-label="Coverage limited" className="mt-px size-3.5 shrink-0 text-warn" /> : null}
        <span>{[src, coverage.history_from ? `since ${fmtDay(coverage.history_from)}` : null, `n = ${coverage.sample.unique.toLocaleString('en-GB')}`,
          coverage.query_version ? `query v${coverage.query_version}` : null, coverage.retrieved_at ? `retrieved ${fmtRelative(coverage.retrieved_at)}` : null].filter(Boolean).join(' · ')}</span>
        </span>
        {coverage.dataset === 'simulated' ? <Badge tone="info" className="h-5 px-1.5 text-[11px]">Simulated</Badge> : null}
        {!compact ? (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-0.5 font-medium text-fg/80 hover:text-fg">
            Coverage<ChevronDown aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        ) : null}
      </div>
      {STATE_TEXT[coverage.state] ? <p className="mt-1 text-fg/80">{STATE_TEXT[coverage.state]}</p> : null}
      {open ? (
        <dl className="mt-2 grid grid-cols-[minmax(110px,auto)_1fr] gap-x-3 gap-y-1.5 rounded-md bg-sunken p-3 text-[12px]">
          <dt>Sources</dt><dd className="text-fg">{coverage.sources.map((s) => `${s.label} (${s.channels} · ${s.status.replace('_', ' ')})`).join(', ') || 'None'}</dd>
          <dt>Window</dt><dd className="text-fg">{fmtWhen(coverage.window.from)} – {fmtWhen(coverage.window.to)}{coverage.partial_window ? ' · starts before monitoring' : ''}</dd>
          <dt>Sample</dt><dd className="text-fg">{coverage.sample.observations} mentions · {coverage.sample.unique} unique · {coverage.sample.duplicates_collapsed} repeats collapsed · {coverage.sample.removed_at_source} removed at source</dd>
          {coverage.incomplete.length ? <><dt>Incomplete</dt><dd className="text-warn">{coverage.incomplete.map((i) => `${i.channel}: ${i.reason}`).join(' · ')}</dd></> : null}
          {coverage.awaiting.length ? <><dt>Not included</dt><dd className="text-fg">{coverage.awaiting.map((a) => a.label).join(', ')} — <Link className="underline" href="/settings/listening/sources">awaiting activation</Link></dd></> : null}
          <dt>Repeats</dt><dd className="text-fg">{coverage.methods.dedupe}</dd>
          <dt>Sentiment</dt><dd className="text-fg">{coverage.methods.sentiment}</dd>
          <dt>Language</dt><dd className="text-fg">{coverage.methods.language}</dd>
          <dt>Limits</dt><dd className="text-fg">{coverage.limitations.join(' ')}</dd>
        </dl>
      ) : null}
    </div>
  );
}

const TONE: Record<SentimentLabel, 'success' | 'danger' | 'neutral' | 'warn' | 'info'> = { positive: 'success', negative: 'danger', neutral: 'neutral', mixed: 'warn', unscored: 'neutral' };

/** Inferred sentiment with its uncertainty; a person's correction wins and is labelled. */
export function SentimentChip({ s, className }: { s: ObservationDto['sentiment']; className?: string }) {
  const label = SENTIMENT_LABEL[s.effective];
  const corrected = !!s.corrected;
  const unsure = !corrected && s.uncertain && s.effective !== 'unscored';
  const why = corrected
    ? `Corrected by ${s.corrected!.by ?? 'a teammate'} (inferred: ${SENTIMENT_LABEL[s.label]})`
    : s.effective === 'unscored' ? 'Not scored: the lexicon covers English only'
      : `Inferred (lexicon) · confidence ${Math.round(s.confidence * 100)}%${s.evidence.length ? ` · from: ${s.evidence.join(', ')}` : ' · no sentiment words'}`;
  return (
    <Badge tone={TONE[s.effective]} title={why} className={cn('h-5 px-1.5 text-[11px]', unsure && 'border-dashed', className)}>
      {label}{unsure ? ' · unsure' : ''}{corrected ? ' · corrected' : ''}
    </Badge>
  );
}

export function Definition({ children }: { children: ReactNode }) {
  return <InfoTip label="How this is measured">{children}</InfoTip>;
}

/** Two-letter language tag (or "—"). */
export const langTag = (l: string | null) => (l && l !== 'und' ? l.toUpperCase() : '—');

/** Accessible table view for a chart (ChartPanel "table" mode). */
export function SimpleTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-[13px]">
        <thead><tr>{head.map((h) => <th key={h} scope="col" className="sticky top-0 bg-surface px-2 py-1.5 text-left text-xs font-medium text-muted">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-border">{r.map((c, j) => <td key={j} className="px-2 py-1.5 tabular">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
