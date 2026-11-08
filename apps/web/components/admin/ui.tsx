'use client';
// Admin building blocks on top of the Relay design system: health vocabulary badge, overview tile, reason dialog,
// responsive record list (table ≥ md, cards on phones) and "not available" panels for honest gaps.
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import {
  Ban, ChevronRight, CircleCheck, CircleDashed, CircleQuestionMark, FlaskConical, OctagonX, Pause, PlugZap, TriangleExclamationPoint, type LucideIcon,
} from 'lucide-react';
import type { HealthState } from '@social-lite/core/contracts/v31-admin';
import { Badge, Card, ConfirmDialog, Field, Textarea, cn, type ButtonVariant } from '@/components/ui';
import type { Tone } from '@/components/ui/feedback';

export const HEALTH: Record<HealthState, { label: string; tone: Tone; Icon: LucideIcon }> = {
  healthy: { label: 'Healthy', tone: 'success', Icon: CircleCheck },
  degraded: { label: 'Degraded', tone: 'warn', Icon: TriangleExclamationPoint },
  failed: { label: 'Failed', tone: 'danger', Icon: OctagonX },
  paused: { label: 'Paused', tone: 'neutral', Icon: Pause },
  unknown: { label: 'Unknown', tone: 'neutral', Icon: CircleQuestionMark },
  awaiting_setup: { label: 'Awaiting setup', tone: 'info', Icon: CircleDashed },
  unsupported: { label: 'Unsupported', tone: 'neutral', Icon: Ban },
  demo: { label: 'Demo', tone: 'info', Icon: FlaskConical },
};

export function HealthBadge({ state, className }: { state: HealthState; className?: string }) {
  const h = HEALTH[state];
  return <Badge tone={h.tone} className={className} icon={<h.Icon aria-hidden className="size-3.5" />}>{h.label}</Badge>;
}

/** Overview card: label, state, one number, one line, drills into the records (whole card is the link). */
export function StatTile({ label, state, value, detail, href }: { label: string; state: HealthState; value: number | null; detail: string | null; href: string }) {
  return (
    <Link href={href} className="group flex min-h-[132px] min-w-0 flex-col rounded-[var(--radius-card)] border border-border bg-surface p-4 transition-colors hover:border-[color-mix(in_srgb,var(--accent-text)_40%,var(--border))] focus-visible:outline-2">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-[13px] font-medium text-muted">{label}</span>
        <HealthBadge state={state} />
      </div>
      <span className="mt-3 text-[26px] font-semibold leading-none tabular">{value === null ? '—' : value.toLocaleString()}</span>
      <span className="mt-auto flex items-center gap-1 pt-3 text-xs text-muted">
        <span className="min-w-0 flex-1 truncate">{detail ?? ''}</span>
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

/** Confirm a consequential action with a required reason (recorded in the audit log). */
export function ReasonDialog({
  open, onOpenChange, title, description, confirmLabel, confirmVariant = 'primary', onConfirm, children, min = 10,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; description?: ReactNode; confirmLabel: string; confirmVariant?: ButtonVariant;
  onConfirm: (reason: string) => Promise<unknown>; children?: ReactNode; min?: number;
}) {
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog open={open} onOpenChange={(o) => { if (!o) setReason(''); onOpenChange(o); }} title={title} description={description} size="md"
      confirmLabel={confirmLabel} confirmVariant={confirmVariant}
      confirmDisabledReason={reason.trim().length < min ? `Give a reason (${min}+ characters)` : null}
      onConfirm={async () => { await onConfirm(reason.trim()); setReason(''); }}>
      <div className="flex flex-col gap-4">
        {children}
        <Field label="Reason" hint="Recorded in the audit log">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

/** Honest gap: a module that has no product implementation (never a fake screen). */
export function NotAvailable({ title, why, className }: { title: string; why: string; className?: string }) {
  return (
    <Card className={cn('flex items-start gap-3 p-4', className)}>
      <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"><PlugZap aria-hidden className="size-4" /></span>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium">{title}<Badge>Not available</Badge></p>
        <p className="mt-1 text-[13px] text-muted">{why}</p>
      </div>
    </Card>
  );
}

export interface Column<T> { key: string; label: ReactNode; cell: (r: T) => ReactNode; className?: string; /** hidden below lg */ secondary?: boolean }

/**
 * Records as a table on ≥ md and as stacked cards on phones (primary fields first; the rest in the detail drawer).
 * `onOpen` makes each row a button (keyboard + screen reader friendly).
 */
export function RecordList<T>({ rows, columns, rowKey, onOpen, card, caption, selected }: {
  rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; onOpen?: (r: T) => void; card: (r: T) => ReactNode; caption: string; selected?: string | null;
}) {
  return (
    <>
      <div className="relative hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              {columns.map((c) => <th key={c.key} scope="col" className={cn('whitespace-nowrap px-3 py-2.5 font-medium first:pl-4', c.secondary && 'max-lg:hidden', c.className)}>{c.label}</th>)}
              {onOpen ? <th scope="col" className="w-8 pr-4"><span className="sr-only">Open</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const k = rowKey(r);
              return (
                <tr key={k} onClick={onOpen ? () => onOpen(r) : undefined}
                  className={cn('border-b border-border last:border-b-0', onOpen && 'cursor-pointer hover:bg-raised/50', selected === k && 'bg-raised/70')}>
                  {columns.map((c) => <td key={c.key} className={cn('px-3 py-2.5 align-middle first:pl-4', c.secondary && 'max-lg:hidden', c.className)}>{c.cell(r)}</td>)}
                  {onOpen ? (
                    <td className="pr-4 text-right">
                      <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(r); }} className="touch-target inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg" aria-label="Open details">
                        <ChevronRight aria-hidden className="size-4" />
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-border md:hidden" aria-label={caption}>
        {rows.map((r) => (
          <li key={rowKey(r)}>
            {onOpen ? (
              <button type="button" onClick={() => onOpen(r)} className="flex min-h-[56px] w-full items-start gap-3 px-4 py-3 text-left active:bg-raised">
                <span className="min-w-0 flex-1">{card(r)}</span>
                <ChevronRight aria-hidden className="mt-1 size-4 shrink-0 text-subtle" />
              </button>
            ) : <div className="px-4 py-3">{card(r)}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Small "x ago" with the absolute time on hover. */
export function Ago({ at, className }: { at: string | null | undefined; className?: string }) {
  if (!at) return <span className={cn('text-muted', className)}>—</span>;
  const s = Math.round((Date.now() - Date.parse(at)) / 1000);
  const abs = Math.abs(s);
  const v = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return <time dateTime={at} title={new Date(at).toLocaleString()} className={cn('tabular', className)}>{s >= 0 ? `${v} ago` : `in ${v}`}</time>;
}
