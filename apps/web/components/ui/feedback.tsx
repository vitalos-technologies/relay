'use client';
import { useState, type ReactNode } from 'react';
import { CircleCheck, CircleExclamationPoint, Copy, Info, LoaderCircle, OctagonX, RefreshCw, TriangleExclamationPoint, WifiOff } from 'lucide-react';
import { cn } from './cn';
import { isApiError } from '@/lib/client/api';

export type Tone = 'info' | 'warn' | 'danger' | 'success' | 'neutral';

const toneClass: Record<Tone, string> = {
  info: 'border-[color-mix(in_srgb,var(--info)_35%,transparent)] bg-info-soft',
  warn: 'border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-warn-soft',
  danger: 'border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-danger-soft',
  success: 'border-[color-mix(in_srgb,var(--success)_35%,transparent)] bg-success-soft',
  neutral: 'border-border bg-raised',
};
const toneText: Record<Tone, string> = { info: 'text-info', warn: 'text-warn', danger: 'text-danger', success: 'text-success', neutral: 'text-muted' };
export const ToneIcon = ({ tone, className }: { tone: Tone; className?: string }) => {
  const C = tone === 'danger' ? OctagonX : tone === 'warn' ? TriangleExclamationPoint : tone === 'success' ? CircleCheck : Info;
  return <C aria-hidden className={cn('size-4 shrink-0', toneText[tone], className)} />;
};

export function Banner({
  tone = 'info', title, children, actions, className, icon, role,
}: { tone?: Tone; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string; icon?: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div role={role} className={cn('flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-start', toneClass[tone], className)}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5">{icon ?? <ToneIcon tone={tone} />}</span>
        <div className="min-w-0 text-[13px] leading-relaxed">
          {title ? <p className="font-semibold text-fg">{title}</p> : null}
          {children ? <div className="text-fg/90">{children}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ml-auto">{actions}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton h-4', className)} />;
}

export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4">
          <Skeleton className="size-9 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function Spinner({ label = 'Loading', className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-muted', className)}>
      <LoaderCircle aria-hidden className="size-4 anim-spin" />
      <span className="text-[13px]">{label}…</span>
    </span>
  );
}

export function EmptyState({
  icon, title, children, action, className, compact,
}: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed border-border text-center', compact ? 'px-4 py-8' : 'px-6 py-14', className)}>
      {icon ? <div className="mb-3 flex size-11 items-center justify-center rounded-xl border border-border bg-raised text-muted [&>svg]:size-5">{icon}</div> : null}
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {children ? <div className="mt-1.5 max-w-[46ch] text-[13px] text-muted">{children}</div> : null}
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function CorrelationRef({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      Reference <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg">{id}</code>
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded hover:bg-raised hover:text-fg"
        aria-label={copied ? 'Reference copied' : 'Copy reference'}
        onClick={() => {
          void navigator.clipboard?.writeText(id).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <CircleCheck aria-hidden className="size-3.5 text-success" /> : <Copy aria-hidden className="size-3.5" />}
      </button>
    </span>
  );
}

/** Inline error with message, field errors and correlation id. */
export function ErrorNotice({ error, className, title }: { error: unknown; className?: string; title?: string }) {
  const msg = isApiError(error) ? error.message : error instanceof Error ? error.message : 'Something went wrong.';
  const fields = isApiError(error) ? error.fieldErrors : undefined;
  const ref = isApiError(error) ? error.correlationId : null;
  const offline = isApiError(error) && error.isNetwork;
  return (
    <div role="alert" className={cn('rounded-lg border px-3.5 py-3 text-[13px]', toneClass.danger, className)}>
      <div className="flex items-start gap-2.5">
        {offline ? <WifiOff aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" /> : <CircleExclamationPoint aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />}
        <div className="min-w-0 flex-1">
          {title ? <p className="font-semibold">{title}</p> : null}
          <p>{msg}</p>
          {fields && Object.keys(fields).length ? (
            <ul className="mt-1.5 list-disc pl-4 text-muted">
              {Object.entries(fields).map(([k, v]) => (
                <li key={k}><span className="font-mono text-[11px]">{k}</span>: {v}</li>
              ))}
            </ul>
          ) : null}
          {ref ? <div className="mt-1.5"><CorrelationRef id={ref} /></div> : null}
        </div>
      </div>
    </div>
  );
}

/** Section-level error with retry. */
export function ErrorState({ error, onRetry, title = 'This could not be loaded', className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  const status = isApiError(error) ? error.status : 0;
  const t = status === 404 ? 'Not found' : status === 403 ? 'You don’t have access to this' : title;
  return (
    <div className={cn('flex flex-col items-start gap-3', className)}>
      <ErrorNotice error={error} title={t} className="w-full" />
      {onRetry && status !== 403 && status !== 404 ? (
        <button type="button" onClick={onRetry} className="touch-target inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-raised px-3 text-[13px] font-medium hover:border-border-strong">
          <RefreshCw aria-hidden className="size-3.5" /> Try again
        </button>
      ) : null}
    </div>
  );
}
