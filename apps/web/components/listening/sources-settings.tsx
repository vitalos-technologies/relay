'use client';
// Settings → Listening → Sources: the coverage registry. Connected sources (inbox channels with public comments,
// mentions or reviews) with per-channel monitoring start and an exclude switch; broader sources with what they need
// before activation (none collects in this build); what Relay never does.
import Link from 'next/link';
import { CircleAlert, CircleCheck, Clock } from 'lucide-react';
import type { ListeningSourceState, SourceStatus } from '@social-lite/core/contracts/v35-listening';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Card, CardHeader, ErrorState, SimulatedBadge, SkeletonRows, Switch, useToast } from '@/components/ui';
import { fmtDay } from './shared';

const STATUS: Record<SourceStatus, { label: string; tone: 'success' | 'warn' | 'neutral' | 'info' }> = {
  active: { label: 'Collecting', tone: 'success' }, needs_attention: { label: 'Incomplete', tone: 'warn' }, paused: { label: 'Excluded', tone: 'neutral' },
  not_connected: { label: 'Not connected', tone: 'neutral' }, awaiting_activation: { label: 'Awaiting activation', tone: 'info' },
};

export function ListeningSourcesSettings() {
  const toast = useToast();
  const { canOn } = useSession();
  const s = useApi<{ items: ListeningSourceState[]; not_offered: string[] }>('/api/listening/sources');
  if (s.error) return <ErrorState error={s.error} onRetry={s.refetch} />;
  if (!s.data) return <SkeletonRows rows={6} />;
  const connected = s.data.items.filter((x) => x.layer === 'connected');
  const broad = s.data.items.filter((x) => x.layer === 'broad');
  const toggle = async (channelId: string, excluded: boolean) => {
    try {
      const r = await api.put<{ removed: number }>(`/api/listening/channels/${channelId}`, { excluded });
      toast.success(excluded ? `Excluded · ${r.removed} mentions removed from listening` : 'Included · stored items are being added back');
      await s.refetch();
    } catch (e) { toast.error(e); }
  };
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <Card aria-labelledby="h-conn">
        <CardHeader id="h-conn" title="Connected accounts" />
        <p className="px-4 pb-3 text-[13px] text-muted">Public comments, mentions and reviews from inbox channels. Private messages are never included.</p>
        <ul className="divide-y divide-border border-t border-border">
          {connected.map((src) => (
            <li key={src.key} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-[14px] font-medium">{src.label}{!src.implemented ? <span className="ml-2 text-xs font-normal text-subtle">inbox adapter not built yet</span> : null}</p>
                <Badge tone={STATUS[src.status].tone}>{STATUS[src.status].label}</Badge>
                {src.status === 'not_connected' && src.implemented ? <Link href="/settings/inbox/channels" className="text-xs font-medium underline-offset-2 hover:underline">Connect</Link> : null}
              </div>
              <p className="mt-0.5 text-xs text-muted">{src.covers}</p>
              {src.channels.length ? (
                <ul className="mt-2 flex flex-col gap-2">
                  {src.channels.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-md bg-sunken px-3 py-2 text-[13px]">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 font-medium">{c.display_name}{c.is_simulated ? <SimulatedBadge /> : null}</p>
                        <p className="text-xs text-muted">Since {fmtDay(c.monitoring_since)} · {c.observations} stored{c.last_observed_at ? ` · last ${fmtDay(c.last_observed_at)}` : ''}{c.channel_status !== 'active' ? ` · inbox: ${c.channel_status.replace('_', ' ')}` : ''}</p>
                      </div>
                      <Switch label="Monitor" checked={!c.excluded} disabled={!canOn(c.brand_id, 'listening.manage')} onCheckedChange={(on) => toggle(c.id, !on)} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card aria-labelledby="h-broad">
        <CardHeader id="h-broad" title="Broader listening" />
        <p className="px-4 pb-3 text-[13px] text-muted">Wider public sources need an approved API or a licensed provider. None is active, so results only cover connected accounts.</p>
        <ul className="divide-y divide-border border-t border-border">
          {broad.map((b) => (
            <li key={b.key} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-[14px] font-medium">{b.label}</p>
                <Badge tone={STATUS[b.status].tone} icon={b.status === 'active' ? <CircleCheck aria-hidden className="size-3.5" /> : <Clock aria-hidden className="size-3.5" />}>{STATUS[b.status].label}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted">{b.covers} · history: {b.history}</p>
              <p className="mt-1 text-xs"><span className="text-subtle">Needs:</span> {b.requires.join(' · ')}</p>
              {b.limitations.length ? <p className="text-xs"><span className="text-subtle">Limits:</span> {b.limitations.join(' · ')}</p> : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4">
        <h2 className="mb-2 flex items-center gap-2 text-[14px] font-semibold"><CircleAlert aria-hidden className="size-4 text-muted" />Never offered</h2>
        <ul className="list-disc pl-5 text-[13px] text-muted">{s.data.not_offered.map((n) => <li key={n}>{n}</li>)}</ul>
      </Card>
    </div>
  );
}
