'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, Check, ExternalLink, X } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { diffWords } from '@/lib/client/diff';
import { outgoingText } from '@/lib/client/variants';
import type { Approval, ApprovalDetail, Asset } from '@/lib/client/types';
import {
  Badge, Banner, Button, Card, CardHeader, ConfirmDialog, Dialog, ErrorNotice, ErrorState, Facts, Field, PageHeader, PlatformIcon,
  SimulatedBadge, Skeleton, Textarea, TimeWithZone, ToneIcon, useToast,
} from '@/components/ui';
import { VariantPreview } from '@/components/composer/preview';

export default function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<ApprovalDetail>(`/api/approvals/${id}`);
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  if (error && !data) return <div className="max-w-xl"><BackLink /><ErrorState error={error} onRetry={refetch} title="This approval couldn’t be loaded" /></div>;
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
  const mayDecide = can('approvals.decide') && pending;
  const assetMap = new Map<string, Asset>(data.variants.flatMap((v) => v.assets.map((a) => [a.id, a] as [string, Asset])));
  const changed = new Set(data.diff.changed_destinations);
  const bt = data.diff.base_text;

  return (
    <div className="pb-24">
      <BackLink />
      <PageHeader
        eyebrow={data.brand.name}
        title={data.post_title?.trim() || 'Review post'}
        description={<>Requested by {data.requested_by_email ?? 'a teammate'}. Approval covers this exact text, media, links, destinations and time — any change needs a new approval.</>}
        actions={<Link href={`/posts/${data.post_id}`} className="inline-flex items-center gap-1.5 text-[13px] text-accent-text hover:underline">Open post <ExternalLink aria-hidden className="size-3.5" /></Link>}
      />

      <DecisionBanner a={data} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          {data.diff.previous_revision_number !== null ? (
            <Card aria-labelledby="h-diff">
              <CardHeader id="h-diff" title={`Changes since revision ${data.diff.previous_revision_number}`} description={changed.size ? `${changed.size} destination${changed.size === 1 ? '' : 's'} changed` : undefined} />
              <div className="p-5">
                {bt ? (
                  <>
                    <p className="mb-2 text-xs text-muted">Base text — <span className="rounded bg-success-soft px-1 text-success">added</span> and <span className="rounded bg-danger-soft px-1 text-danger line-through">removed</span> words</p>
                    <p className="whitespace-pre-wrap break-words rounded-lg bg-sunken px-3 py-2.5 text-[13px] leading-relaxed">
                      {diffWords(bt.before, bt.after).map((p, i) =>
                        p.kind === 'same' ? <span key={i}>{p.text}</span>
                          : p.kind === 'add' ? <ins key={i} className="rounded bg-success-soft text-success no-underline"><span className="sr-only">[added: </span>{p.text}<span className="sr-only">]</span></ins>
                            : <del key={i} className="rounded bg-danger-soft text-danger"><span className="sr-only">[removed: </span>{p.text}<span className="sr-only">]</span></del>,
                      )}
                    </p>
                  </>
                ) : <p className="text-[13px] text-muted">Base text unchanged.</p>}
              </div>
            </Card>
          ) : (
            <Banner tone="info">First revision submitted for review — there is no earlier version to compare.</Banner>
          )}

          <section aria-labelledby="h-variants" className="flex flex-col gap-4">
            <h2 id="h-variants" className="text-[15px] font-semibold">Exactly what will be sent</h2>
            {data.variants.map((v) => (
              <Card key={v.connectionId} as="article" aria-label={`${PROVIDER_LABEL[v.provider]} ${v.connection.display_name}`}>
                <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3.5">
                  <PlatformIcon provider={v.provider} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">{v.connection.display_name}{v.connection.is_mock ? <SimulatedBadge /> : null}</p>
                    <p className="text-xs text-muted">{PROVIDER_LABEL[v.provider]}{v.connection.username ? ` · @${v.connection.username.replace(/^@/, '')}` : ''}</p>
                  </div>
                  {changed.has(v.connectionId) ? <Badge tone="warn">Changed</Badge> : null}
                  <Badge>{v.inheritText ? 'Base text' : 'Custom text'}</Badge>
                </div>
                <div className="grid grid-cols-1 gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
                  <div className="min-w-0">
                    <p className="mb-1.5 text-xs font-medium text-muted">Outgoing text</p>
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
          <Card aria-labelledby="h-when">
            <CardHeader id="h-when" title="Schedule" />
            <div className="p-5">
              <Facts
                items={[
                  [s.is_immediate ? 'Publishes' : 'Scheduled for', s.is_immediate ? 'As soon as approved' : <TimeWithZone key="t" instant={s.due_at} tz={s.input_timezone} showBrowser />],
                  ['Time zone', s.input_timezone],
                  ...(s.publish_before ? [['Publish before', <TimeWithZone key="pb" instant={s.publish_before} tz={s.input_timezone} />] as [string, React.ReactNode]] : []),
                  ['Revision', String(s.revision_number)],
                  ['Destinations', String(data.variants.length)],
                ]}
              />
            </div>
          </Card>
        </aside>
      </div>

      {mayDecide ? (
        <div className="fixed inset-x-0 bottom-16 z-20 border-t border-border bg-surface/95 backdrop-blur md:bottom-0 md:left-[248px]">
          <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-end gap-2 px-4 py-2.5 sm:px-6 md:px-8">
            <span className="mr-auto text-[13px] text-muted">Your decision applies to this exact revision.</span>
            <Button variant="danger" icon={<X aria-hidden className="size-4" />} onClick={() => setRejectOpen(true)}>Request changes</Button>
            <Button variant="primary" icon={<Check aria-hidden className="size-4" />} onClick={() => setApproveOpen(true)}>Approve</Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        title="Approve this post?"
        description={s.is_immediate ? 'It will be published as soon as you approve.' : 'It will be published at the scheduled time.'}
        confirmLabel="Approve"
        onConfirm={async () => {
          await api.post(`/api/approvals/${data.id}/approve`, { expected_fingerprint: data.fingerprint });
          toast.success('Approved');
          await refetch();
        }}
      >
        <p className="text-[13px] text-muted">If the post was changed after you opened this page, approval is refused and you’ll see the new version.</p>
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
  const title = a.decision === 'approved' ? 'Approved' : a.decision === 'rejected' ? 'Changes requested' : 'No longer valid — the post changed after this request';
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
      description="The author sees your reason. Be specific about what needs to change."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={submit} loading={busy} disabledReason={!reason.trim() ? 'A reason is required.' : null}>Request changes</Button>
        </>
      }
    >
      <Field label="Reason" required hint="Required.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={2000} autoFocus />
      </Field>
      {error ? <ErrorNotice error={error} className="mt-3" /> : null}
    </Dialog>
  );
}
