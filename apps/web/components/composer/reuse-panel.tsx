'use client';
// V3.1 §13 in the composer: provenance (derived from…), similar recent posts per destination (warning only),
// and — with the content queue flag — explicit evergreen marking + "Add to queue" for eligible content.
import Link from 'next/link';
import { useState } from 'react';
import { GitFork, ListPlus, TriangleAlert } from 'lucide-react';
import type { ProvenanceDto, ReuseEligibility, SimilarPostWarning } from '@social-lite/core/contracts/v31-gov';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useFlag } from '@/lib/client/flags';
import { fmtRelative } from '@/lib/client/format';
import type { Connection } from '@/lib/client/types';
import { Badge, Button, Card, CardHeader, ErrorNotice, Switch, useToast } from '@/components/ui';

export function ProvenanceLink({ postId }: { postId: string }) {
  const { data } = useApi<{ derived_from: ProvenanceDto | null; derivatives: ProvenanceDto[] }>(`/api/posts/${postId}/provenance`);
  const from = data?.derived_from;
  if (!from?.original_post_id) return null;
  return (
    <Link href={`/posts/${from.original_post_id}`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg hover:underline" data-testid="provenance">
      <GitFork aria-hidden className="size-3.5" />{from.kind === 'duplicate' ? 'Duplicated' : 'Reused'} from an earlier post
    </Link>
  );
}

/** Similar recent posts on the same destinations (advisory; the server decides what counts as similar). */
export function useSimilar(postId: string, version: number, enabled: boolean) {
  const { data } = useApi<SimilarPostWarning[] | { items: SimilarPostWarning[] }>(enabled ? `/api/posts/${postId}/similar?days=30&v=${version}` : null, { keepPrevious: true });
  return Array.isArray(data) ? data : data?.items ?? [];
}

export function SimilarList({ items, connections }: { items: SimilarPostWarning[]; connections: Connection[] }) {
  if (!items.length) return null;
  const name = (id: string) => connections.find((c) => c.id === id)?.display_name ?? 'a destination';
  return (
    <ul className="flex flex-col gap-1.5" data-testid="similar-posts">
      {items.slice(0, 3).map((s) => (
        <li key={`${s.connection_id}-${s.other_post_id}`} className="flex items-start gap-2 text-[13px]">
          <TriangleAlert aria-label="Advisory" className="mt-0.5 size-4 shrink-0 text-warn" />
          <span className="min-w-0">
            Similar to <Link href={`/posts/${s.other_post_id}`} className="underline">{s.other_title?.trim() || 'a recent post'}</Link> on {name(s.connection_id)} · {fmtRelative(s.other_at)}
            {s.same_media ? ' · same media' : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ReuseCard({ postId, brandId, canEdit }: { postId: string; brandId: string; canEdit: boolean }) {
  const on = useFlag('v31.content_queue');
  const toast = useToast();
  const { data, setData, error } = useApi<ReuseEligibility>(on ? `/api/posts/${postId}/evergreen` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (!on || (!data && !error)) return null;
  if (error && !data) return null;
  const e = data!;
  const reasons = e.reasons.filter((r) => r.code !== 'not_marked_evergreen');
  const run = async (k: string, f: () => Promise<void>) => { setBusy(k); setErr(null); try { await f(); } catch (x) { setErr(x); } finally { setBusy(null); } };
  return (
    <Card aria-labelledby="h-reuse">
      <CardHeader id="h-reuse" className="min-h-12 pt-3" title="Reuse" actions={e.eligible ? <Badge tone="success">Eligible</Badge> : e.evergreen ? <Badge tone="warn">Not eligible</Badge> : null} />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <Switch label="Evergreen" checked={e.evergreen} disabled={!canEdit || busy === 'ever'}
          onCheckedChange={(v) => void run('ever', async () => setData(await api.put<ReuseEligibility>(`/api/posts/${postId}/evergreen`, { evergreen: v })))} />
        {e.evergreen && reasons.length ? (
          <ul className="flex flex-col gap-1">
            {reasons.map((r) => <li key={r.code} className="flex items-start gap-1.5 text-xs text-warn"><TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{r.message}</li>)}
          </ul>
        ) : null}
        {e.evergreen ? (
          <Button size="sm" variant="secondary" className="self-start" icon={<ListPlus aria-hidden className="size-4" />} loading={busy === 'q'} disabledReason={!e.eligible ? 'Not eligible for the queue.' : null}
            onClick={() => void run('q', async () => { await api.post(`/api/brands/${brandId}/content-queue`, { post_id: postId }); toast.success('Added to the content queue'); })}>
            Add to content queue
          </Button>
        ) : null}
        {err ? <ErrorNotice error={err} /> : null}
      </div>
    </Card>
  );
}
