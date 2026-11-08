'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, MessageSquare, X } from 'lucide-react';
import { PROVIDER_LABEL, type Provider, type ResolvedVariant } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import type { Asset, Connection } from '@/lib/client/types';
import {
  Badge, Banner, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, ErrorNotice, ErrorState, Field, PageHeader, PlatformIcon, Skeleton,
  Textarea, TimeWithZone, ToneIcon, cn, useToast,
} from '@/components/ui';
import { VariantPreview } from '@/components/composer/preview';
import { StageProgressList } from '@/components/collab/stage-progress';
import { INELIGIBLE, type CommentDto, type People, type StageProgress, type ThreadDto } from '@/components/collab/types';
import { CommentBody } from '@/components/collab/comment-text';
import { newClientKey } from '@/lib/client/collab';

interface Review {
  id: string; decision: 'pending' | 'approved' | 'rejected' | 'invalidated'; fingerprint: string; reason: string | null; requested_at: string;
  brand: { id: string; name: string } | null;
  schedule: { publish_at: string | null; is_immediate: boolean; input_timezone: string } | null;
  variants: Array<ResolvedVariant & { provider: Provider; connection: { id: string; provider: Provider; display_name: string; username: string | null } }>;
  assets: Array<Partial<Asset> & { id: string }>;
  comments: CommentDto[];
  threads?: ThreadDto[]; people?: People;
  review: { stages: StageProgress[]; current_stage: number; stage_count: number; me: { eligible: boolean; reason: string | null }; due_at: string | null };
  can: { approve: boolean; comment: boolean };
}

/** One shared review: exactly what will be sent, media previews, shared comments; approve only by explicit click. */
export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<Review>(`/api/review/${id}`, { poll: 30_000 });
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  if (error && !data) return <><Back /><ErrorState error={error} onRetry={refetch} title="This review isn’t available" /></>;
  if (loading || !data) return <div role="status" aria-label="Loading review"><Skeleton className="h-8 w-1/2" /><Skeleton className="mt-6 h-96 w-full rounded-xl" /></div>;
  const tz = data.schedule?.input_timezone ?? 'UTC';
  const assets = new Map<string, Asset>(data.assets.map((a) => [a.id, a as Asset]));
  const pending = data.decision === 'pending';
  return (
    <>
      <Back />
      <PageHeader
        eyebrow={data.brand?.name}
        title="Review"
        meta={<span>{data.schedule?.is_immediate ? 'Publishes on approval' : data.schedule?.publish_at ? <>Goes out <TimeWithZone instant={data.schedule.publish_at} tz={tz} showBrowser /></> : null}</span>}
      />
      {data.decision === 'approved' ? <Banner tone="success" className="mb-6" icon={<ToneIcon tone="success" />} title="Approved" /> : null}
      {data.decision === 'rejected' ? <Banner tone="danger" className="mb-6" icon={<ToneIcon tone="danger" />} title="Changes requested">{data.reason ? `“${data.reason}”` : null}</Banner> : null}
      {data.decision === 'invalidated' ? <Banner tone="neutral" className="mb-6" title="Replaced by a newer version" /> : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section aria-labelledby="h-out" className="flex min-w-0 flex-col gap-4">
          <h2 id="h-out" className="text-[15px] font-semibold">What will be sent</h2>
          {data.variants.map((v) => (
            <Card key={v.connectionId} as="article" aria-label={`${PROVIDER_LABEL[v.provider]} ${v.connection.display_name}`}>
              <div className="flex items-center gap-3 px-4 pt-4">
                <PlatformIcon provider={v.provider} size="md" />
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{v.connection.display_name}<span className="ml-2 text-xs font-normal text-muted">{PROVIDER_LABEL[v.provider]}</span></p>
              </div>
              <div className="p-4"><VariantPreview variant={v} connection={v.connection as unknown as Connection} assets={assets} /></div>
            </Card>
          ))}
        </section>
        <aside className="flex flex-col gap-6">
          <Card aria-labelledby="h-stages">
            <CardHeader id="h-stages" title="Progress" />
            <div className="flex flex-col gap-2 px-4 pb-4">
              <StageProgressList stages={data.review.stages} current={data.review.current_stage} compact />
              {data.review.due_at ? <p className="text-xs text-muted">Review by <TimeWithZone instant={data.review.due_at} tz={tz} /></p> : null}
              {pending && !data.can.approve && data.review.me.reason ? <p className="text-xs text-muted">{INELIGIBLE[data.review.me.reason] ?? 'Waiting for others'}</p> : null}
            </div>
          </Card>
          <ReviewComments id={data.id} threads={data.threads ?? []} people={data.people ?? {}} canComment={data.can.comment} onDone={refetch} />
        </aside>
      </div>

      {pending && (data.can.approve || data.can.comment) ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
          <div className="mx-auto flex max-w-[960px] flex-wrap items-center justify-end gap-2 px-4 py-2">
            {data.can.approve ? <Button variant="secondary" icon={<X aria-hidden className="size-4" />} onClick={() => setRejectOpen(true)}>Request changes</Button> : null}
            {data.can.approve ? <Button variant="primary" icon={<Check aria-hidden className="size-4" />} onClick={() => setApproveOpen(true)}>Approve</Button> : null}
          </div>
        </div>
      ) : null}
      <ConfirmDialog open={approveOpen} onOpenChange={setApproveOpen} title="Approve?" description="Only this exact version. Any change needs a new review." confirmLabel="Approve"
        onConfirm={async () => {
          const r = await api.post<{ decision: string }>(`/api/review/${data.id}/approve`, { expected_fingerprint: data.fingerprint });
          toast.success(r.decision === 'approved' ? 'Approved' : 'Approval recorded');
          await refetch();
        }} />
      <RejectDialog open={rejectOpen} onOpenChange={setRejectOpen} id={data.id} onDone={async () => { toast.success('Changes requested'); await refetch(); }} />
    </>
  );
}

function Back() {
  return <Link href="/review" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"><ArrowLeft aria-hidden className="size-4" /> Reviews</Link>;
}

function ReviewComments({ id, threads, people, canComment, onDone }: { id: string; threads: ThreadDto[]; people: People; canComment: boolean; onDone: () => Promise<unknown> }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const focus = useSearchParams().get('thread');
  const key = useRef(newClientKey('g'));
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => { const el = document.getElementById(`thread-${focus}`); el?.scrollIntoView({ block: 'center' }); el?.focus({ preventScroll: true }); }, 200);
    return () => clearTimeout(t);
  }, [focus, threads.length]);
  return (
    <Card aria-labelledby="h-c">
      <CardHeader id="h-c" title="Comments" />
      <div className="flex flex-col gap-3 px-4 pb-4">
        {threads.length ? (
          <ul className="flex flex-col gap-3" aria-label="Comments">
            {threads.map((t) => <li key={t.id}><GuestThread t={t} people={people} highlight={t.id === focus} onDone={onDone} /></li>)}
          </ul>
        ) : <EmptyState compact icon={<MessageSquare aria-hidden />} title="No comments" />}
        {canComment ? (
          <>
            <label htmlFor="rc" className="sr-only">New comment</label>
            <Textarea id="rc" rows={3} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} placeholder="Comment for the team" />
            <Button size="sm" className="self-end" loading={busy} disabledReason={!body.trim() ? 'Write something first.' : null}
              onClick={async () => { setBusy(true); setErr(null); try { await api.post(`/api/review/${id}/comments`, { body: body.trim(), client_key: key.current }); setBody(''); key.current = newClientKey('g'); await onDone(); } catch (e) { setErr(e); } finally { setBusy(false); } }}>
              Send
            </Button>
            {err ? <ErrorNotice error={err} /> : null}
          </>
        ) : null}
        <Badge tone="neutral" className="self-start">Visible to the team and shared reviewers</Badge>
      </div>
    </Card>
  );
}

function GuestThread({ t, people, highlight, onDone }: { t: ThreadDto; people: People; highlight: boolean; onDone: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const key = useRef(newClientKey('gr'));
  return (
    <article id={`thread-${t.id}`} tabIndex={-1} className={cn('rounded-lg border border-border px-3 py-2 outline-none', highlight && 'ring-2 ring-[var(--accent)]')}>
      {t.resolved ? <Badge tone="success" className="mb-1">Resolved</Badge> : null}
      <ol className="flex flex-col gap-2">
        {t.comments.map((c, i) => (
          <li key={c.id} className={cn(i > 0 && 'border-l border-border pl-3')}>
            {c.deleted ? <p className="text-xs italic text-subtle">Comment deleted</p> : (
              <>
                <p className="mb-0.5 flex gap-2 text-xs text-muted"><span className="truncate font-medium text-fg">{c.mine ? 'You' : c.author?.name || 'Team'}</span><span className="ml-auto">{fmtRelative(c.created_at)}</span></p>
                <CommentBody body={c.body ?? ''} people={people} />
              </>
            )}
          </li>
        ))}
      </ol>
      {t.can.reply ? (open ? (
        <div className="mt-2 flex flex-col gap-2">
          <label htmlFor={`gr-${t.id}`} className="sr-only">Reply</label>
          <Textarea id={`gr-${t.id}`} rows={2} value={text} maxLength={5000} onChange={(e) => setText(e.target.value)} autoFocus />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" loading={busy} disabledReason={!text.trim() ? 'Write something first.' : null}
              onClick={async () => { setBusy(true); setErr(null); try { await api.post(`/api/threads/${t.id}/replies`, { body: text.trim(), client_key: key.current }); setText(''); setOpen(false); key.current = newClientKey('gr'); await onDone(); } catch (e) { setErr(e); } finally { setBusy(false); } }}>Reply</Button>
          </div>
          {err ? <ErrorNotice error={err} /> : null}
        </div>
      ) : <Button size="sm" variant="ghost" className="mt-1" onClick={() => setOpen(true)}>Reply</Button>) : null}
    </article>
  );
}

function RejectDialog({ open, onOpenChange, id, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; id: string; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} busy={busy} title="Request changes" description="The team will see this."
      footer={<>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
        <Button variant="danger" loading={busy} disabledReason={!reason.trim() ? 'A reason is required.' : null}
          onClick={async () => { setBusy(true); setError(null); try { await api.post(`/api/review/${id}/reject`, { reason: reason.trim() }); onOpenChange(false); setReason(''); await onDone(); } catch (e) { setError(e); } finally { setBusy(false); } }}>
          Request changes
        </Button>
      </>}>
      <Field label="Reason" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={2000} autoFocus /></Field>
      {error ? <ErrorNotice error={error} className="mt-3" /> : null}
    </Dialog>
  );
}
