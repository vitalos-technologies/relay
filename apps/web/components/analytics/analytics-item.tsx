'use client';
// One published delivery with its native metrics. Provider-native names are kept (label + exact name in the tooltip);
// missing metrics show "—"/"Unavailable", never 0; simulated values are labelled; nothing is summed across networks.
import Link from 'next/link';
import { useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { fmtNumber, fmtRelative } from '@/lib/client/format';
import { Badge, IconButton, PlatformIcon, SimulatedBadge, TimeWithZone, Tooltip, useToast } from '@/components/ui';

export type FetchStatus = 'pending' | 'ok' | 'unsupported' | 'unavailable' | 'permission_missing' | 'budget_exhausted' | 'reconnect' | 'error';
export interface AnalyticsItem {
  delivery_id: string; post_id: string; brand_id: string; brand_name: string; title: string | null; excerpt: string | null;
  provider: Provider; display_name: string; is_mock: boolean; published_at: string; provider_url: string | null;
  supported: boolean; status: FetchStatus; status_message: string | null; source: 'provider' | 'simulated' | null;
  metrics: Array<{ name: string; label: string; dimension: string | null; value: number; period: string; window_end: string | null; observed_at: string; source: string }>;
  expected_metrics: Array<{ name: string; label: string }>;
  last_refreshed_at: string | null; last_attempt_at: string | null; next_refresh_allowed_at: string | null; billable: boolean;
}

const STATUS: Record<FetchStatus, { label: string; tone: 'neutral' | 'warn' | 'danger' | 'success' | 'info' } | null> = {
  ok: null,
  pending: { label: 'Not fetched yet', tone: 'neutral' },
  unsupported: { label: 'Unavailable', tone: 'neutral' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
  permission_missing: { label: 'Needs permission', tone: 'warn' },
  budget_exhausted: { label: 'Budget used up', tone: 'warn' },
  reconnect: { label: 'Reconnect', tone: 'warn' },
  error: { label: 'Couldn’t refresh', tone: 'danger' },
};

export function AnalyticsRow({ item, tz, onUpdated }: { item: AnalyticsItem; tz: string; onUpdated: (i: AnalyticsItem) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const st = STATUS[item.status];
  const refresh = async () => {
    setBusy(true);
    try {
      onUpdated(await api.post<AnalyticsItem>(`/api/analytics/${item.delivery_id}/refresh`, {}));
    } catch (e) {
      toast.error(e, 'Not refreshed');
    } finally {
      setBusy(false);
    }
  };
  // Group breakdown metrics (e.g. reactions by type) under one label.
  const groups = new Map<string, { label: string; name: string; parts: AnalyticsItem['metrics'] }>();
  for (const m of item.metrics) {
    const g = groups.get(m.name) ?? { label: m.label, name: m.name, parts: [] };
    g.parts.push(m);
    groups.set(m.name, g);
  }
  const shown = item.expected_metrics.map((e) => groups.get(e.name) ?? { label: e.label, name: e.name, parts: [] });
  for (const g of groups.values()) if (!shown.some((s) => s.name === g.name)) shown.push(g);
  const refreshReason = !item.supported ? 'This network has no post statistics.'
    : item.next_refresh_allowed_at ? `Refreshed recently. Next after ${new Date(item.next_refresh_allowed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })}.` : null;

  return (
    <li className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-start gap-3">
        <PlatformIcon provider={item.provider} size="sm" />
        <div className="min-w-0 flex-1">
          <Link href={`/posts/${item.post_id}`} className="block truncate text-sm font-medium hover:underline">{item.title || item.excerpt || 'Untitled post'}</Link>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <span className="truncate">{item.display_name}</span><span aria-hidden>·</span>
            <TimeWithZone instant={item.published_at} tz={tz} />
            {item.provider_url ? <a href={item.provider_url} target="_blank" rel="noreferrer" className="inline-flex items-center" aria-label={`Open on ${PROVIDER_LABEL[item.provider]}`}><ExternalLink aria-hidden className="size-3.5" /></a> : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {item.is_mock ? <SimulatedBadge /> : null}
          {st ? <Badge tone={st.tone} title={item.status_message ?? undefined}>{st.label}</Badge> : null}
          <IconButton
            label={refreshReason ?? (item.billable ? 'Refresh (uses 1 X read)' : 'Refresh')}
            icon={<RefreshCw aria-hidden className={`size-4 ${busy ? 'animate-spin' : ''}`} />}
            onClick={() => { if (!refreshReason && !busy) void refresh(); }}
            aria-disabled={busy || !!refreshReason}
            size="sm"
          />
        </div>
      </div>
      {item.supported ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4 lg:grid-cols-7">
          {shown.map((g) => (
            <div key={g.name} className="min-w-0">
              <dt className="truncate text-xs text-muted">
                <Tooltip content={<span className="font-mono">{g.name}{g.parts[0] ? ` · ${g.parts[0].period}` : ''}</span>}><span tabIndex={0}>{g.label}</span></Tooltip>
              </dt>
              <dd className="text-[15px] font-medium tabular">
                {!g.parts.length ? <span className="text-subtle" aria-label="Unavailable">—</span>
                  : g.parts.length === 1 && g.parts[0]!.dimension === null ? fmtNumber(g.parts[0]!.value)
                    : <span className="flex flex-wrap gap-x-2 text-[13px]">{g.parts.map((p) => <span key={p.dimension ?? ''}>{p.dimension} {fmtNumber(p.value)}</span>)}</span>}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-[13px] text-muted">Unavailable · {PROVIDER_LABEL[item.provider]} doesn’t share post statistics.</p>
      )}
      {item.supported && (item.last_refreshed_at || item.last_attempt_at) ? (
        <p className="text-xs text-subtle">
          {item.last_refreshed_at ? `Updated ${fmtRelative(item.last_refreshed_at)}` : 'Not updated yet'}
          {item.metrics[0] ? ` · ${item.metrics[0].period}` : ''}
          {item.source === 'simulated' ? ' · simulated values' : ''}
          {item.status !== 'ok' && item.status_message ? ` · ${item.status_message}` : ''}
        </p>
      ) : null}
    </li>
  );
}
