'use client';
// Share of voice / competitor comparison within the observed dataset: same brand, comparable sources only, same window.
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { SavedSearchDto } from '@social-lite/core/contracts/v35-listening';
import { LISTENING_DEFINITIONS } from '@social-lite/core/contracts/v35-listening';
import { useApi } from '@/lib/client/use-api';
import { useQueryState } from '@/lib/client/hooks';
import { Badge, BarList, Card, CardHeader, Checkbox, ErrorState, PageHeader, SkeletonRows } from '@/components/ui';
import { CoverageNote, Definition, ROLE_LABEL, RangeSelect, SimulatedBanner, pct } from './shared';
import type { ShareOfVoiceResponse } from './types';

export function ListeningCompare() {
  const [params, setParams] = useQueryState();
  const days = Number(params.get('days') ?? 30) || 30;
  const ids = (params.get('search_ids') ?? '').split(',').filter(Boolean);
  const searches = useApi<{ items: SavedSearchDto[] }>('/api/listening/searches');
  const brand = searches.data?.items.find((s) => s.id === ids[0])?.brand_id ?? null;
  const choices = (searches.data?.items ?? []).filter((s) => !brand || s.brand_id === brand);
  const sov = useApi<ShareOfVoiceResponse>(ids.length >= 2 ? `/api/listening/share-of-voice?search_ids=${ids.join(',')}&days=${days}` : null, { keepPrevious: true });
  const toggle = (id: string) => setParams({ search_ids: (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]).join(',') || null });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={<Link href="/listening" className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft aria-hidden className="size-3.5" />Listening</Link>}
        title="Compare" actions={<RangeSelect value={days} onChange={(d) => setParams({ days: d === 30 ? null : String(d) })} />} />
      <SimulatedBanner coverage={sov.data?.coverage} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Card className="p-4">
          <h2 className="mb-3 text-[14px] font-semibold">Searches</h2>
          {!searches.data ? <SkeletonRows rows={4} /> : (
            <div className="flex flex-col gap-2.5">
              {choices.map((s) => <Checkbox key={s.id} label={s.name} description={ROLE_LABEL[s.role]} checked={ids.includes(s.id)} onChange={() => toggle(s.id)} />)}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">One brand at a time, so sources are comparable.</p>
        </Card>
        <Card>
          <CardHeader title={<span className="inline-flex items-center gap-1">Share of voice<Definition>{LISTENING_DEFINITIONS.share_of_voice}</Definition></span>} />
          <div className="px-4 pb-4">
            {ids.length < 2 ? <p className="text-[13px] text-muted">Pick two or more searches.</p> : sov.error && !sov.data ? <ErrorState error={sov.error} onRetry={sov.refetch} /> : !sov.data ? <SkeletonRows rows={4} /> : (
              <>
                <BarList label="Share of voice" rows={sov.data.rows.map((r) => ({ key: r.search.id, label: <span className="flex items-center gap-2">{r.search.name}<Badge className="h-5 px-1.5 text-[11px]">{ROLE_LABEL[r.search.role as keyof typeof ROLE_LABEL]}</Badge></span>, value: r.count }))} />
                <table className="mt-4 w-full text-[13px]">
                  <thead><tr className="text-left text-xs text-muted"><th className="py-1 font-medium">Search</th><th className="py-1 text-right font-medium">Mentions</th><th className="py-1 text-right font-medium">Share</th><th className="py-1 text-right font-medium">Negative</th></tr></thead>
                  <tbody>{sov.data.rows.map((r) => (
                    <tr key={r.search.id} className="border-t border-border"><td className="py-1.5"><Link className="hover:underline" href={`/listening/searches/${r.search.id}`}>{r.search.name}</Link> <span className="text-xs text-subtle">v{r.search.version}</span></td>
                      <td className="py-1.5 text-right tabular">{r.count}</td><td className="py-1.5 text-right tabular">{pct(r.share)}</td><td className="py-1.5 text-right tabular">{r.negative}</td></tr>
                  ))}</tbody>
                  <tfoot><tr className="border-t border-border text-xs text-muted"><td className="py-1.5">Denominator</td><td className="py-1.5 text-right tabular">{sov.data.denominator}</td><td /><td /></tr></tfoot>
                </table>
                <p className="mt-3 text-xs text-muted">{sov.data.note}{sov.data.comparable_sources.length ? ` Sources: ${sov.data.comparable_sources.join(', ')}.` : ''}</p>
                <CoverageNote coverage={sov.data.coverage} className="mt-2" />
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
