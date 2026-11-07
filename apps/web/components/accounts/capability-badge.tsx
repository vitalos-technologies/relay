'use client';
import {
  Ban, CircleCheck, ClockAlert, Hand, Hourglass, Link2Off, LoaderCircle, Pause, ShieldAlert, ShieldEllipsis, Unplug, type LucideIcon,
} from 'lucide-react';
import { CAPABILITY_STATE_LABEL, type CapabilityState } from '@/lib/client/capability-state';
import { Badge, cn, type Tone } from '@/components/ui';

const STATE_STYLE: Record<CapabilityState, { tone: Tone; Icon: LucideIcon }> = {
  connected: { tone: 'success', Icon: CircleCheck },
  missing_permission: { tone: 'warn', Icon: ShieldAlert },
  awaiting_approval: { tone: 'info', Icon: Hourglass },
  unsupported: { tone: 'neutral', Icon: Ban },
  reconnect_required: { tone: 'danger', Icon: Unplug },
  manual_handoff: { tone: 'warn', Icon: Hand },
  limited: { tone: 'warn', Icon: ShieldEllipsis },
  expiring: { tone: 'warn', Icon: ClockAlert },
  paused: { tone: 'neutral', Icon: Pause },
  verifying: { tone: 'info', Icon: LoaderCircle },
  disconnected: { tone: 'neutral', Icon: Link2Off },
};

export function CapabilityBadge({ state }: { state: CapabilityState }) {
  const s = STATE_STYLE[state];
  return (
    <Badge tone={s.tone} className="h-5 px-1.5 text-[11px]" icon={<s.Icon aria-hidden className={cn('size-3.5 shrink-0', state === 'verifying' && 'anim-spin')} />}>
      {CAPABILITY_STATE_LABEL[state]}
    </Badge>
  );
}

