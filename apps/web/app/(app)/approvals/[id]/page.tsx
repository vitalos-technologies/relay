'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, Check, ExternalLink, X } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { diffWords } from '@/lib/client/diff';
import { outgoingText } from '@/lib/client/variants';
import type { Approval, ApprovalDetail, Asset } from '@/lib/client/types';
import {
  Badge, Banner, Button, Card, CardHeader, ConfirmDialog, Dialog, ErrorNotice, ErrorState, Facts, Field, InfoTip, PageHeader, PlatformIcon,
  SimulatedBadge, Skeleton, Textarea, TimeWithZone, ToneIcon, useToast,
} from '@/components/ui';
import { VariantPreview } from '@/components/composer/preview';
import { StageProgressList } from '@/components/collab/stage-progress';
import { CommentsPanel } from '@/components/collab/comments-panel';
import { ReviewShares } from '@/components/collab/review-shares';
import { ReviewAssignment } from '@/components/collab/review-assignment';
import { INELIGIBLE, type ReviewState } from '@/components/collab/types';

type DetailV2 = ApprovalDetail & { review: ReviewState; can_decide: boolean; can_assign: boolean; can_share: boolean; brand_id: string };

export default function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<DetailV2>(`/api/approvals/${id}`);
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  if (error && !data) return <div className="max-w-xl"><BackLink /><ErrorState error={error} onRetry={refetch} title="Couldn’t load approval" /></div>;
  if (loading || !data) {
    return (
      <div role="status" aria-label="Loading approval">
        <Skeleton className="h-8 w-1/2" />
        <div className="mt-6 grid gap-4 lg:grid-cols-2"><Skeleton className="h-72 w-full rounded-xl" /><Skeleton className="h-72 w-full rounded-xl" /></div>
      </div>
    );
  }

  const s = data.schedule;
  const pending = data.decision === 'pending';
  // V2: the server evaluates the caller's eligibility for the CURRENT stage (roles/teams/quorum/separation of duties).
  const mayDecide = data.can_decide && pending;
  const r = data.review;
  const assetMap = new Map<string, Asset>(data.variants.flatMap((v) => v.assets.map((a) => [a.id, a] as [string, Asset])));
  const changed = new Set(data.diff.changed_destinations);
  const bt = data.diff.base_text;

  return (
    <div className="pb-24">
      <BackLink />
      <PageHeader
        eyebrow={data.brand.name}
        title={data.post_title?.trim() || 'Review'}
        meta={<span className="truncate">by {data.requested_by_email ?? 'a teammate'}</span>}
        actions={<Link href={`/posts/${data.post_id}`} className="inline-flex items-center gap-1.5 rounded text-[13px] text-muted hover:text-fg">Open post <ExternalLink aria-hidden className="size-3.5" /></Link>}
      />

      <DecisionBanner a={data} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          {data.diff.previous_revision_number !== null ? (
            <Card aria-labelledby="h-diff">
              <CardHeader id="h-diff" title={<>Changes since r{data.diff.previous_revision_number}{changed.size ? <span className="ml-2 font-normal text-muted">{changed.size} destination{changed.size === 1 ? '' : 's'}</span> : null}</>} />
              <div className="px-4 pb-4">
                {bt ? (
                  <>
                    <p className="mb-2 flex gap-2 text-xs"><span className="rounded bg-success-soft px-1 text-success">added</span><span className="rounded bg-danger-soft px-1 text-danger line-through">removed</span></p>
                    <p className="whitespace-pre-wrap break-words rounded-lg bg-sunken px-3 py-2.5 text-[13px] leading-relaxed">
                      {diffWords(bt.before, bt.after).map((p, i) =>
                        p.kind === 'same' ? <span key={i}>{p.text}</span>
                          : p.kind === 'add' ? <ins key={i} className="rounded bg-success-soft text-success no-underline"><span className="sr-only">[added: </span>{p.text}<span className="sr-only">]</span></ins>
                            : <del key={i} className="rounded bg-danger-soft text-danger"><span className="sr-only">[removed: </span>{p.text}<span className="sr-only">]</span></del>,
                      )}
                    </p>
                  </>
                ) : <p className="text-[13px] text-muted">Text unchanged</p>}
              </div>
            </Card>
          ) : (
            null
          )}

          <section aria-labelledby="h-variants" className="flex flex-col gap-4">
            <h2 id="h-variants" className="text-[15px] font-semibold">What will be sent</h2>
            {data.variants.map((v) => (
              <Card key={v.connectionId} as="article" aria-label={`${PROVIDER_LABEL[v.provider]} ${v.connection.display_name}`}>
                <div className="flex items-center gap-3 px-4 pt-4">
                  <PlatformIcon provider={v.provider} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-2 text-sm font-medium"><span className="truncate">{v.connection.display_name}</span>{v.connection.is_mock ? <SimulatedBadge className="shrink-0" /> : null}</p>
                    <p className="truncate text-xs text-muted">{PROVIDER_LABEL[v.provider]}{v.connection.username ? ` · @${v.connection.username.replace(/^@/, '')}` : ''}{v.inheritText ? '' : ' · Custom text'}</p>
                  </div>
                  {changed.has(v.connectionId) ? <Badge tone="warn" icon={<ToneIcon tone="warn" className="size-3.5" />}>Changed</Badge> : null}
                </div>
                <div className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
                  <div className="min-w-0">
                    <p className="whitespace-pre-wrap break-words rounded-lg bg-sunken px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">{outgoingText(v, v.connection) || <span className="italic text-subtle">(no text)</span>}</p>
                    <Facts
                      className="mt-4"
                      items={[
                        ['Link', v.link ? <span key="l" className="break-all">{v.link}</span> : 'None'],
                        ['Media', v.assets.length ? v.assets.map((a) => `${a.original_filename}${a.alt_text ? ` (alt: ${a.alt_text})` : ' (no alt text)'}`).join(', ') : 'None'],
                        ...(v.buttons.length ? [['Buttons', v.buttons.map((b) => `${b.text} → ${b.url}`).join(' · ')] as [string, string]] : []),
                      ]}
                    />
                  </div>
                  <VariantPreview variant={v} connection={v.connection} assets={assetMap} />
                </div>
              </Card>
            ))}
          </section>
        </div>

        <aside className="flex flex-col gap-6">
          <Card aria-labelledby="h-review">
            <CardHeader id="h-review" title="Review" actions={r.separation_of_duties ? <Badge tone="neutral">Independent</Badge> : null} />
            <div className="flex flex-col gap-3 px-4 pb-4">
              <StageProgressList stages={r.stages} current={r.current_stage} />
              {pending && !data.can_decide && r.me.reason ? <p className="text-xs text-muted">{INELIGIBLE[r.me.reason] ?? 'Not your review'}</p> : null}
              {r.decisions.length ? (
                <ul className="flex flex-col gap-1 border-t border-border pt-3 text-xs" aria-label="Decisions">
                  {r.decisions.map((d, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <ToneIcon tone={d.decision === 'approved' ? 'success' : 'danger'} className="size-3.5" />
                      <span className="min-w-0 flex-1 truncate">{d.by}{d.as_guest ? ' (client)' : ''}</span>
                      <span className="text-subtle">S{d.stage}{d.decision === 'approved' && !d.counted ? ' · not counted' : ''}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </Card>
          {pending && data.can_assign ? (
            <Card aria-labelledby="h-assign"><CardHeader id="h-assign" title="Assignment" /><div className="px-4 pb-4"><ReviewAssignment approvalId={data.id} brandId={data.brand.id} assignee={r.assignee} dueAt={r.due_at} tz={s.input_timezone} onSaved={refetch} /></div></Card>
          ) : null}
          {data.can_share ? (
            <Card aria-labelledby="h-share"><CardHeader id="h-share" title="Client review" /><div className="px-4 pb-4"><ReviewShares postId={data.post_id} /></div></Card>
          ) : null}
          <Card aria-labelledby="h-comments"><CardHeader id="h-comments" title="Comments" /><div className="px-4 pb-4"><CommentsPanel postId={data.post_id} approvalId={data.id} /></div></Card>
          <Card aria-labelledby="h-when">
            <CardHeader id="h-when" title="Schedule" />
            <div className="px-4 pb-4">
              <Facts
                items={[
                  [s.is_immediate ? 'Publishes' : 'Scheduled', s.is_immediate ? 'On approval' : <TimeWithZone key="t" instant={s.due_at} tz={s.input_timezone} showBrowser />],
                  ['Zone', s.input_timezone],
                  ...(s.publish_before ? [[<span key="pbl" className="inline-flex items-center gap-1">Deadline<InfoTip label="About the deadline">Not sent after this time — it expires instead of posting late.</InfoTip></span>, <TimeWithZone key="pb" instant={s.publish_before} tz={s.input_timezone} />] as [React.ReactNode, React.ReactNode]] : []),
                  ['Revision', String(s.revision_number)],
                  ['Destinations', String(data.variants.length)],
                ]}
              />
            </div>
          </Card>
        </aside>
      </div>

      {mayDecide ? (
        <div className="fixed inset-x-0 bottom-16 z-20 border-t border-border bg-surface/95 backdrop-blur md:bottom-0 md:left-[224px]">
          <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-end gap-2 px-4 py-2 sm:px-6 md:px-8">
            <span className="mr-auto text-xs text-muted">Revision {s.revision_number}</span>
            <Button variant="secondary" icon={<X aria-hidden className="size-4" />} onClick={() => setRejectOpen(true)}>Request changes</Button>
            <Button variant="primary" icon={<Check aria-hidden className="size-4" />} onClick={() => setApproveOpen(true)}>Approve</Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        title="Approve?"
        description={s.is_immediate ? 'Publishes immediately.' : 'Publishes at the scheduled time.'}
        confirmLabel="Approve"
        onConfirm={async () => {
          await api.post(`/api/approvals/${data.id}/approve`, { expected_fingerprint: data.fingerprint });
          toast.success('Approved');
          await refetch();
        }}
      >
      </ConfirmDialog>
      <RejectDialog open={rejectOpen} onOpenChange={setRejectOpen} approvalId={data.id} onDone={async () => { toast.success('Changes requested'); await refetch(); }} />
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/approvals" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
      <ArrowLeft aria-hidden className="size-4" /> Approvals
    </Link>
  );
}

function DecisionBanner({ a }: { a: Approval }) {
  if (a.decision === 'pending') return null;
  const tone = a.decision === 'approved' ? 'success' : a.decision === 'rejected' ? 'danger' : 'neutral';
  const title = a.decision === 'approved' ? 'Approved' : a.decision === 'rejected' ? 'Changes requested' : 'Invalidated — post changed';
  return (
    <Banner tone={tone} className="mb-6" icon={<ToneIcon tone={tone} />} title={title}>
      {a.reviewer_email ? <>By {a.reviewer_email}{a.decided_at ? <> · <TimeWithZone instant={a.decided_at} tz="UTC" /></> : null}. </> : null}
      {a.reason ? <span className="mt-1 block">“{a.reason}”</span> : null}
    </Banner>
  );
}

function RejectDialog({ open, onOpenChange, approvalId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; approvalId: string; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/approvals/${approvalId}/reject`, { reason: reason.trim() });
      onOpenChange(false);
      setReason('');
      await onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      title="Request changes"
      description="The author will see this."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={submit} loading={busy} disabledReason={!reason.trim() ? 'A reason is required.' : null}>Request changes</Button>
        </>
      }
    >
      <Field label="Reason" required>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={2000} autoFocus />
      </Field>
      {error ? <ErrorNotice error={error} className="mt-3" /> : null}
    </Dialog>
  );
}
