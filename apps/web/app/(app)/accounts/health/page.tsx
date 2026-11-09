'use client';
// Account health centre: why each destination can't publish, the exact fix, and the upcoming posts it affects.
import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft, CalendarClock, ChevronDown, HeartPulse, RefreshCw } from 'lucide-react';
import { PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import {
  Badge, Button, Card, EmptyState, ErrorState, LinkButton, MetaChip, PageHeader, PlatformIcon, SimulatedBadge, SkeletonRows, TimeWithZone, ToneIcon, cn, useToast,
} from '@/components/ui';

interface Fix { action: 'reconnect' | 'check' | 'resume' | 'wait' | 'budgets' | 'bot_admin'; label: string; how: string; allowed: boolean; who: string | null }
interface Issue { code: string; severity: 'critical' | 'warning' | 'info'; title: string; detail: string; fix: Fix; at_risk_from: string | null }
interface Item {
  connection: { id: string; brand_id: string; brand_name: string | null; provider: Provider; display_name: string; username: string | null; is_mock: boolean; status: string; status_label: string; checked_at: string | null };
  state: 'critical' | 'warning' | 'ok'; issues: Issue[];
  affected: { count: number; schedules: Array<{ schedule_id: string; post_id: string; title: string | null; excerpt: string; due_at: string; state: string }> | null };
}
interface HealthView { generated_at: string; summary: { total: number; ok: number; warning: number; critical: number; affected_schedules: number }; items: Item[] }

export default function AccountHealthPage() {
  const [brand] = useBrandFilter();
  const { data, error, loading, refetch } = useApi<HealthView>(`/api/accounts/health${brand ? `?brand_id=${brand}` : ''}`, { keepPrevious: true });
  const [showOk, setShowOk] = useState(false);
  const problems = data?.items.filter((i) => i.state !== 'ok') ?? [];
  const ok = data?.items.filter((i) => i.state === 'ok') ?? [];
  return (
    <>
      <PageHeader
        title="Connection health"
        eyebrow={<Link href={brand ? `/accounts?brand=${brand}` : '/accounts'} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"><ArrowLeft aria-hidden className="size-3.5" />Connections</Link>}
        meta={data && (data.summary.critical || data.summary.warning || data.summary.affected_schedules) ? (
          <span className="flex flex-wrap gap-2">
            {data.summary.critical ? <Badge tone="danger">{data.summary.critical} blocked</Badge> : null}
            {data.summary.warning ? <Badge tone="warn">{data.summary.warning} warning{data.summary.warning === 1 ? '' : 's'}</Badge> : null}
            <Badge tone="success">{data.summary.ok} healthy</Badge>
            {data.summary.affected_schedules ? <Badge tone="info" icon={<CalendarClock aria-hidden className="size-3.5" />}>{data.summary.affected_schedules} upcoming affected</Badge> : null}
          </span>
        ) : null}
        actions={<Button variant="secondary" icon={<RefreshCw aria-hidden className="size-4" />} onClick={() => void refetch()} loading={loading && !!data}>Refresh</Button>}
      />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : !data ? <SkeletonRows rows={4} /> : !data.items.length ? (
        <EmptyState icon={<HeartPulse aria-hidden />} title="No connections" />
      ) : (
        <div className="flex flex-col gap-4">
          {!problems.length ? <EmptyState compact icon={<HeartPulse aria-hidden />} title="All connections healthy" /> : null}
          {problems.map((i) => <HealthCard key={i.connection.id} item={i} onChanged={refetch} />)}
          {ok.length ? (
            <section aria-label="Healthy connections">
              <button type="button" className="flex items-center gap-1 text-[13px] text-muted hover:text-fg" aria-expanded={showOk} onClick={() => setShowOk((v) => !v)}>
                <ChevronDown aria-hidden className={cn('size-4 transition-transform', showOk && 'rotate-180')} /> {ok.length} healthy
              </button>
              {showOk ? (
                <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {ok.map((i) => (
                    <li key={i.connection.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                      <PlatformIcon provider={i.connection.provider} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm">{i.connection.display_name}</span>
                      <span className="truncate text-xs text-muted">{i.connection.brand_name}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      )}
    </>
  );
}

function HealthCard({ item, onChanged }: { item: Item; onChanged: () => Promise<unknown> }) {
  const { session } = useSession();
  const tz = session.brands.find((b) => b.id === item.connection.brand_id)?.timezone ?? session.workspace?.timezone ?? 'UTC';
  const [open, setOpen] = useState(item.state === 'critical');
  const c = item.connection;
  return (
    <Card className="p-4" data-testid={`health-${c.id}`}>
      <div className="flex flex-wrap items-center gap-3">
        <PlatformIcon provider={c.provider} size="md" />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2 text-sm font-medium"><span className="truncate">{c.display_name}</span>{c.is_mock ? <SimulatedBadge className="shrink-0" /> : null}</p>
          <p className="truncate text-xs text-muted">{PROVIDER_LABEL[c.provider]}{c.username ? ` · @${c.username.replace(/^@/, '')}` : ''} · {c.brand_name}</p>
        </div>
        <Badge tone={item.state === 'critical' ? 'danger' : 'warn'}>{item.state === 'critical' ? 'Can’t publish' : 'Attention'}</Badge>
      </div>
      <ul className="mt-3 flex flex-col gap-3">
        {item.issues.map((i, n) => (
          <li key={n} className="flex flex-col gap-2 rounded-lg bg-sunken px-3 py-2.5 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <ToneIcon tone={i.severity === 'critical' ? 'danger' : i.severity === 'warning' ? 'warn' : 'info'} className="mt-0.5" />
              <div className="min-w-0 text-[13px]">
                <p className="font-medium">{i.title}</p>
                <p className="text-muted">{i.detail}</p>
                <p className="mt-1 text-xs"><span className="text-subtle">Fix:</span> {i.fix.how}{!i.fix.allowed && i.fix.who ? <span className="text-subtle"> ({i.fix.who})</span> : null}</p>
              </div>
            </div>
            <FixButton connection={c} fix={i.fix} onChanged={onChanged} />
          </li>
        ))}
      </ul>
      {item.affected.count ? (
        <div className="mt-3">
          <button type="button" className="flex items-center gap-1 text-[13px] font-medium" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
            {item.affected.count} upcoming post{item.affected.count === 1 ? '' : 's'} affected
          </button>
          {open ? (
            item.affected.schedules ? (
              <ul className="mt-2 flex flex-col divide-y divide-border rounded-lg border border-border">
                {item.affected.schedules.map((s) => (
                  <li key={s.schedule_id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
                    <Link href={`/posts/${s.post_id}`} className="min-w-0 flex-1 truncate underline-offset-2 hover:underline">{s.title ?? s.excerpt ?? 'Untitled'}</Link>
                    <MetaChip>{s.state.replace(/_/g, ' ')}</MetaChip>
                    <TimeWithZone instant={s.due_at} tz={tz} className="text-xs text-muted" />
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 text-xs text-muted">Titles hidden: you can’t read this brand’s content.</p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function FixButton({ connection, fix, onChanged }: { connection: Item['connection']; fix: Fix; onChanged: () => Promise<unknown> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!fix.allowed || fix.action === 'wait') return null;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); await onChanged(); } catch (e) { toast.error(e, 'Couldn’t apply the fix'); } finally { setBusy(false); }
  };
  if (fix.action === 'budgets') return <LinkButton size="sm" href="/settings/operations/usage">{fix.label}</LinkButton>;
  if (fix.action === 'check' || fix.action === 'bot_admin') {
    return <Button size="sm" variant="secondary" loading={busy} onClick={() => run(async () => { await api.post(`/api/connections/${connection.id}/check`, {}); toast.success('Checked'); })}>{fix.action === 'check' ? fix.label : 'Check again'}</Button>;
  }
  if (fix.action === 'resume') {
    return <Button size="sm" variant="secondary" loading={busy} onClick={() => run(async () => { await api.post(`/api/connections/${connection.id}/pause`, { paused: false }); toast.success('Resumed'); })}>{fix.label}</Button>;
  }
  // reconnect: Telegram needs the bot token dialog on Accounts; OAuth goes to the provider; simulated reconnects in place.
  if (connection.provider === 'telegram' && !connection.is_mock) return <LinkButton size="sm" href={`/accounts?brand=${connection.brand_id}`}>Reconnect</LinkButton>;
  return (
    <Button size="sm" variant="secondary" loading={busy} onClick={() => run(async () => {
      const r = await api.post<{ authorization_url?: string }>(`/api/connections/${connection.id}/reconnect`, {});
      if (r?.authorization_url) { window.location.assign(r.authorization_url); return; }
      toast.success('Reconnected');
    })}>{connection.status === 'disconnected' ? 'Connect again' : 'Reconnect'}</Button>
  );
}
