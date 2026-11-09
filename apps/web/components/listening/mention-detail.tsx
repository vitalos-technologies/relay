'use client';
// One mention: text, source, inferred sentiment (+ the words that produced it), matched searches, actions taken.
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { ObservationDto } from '@social-lite/core/contracts/v35-listening';
import { useApi } from '@/lib/client/use-api';
import { Card, ErrorState, Facts, PageHeader, SkeletonRows } from '@/components/ui';
import { KIND_LABEL, SENTIMENT_LABEL, fmtWhen, langTag } from './shared';
import { MentionRow } from './mentions';

type Detail = ObservationDto & { matched_searches: Array<{ id: string; name: string; version: number }>; actions: Array<{ action: string; target_id: string; at: string }> };

export function MentionDetail({ id }: { id: string }) {
  const m = useApi<Detail>(`/api/listening/mentions/${id}`);
  if (m.error && !m.data) return <ErrorState error={m.error} onRetry={m.refetch} />;
  if (!m.data) return <SkeletonRows rows={5} />;
  const d = m.data;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={<Link href="/listening" className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft aria-hidden className="size-3.5" />Listening</Link>} title="Mention" meta={`${KIND_LABEL[d.kind]} · ${d.source.label}`} />
      <Card><MentionRow m={d} onChanged={m.refetch} /></Card>
      <Card className="p-4">
        <Facts items={[
          ['Source', `${d.source.label}${d.source.channel_name ? ` · ${d.source.channel_name}` : ''}${d.is_simulated && !/simulated/i.test(d.source.channel_name ?? '') ? ' (simulated)' : ''}`],
          ['Posted', fmtWhen(d.occurred_at)],
          ['Retrieved', fmtWhen(d.observed_at)],
          ['Language', langTag(d.language)],
          ['Sentiment', d.sentiment.corrected
            ? `${SENTIMENT_LABEL[d.sentiment.effective]} — corrected by ${d.sentiment.corrected.by ?? 'a teammate'} (inferred ${SENTIMENT_LABEL[d.sentiment.label]})`
            : `${SENTIMENT_LABEL[d.sentiment.label]} — inferred by the lexicon baseline, confidence ${Math.round(d.sentiment.confidence * 100)}%${d.sentiment.evidence.length ? `, from: ${d.sentiment.evidence.join(', ')}` : ''}`],
          ['Searches', d.matched_searches.length ? d.matched_searches.map((s) => `${s.name} (v${s.version})`).join(', ') : 'None'],
          ['Repeats', d.duplicate_of ? 'Repeat of an earlier mention (counted once)' : d.duplicates ? `${d.duplicates} identical repeat(s) collapsed into this` : 'None'],
          ['Actions', d.actions.length ? d.actions.map((a) => `${a.action} · ${fmtWhen(a.at)}`).join(', ') : 'None'],
        ]} />
      </Card>
    </div>
  );
}
