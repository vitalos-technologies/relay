'use client';
// Deterministic classification of the latest customer message (category, sentiment, urgency) — signals only. Shown in
// the inbox context panel so agents see why automation routed or escalated a conversation.
import { ShieldAlert, Tag } from 'lucide-react';
import type { ClassificationDto } from '@social-lite/core/contracts/v35-ai';
import { useApi } from '@/lib/client/use-api';
import { Badge } from '@/components/ui';

const CATEGORY: Record<string, string> = {
  question: 'Question', order_status: 'Order status', pricing: 'Pricing', refund: 'Refund', complaint: 'Complaint', praise: 'Praise', feedback: 'Feedback',
  support: 'Support', sales: 'Sales', spam: 'Spam', sensitive: 'Sensitive', other: 'Other',
};

export function ClassificationChip({ conversationId }: { conversationId: string }) {
  const { data } = useApi<{ classification: ClassificationDto | null }>(`/api/assistant/classification?conversation_id=${conversationId}`, { poll: 30_000 });
  const c = data?.classification;
  if (!c) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted" title="Automatic classification (rules, not AI). An estimate.">
      <Tag aria-hidden className="size-3.5" />
      <span>{CATEGORY[c.category] ?? c.category}{c.uncertain ? '?' : ''} · {c.sentiment}{c.urgency === 'high' ? ' · urgent' : ''}</span>
      {c.injection_suspected ? <Badge tone="warn" icon={<ShieldAlert aria-hidden className="size-3" />} className="h-5 px-1.5 text-[11px]">Contains instructions</Badge> : null}
    </p>
  );
}
