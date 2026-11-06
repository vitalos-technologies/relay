import type { ReactNode } from 'react';
import {
  Ban, CalendarClock, CircleCheck, CircleExclamationPoint, CircleQuestionMark, CircleX, Clock, ClockExclamationPoint,
  FlaskConical, Hourglass, Link2Off, LoaderCircle, OctagonX, Pause, RotateCcwClock, ShieldExclamationPoint, SquarePen,
  TimerOff, TriangleExclamationPoint, Unplug, type LucideIcon,
} from 'lucide-react';
import { CONNECTION_STATUS_LABEL, DELIVERY_STATE_LABEL, type ConnectionStatus, type DeliveryState, type PostAggregateStatus } from '@social-lite/core';
import { cn } from './cn';
import type { Tone } from './feedback';

const tones: Record<Tone | 'accent', string> = {
  neutral: 'bg-neutral-soft text-muted border-border',
  info: 'bg-info-soft text-info border-[color-mix(in_srgb,var(--info)_30%,transparent)]',
  success: 'bg-success-soft text-success border-[color-mix(in_srgb,var(--success)_30%,transparent)]',
  warn: 'bg-warn-soft text-warn border-[color-mix(in_srgb,var(--warn)_30%,transparent)]',
  danger: 'bg-danger-soft text-danger border-[color-mix(in_srgb,var(--danger)_30%,transparent)]',
  accent: 'bg-accent-soft text-accent-text border-[color-mix(in_srgb,var(--accent-text)_30%,transparent)]',
};

export function Badge({ tone = 'neutral', icon, children, className, title }: { tone?: Tone | 'accent'; icon?: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex h-6 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-medium', tones[tone], className)}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

function StateBadge({ Icon, tone, label, spin, className, size }: { Icon: LucideIcon; tone: Tone; label: string; spin?: boolean; className?: string; size?: 'sm' | 'md' }) {
  return (
    <Badge tone={tone} className={cn(size === 'sm' && 'h-5 px-1.5 text-[11px]', className)} icon={<Icon aria-hidden className={cn('size-3.5 shrink-0', spin && 'anim-spin')} />}>
      {label}
    </Badge>
  );
}

const DELIVERY: Record<DeliveryState, { Icon: LucideIcon; tone: Tone; spin?: boolean }> = {
  scheduled: { Icon: Clock, tone: 'info' },
  preparing: { Icon: LoaderCircle, tone: 'info', spin: true },
  publishing: { Icon: LoaderCircle, tone: 'info', spin: true },
  processing: { Icon: Hourglass, tone: 'info' },
  retry_wait: { Icon: RotateCcwClock, tone: 'warn' },
  published: { Icon: CircleCheck, tone: 'success' },
  failed: { Icon: OctagonX, tone: 'danger' },
  blocked: { Icon: Ban, tone: 'warn' },
  paused: { Icon: Pause, tone: 'neutral' },
  cancelled: { Icon: CircleX, tone: 'neutral' },
  expired: { Icon: TimerOff, tone: 'danger' },
  unknown: { Icon: CircleQuestionMark, tone: 'warn' },
};

/** Delivery state with icon + text. Simulated destinations never say "Published". */
export function DeliveryStateBadge({ state, isMock, size, className }: { state: DeliveryState | null; isMock?: boolean; size?: 'sm' | 'md'; className?: string }) {
  if (!state) return <StateBadge Icon={SquarePen} tone="neutral" label="Not scheduled" size={size} className={className} />;
  const d = DELIVERY[state];
  let label = DELIVERY_STATE_LABEL[state];
  if (state === 'published' && isMock) label = 'Simulated · delivered';
  return <StateBadge Icon={state === 'published' && isMock ? FlaskConical : d.Icon} tone={d.tone} spin={d.spin} label={label} size={size} className={className} />;
}

const CONN: Record<ConnectionStatus, { Icon: LucideIcon; tone: Tone; spin?: boolean }> = {
  pending_verification: { Icon: LoaderCircle, tone: 'info', spin: true },
  ready: { Icon: CircleCheck, tone: 'success' },
  missing_permission: { Icon: ShieldExclamationPoint, tone: 'warn' },
  expiring: { Icon: ClockExclamationPoint, tone: 'warn' },
  reconnect_required: { Icon: Unplug, tone: 'danger' },
  paused: { Icon: Pause, tone: 'neutral' },
  disconnected: { Icon: Link2Off, tone: 'neutral' },
};

export function ConnectionStatusBadge({ status, label, size, className }: { status: ConnectionStatus; label?: string; size?: 'sm' | 'md'; className?: string }) {
  const c = CONN[status] ?? CONN.disconnected;
  return <StateBadge Icon={c.Icon} tone={c.tone} spin={c.spin} label={label || CONNECTION_STATUS_LABEL[status] || status} size={size} className={className} />;
}

export const POST_STATUS_LABEL: Record<PostAggregateStatus, string> = {
  draft: 'Draft', pending_approval: 'Awaiting approval', rejected: 'Changes requested', scheduled: 'Scheduled',
  publishing: 'Publishing', published: 'Published', partial: 'Partial success', failed: 'Failed',
  needs_attention: 'Needs attention', cancelled: 'Cancelled', expired: 'Expired',
};
const POST: Record<PostAggregateStatus, { Icon: LucideIcon; tone: Tone; spin?: boolean }> = {
  draft: { Icon: SquarePen, tone: 'neutral' },
  pending_approval: { Icon: Hourglass, tone: 'info' },
  rejected: { Icon: CircleX, tone: 'danger' },
  scheduled: { Icon: CalendarClock, tone: 'info' },
  publishing: { Icon: LoaderCircle, tone: 'info', spin: true },
  published: { Icon: CircleCheck, tone: 'success' },
  partial: { Icon: TriangleExclamationPoint, tone: 'warn' },
  failed: { Icon: OctagonX, tone: 'danger' },
  needs_attention: { Icon: CircleExclamationPoint, tone: 'warn' },
  cancelled: { Icon: CircleX, tone: 'neutral' },
  expired: { Icon: TimerOff, tone: 'danger' },
};

export function PostStatusBadge({ status, simulated, size, className }: { status: PostAggregateStatus; simulated?: boolean; size?: 'sm' | 'md'; className?: string }) {
  const p = POST[status] ?? POST.draft;
  const label = status === 'published' && simulated ? 'Simulated · delivered' : POST_STATUS_LABEL[status] ?? status;
  return <StateBadge Icon={status === 'published' && simulated ? FlaskConical : p.Icon} tone={p.tone} spin={p.spin} label={label} size={size} className={className} />;
}

export function SimulatedBadge({ className }: { className?: string }) {
  return (
    <Badge tone="accent" className={cn('h-5 px-1.5 text-[11px]', className)} icon={<FlaskConical aria-hidden className="size-3" />} title="Simulated destination — nothing is sent to a real network">
      Simulated
    </Badge>
  );
}
