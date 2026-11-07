'use client';
// Trusted confirmation of ONE publication an MCP client prepared. Shows exactly what would be published (text,
// destinations, time and zone). Confirming records a server-side approval for this intent only (step-up/MFA per policy);
// the assistant then commits it. Any change to the post, destinations or time voids the request.
import { useState } from 'react';
import Link from 'next/link';
import { CalendarClock, Send } from 'lucide-react';
import type { McpIntentView } from '@social-lite/core/contracts/mcp';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtDateTime } from '@/lib/client/format';
import { Badge, Banner, Button, Card, CardHeader, ErrorNotice, ErrorState, PlatformIcon, SimulatedBadge, Skeleton, buttonClass, useToast } from '@/components/ui';

export function McpIntentConfirm({ intentId }: { intentId: string }) {
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<McpIntentView>(`/api/mcp/intents/${intentId}`);
  const [busy, setBusy] = useState<'confirm' | 'decline' | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Skeleton className="h-72 w-full max-w-2xl rounded-xl" />;
  const act = async (what: 'confirm' | 'decline') => {
    setBusy(what); setErr(null);
    try {
      await api.post(`/api/mcp/intents/${data.id}/${what}`, {});
      toast.success(what === 'confirm' ? 'Confirmed' : 'Declined');
      await refetch();
    } catch (e) { setErr(e); await refetch(); } finally { setBusy(null); }
  };
  const when = data.mode === 'immediate' ? 'As soon as committed' : data.due_at ? fmtDateTime(data.due_at, data.timezone) : '—';
  return (
    <Card className="max-w-2xl" data-testid="mcp-intent">
      <CardHeader title={<span className="flex items-center gap-2">{data.mode === 'immediate' ? <Send aria-hidden className="size-4 text-accent" /> : <CalendarClock aria-hidden className="size-4 text-accent" />}
        {data.mode === 'immediate' ? 'Publish now' : 'Schedule'} · {data.brand.name}</span>}
        actions={<Badge tone={data.status === 'confirmed' || data.status === 'committed' ? 'success' : data.can_confirm ? 'warn' : 'neutral'}>{data.status}</Badge>} />
      <div className="flex flex-col gap-4 px-4 pb-4">
        <p className="text-xs text-muted">Requested by <strong className="text-fg">{data.client.name}</strong> · <code className="font-mono">{data.client.client_id}</code></p>
        <div className="rounded-lg border border-border bg-raised px-3 py-2">
          {data.post.title ? <p className="mb-1 text-[13px] font-semibold">{data.post.title}</p> : null}
          <p className="text-sm whitespace-pre-wrap break-words">{data.post.text || <span className="text-muted">No text</span>}</p>
          {data.post.link ? <p className="mt-1 truncate font-mono text-[12px] text-muted">{data.post.link}</p> : null}
          {data.post.media_count ? <p className="mt-1 text-xs text-muted">{data.post.media_count} media</p> : null}
        </div>
        <ul className="flex flex-col gap-1.5" aria-label="Destinations">
          {data.destinations.map((d) => (
            <li key={d.connection_id} className="flex items-center gap-2 text-[13px]"><PlatformIcon provider={d.provider as never} size="sm" decorative />{d.display_name}{d.is_mock ? <SimulatedBadge /> : null}</li>
          ))}
        </ul>
        <p className="text-[13px]"><span className="text-muted">When</span> <strong>{when}</strong> {data.mode === 'scheduled' ? <span className="text-muted">({data.timezone})</span> : null}</p>
        {data.brand.publishing_paused ? <Banner tone="warn">Publishing is paused for this brand.</Banner> : null}
        {data.cannot_confirm_reason && data.status === 'prepared' ? <Banner tone="warn">{data.cannot_confirm_reason}</Banner> : null}
        {data.status === 'confirmed' ? <Banner tone="success">Confirmed. The assistant can now commit it.</Banner> : null}
        {data.status === 'committed' ? <Banner tone="success">Queued. <Link className="underline" href={`/posts/${data.post.id}`}>Open post</Link></Banner> : null}
        {err ? <ErrorNotice error={err} /> : null}
        {data.status === 'prepared' ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => void act('decline')} loading={busy === 'decline'} disabled={!!busy}>Decline</Button>
            <Button variant="primary" onClick={() => void act('confirm')} loading={busy === 'confirm'} disabled={!!busy} disabledReason={data.can_confirm ? null : data.cannot_confirm_reason} data-testid="mcp-confirm">
              Confirm
            </Button>
          </div>
        ) : <div className="flex justify-end"><Link href={`/posts/${data.post.id}`} className={buttonClass('secondary', 'sm')}>Open post</Link></div>}
      </div>
    </Card>
  );
}
