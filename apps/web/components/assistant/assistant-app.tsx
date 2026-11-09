'use client';
// AI Assistant area: Ask (brand knowledge Q&A, briefs, copy), History (my runs) and Knowledge (sources a brand manager
// approved for the assistant). Status is shown honestly: when no provider is configured the assistant is off.
import Link from 'next/link';
import { useState } from 'react';
import { BookCheck, Bot, History, MessageCircleQuestion, Plus, Trash2, Workflow } from 'lucide-react';
import { TASK_LABEL, type AssistantRunDto, type AssistantStatusDto, type KnowledgeSourceDto } from '@social-lite/core/contracts/v35-ai';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useBrandFilter } from '@/lib/client/hooks';
import { useSession } from '@/lib/client/session';
import {
  Badge, Banner, Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, IconButton, Input, LinkButton, PageHeader, Select, SkeletonRows, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, useToast,
} from '@/components/ui';
import { RunView } from './run-view';

const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
const STATUS_TONE: Record<AssistantRunDto['status'], 'success' | 'warn' | 'danger' | 'neutral' | 'info'> = {
  queued: 'info', running: 'info', succeeded: 'success', failed: 'danger', refused: 'warn', not_configured: 'neutral', budget_exhausted: 'warn', blocked: 'warn', cancelled: 'neutral',
};
const STATUS_LABEL: Record<AssistantRunDto['status'], string> = {
  queued: 'Queued', running: 'Working', succeeded: 'Done', failed: 'Failed', refused: 'Declined', not_configured: 'Not set up', budget_exhausted: 'Budget used up', blocked: 'Stopped', cancelled: 'Cancelled',
};

export function AssistantApp() {
  const { canV2 } = useSession();
  const status = useApi<AssistantStatusDto>('/api/assistant/status');
  const [tab, setTab] = useState('ask');
  const s = status.data;
  return (
    <div>
      <PageHeader title="Assistant" meta={s ? (s.configured ? `${s.remaining.toLocaleString()} tokens left` : 'Off') : undefined}
        actions={canV2('automation.manage') ? <LinkButton href="/automation" variant="secondary" icon={<Workflow aria-hidden className="size-4" />}>Automation</LinkButton> : null} />
      {s && !s.configured ? (
        <Banner tone="info" title="AI is not set up" className="mb-6">No AI provider is configured, so the assistant is off. An owner can add a provider key in Setup.</Banner>
      ) : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Assistant sections">
          <TabsTrigger value="ask"><MessageCircleQuestion aria-hidden className="size-4" />Ask</TabsTrigger>
          <TabsTrigger value="history"><History aria-hidden className="size-4" />History</TabsTrigger>
          <TabsTrigger value="knowledge"><BookCheck aria-hidden className="size-4" />Knowledge</TabsTrigger>
        </TabsList>
        <TabsContent value="ask" className="pt-5"><Ask status={s} /></TabsContent>
        <TabsContent value="history" className="pt-5">{tab === 'history' ? <RunHistory /> : null}</TabsContent>
        <TabsContent value="knowledge" className="pt-5">{tab === 'knowledge' ? <Knowledge /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}

function BrandSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { session } = useSession();
  return (
    <Select aria-label="Brand" value={value} onChange={(e) => onChange(e.target.value)}>
      {session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </Select>
  );
}

function Ask({ status }: { status: AssistantStatusDto | undefined }) {
  const { session } = useSession();
  const [filter] = useBrandFilter();
  const [brand, setBrand] = useState(filter || session.brands[0]?.id || '');
  const [task, setTask] = useState<'answer_question' | 'campaign_brief' | 'draft_copy'>('answer_question');
  const [prompt, setPrompt] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const run = useApi<AssistantRunDto>(runId ? `/api/assistant/runs/${runId}` : null, { poll: (d) => (!d || d.status === 'queued' || d.status === 'running' ? 1500 : false) });
  const start = async () => {
    setBusy(true);
    try {
      const r = await api.post<AssistantRunDto>('/api/assistant/runs', { surface: 'content_hub', task, context: { type: 'brand', id: brand }, prompt, idempotency_key: newKey() });
      setRunId(r.id);
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <Card className="flex flex-col gap-4 p-4 sm:p-5">
        <Field label="Brand"><BrandSelect value={brand} onChange={setBrand} /></Field>
        <Field label="Task">
          <Select value={task} onChange={(e) => setTask(e.target.value as typeof task)}>
            {(['answer_question', 'campaign_brief', 'draft_copy'] as const).map((t) => <option key={t} value={t}>{TASK_LABEL[t]}</option>)}
          </Select>
        </Field>
        <Field label={task === 'answer_question' ? 'Question' : task === 'campaign_brief' ? 'Brief' : 'What to write'}>
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} maxLength={2000} placeholder={task === 'answer_question' ? 'e.g. What is our returns window?' : undefined} />
        </Field>
        <Button variant="primary" icon={<Bot aria-hidden className="size-4" />} loading={busy || run.data?.status === 'queued' || run.data?.status === 'running'} onClick={() => void start()}
          disabledReason={!status?.configured ? 'AI is not set up' : !status.can_use ? 'You can’t use the assistant' : !brand ? 'Choose a brand' : !prompt.trim() && task !== 'draft_copy' ? 'Write something first' : null}>Ask</Button>
        <p className="text-xs text-subtle">Answers use approved knowledge for this brand. Anything about prices, refunds or commitments without a current source is marked uncertain.</p>
      </Card>
      <div className="min-w-0">
        {run.data ? <Card className="p-4 sm:p-5"><RunView run={run.data} onChanged={() => void run.refetch()} /></Card>
          : <EmptyState compact icon={<Bot aria-hidden />} title="Results show here, with sources" />}
      </div>
    </div>
  );
}

export function RunHistory() {
  const runs = useApi<{ items: AssistantRunDto[] }>('/api/assistant/runs?limit=30');
  const [open, setOpen] = useState<AssistantRunDto | null>(null);
  if (runs.error && !runs.data) return <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />;
  if (!runs.data) return <SkeletonRows rows={4} />;
  if (!runs.data.items.length) return <EmptyState compact icon={<History aria-hidden />} title="No assistant runs yet" />;
  return (
    <>
      <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
        {runs.data.items.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => setOpen(r)} className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left text-[13px] hover:bg-raised">
              <span className="min-w-0 flex-1 truncate font-medium">{TASK_LABEL[r.task]}</span>
              <span className="text-xs text-muted">{r.surface.replace('_', ' ')}</span>
              <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
              <span className="tabular text-xs text-subtle">{new Date(r.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={!!open} onOpenChange={(v) => { if (!v) setOpen(null); }} title={open ? TASK_LABEL[open.task] : ''} size="lg">
        {open ? <RunView run={open} onChanged={() => void runs.refetch()} /> : null}
      </Dialog>
    </>
  );
}

export function Knowledge() {
  const { session, canOn } = useSession();
  const toast = useToast();
  const [filter] = useBrandFilter();
  const [brand, setBrand] = useState(filter || session.brands[0]?.id || '');
  const list = useApi<{ items: KnowledgeSourceDto[]; can_manage: boolean }>(brand ? `/api/assistant/knowledge?brand_id=${brand}` : null);
  const [adding, setAdding] = useState(false);
  const [revoke, setRevoke] = useState<KnowledgeSourceDto | null>(null);
  const manage = brand ? canOn(brand, 'brands.manage') : false;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Brand" className="w-full sm:w-72"><BrandSelect value={brand} onChange={setBrand} /></Field>
        {manage ? <Button variant="secondary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setAdding(true)}>Approve source</Button> : null}
      </div>
      {list.error && !list.data ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : !list.data ? <SkeletonRows rows={3} /> : !list.data.items.length ? (
        <EmptyState compact icon={<BookCheck aria-hidden />} title="No approved knowledge for this brand" />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {list.data.items.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-[13px]">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{k.title}</p>
                <p className="text-xs text-muted">{k.kind === 'saved_reply' ? 'Saved reply' : 'Content Hub document'}{k.topics.length ? ` · ${k.topics.join(', ')}` : ''}{k.review_by ? ` · review by ${k.review_by}` : ''}</p>
              </div>
              {!k.available ? <Badge tone="danger">Unavailable</Badge> : k.stale ? <Badge tone="warn">Review overdue</Badge> : <Badge tone="success">Current</Badge>}
              {manage ? <IconButton label={`Remove ${k.title}`} icon={<Trash2 className="size-4" />} variant="ghost" onClick={() => setRevoke(k)} /> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-subtle">Only approved sources are used for knowledge answers. Text stays in the Content Hub or saved replies and is read with each person’s own access.</p>
      {adding ? <ApproveDialog brandId={brand} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void list.refetch(); }} /> : null}
      <ConfirmDialog open={!!revoke} onOpenChange={(v) => { if (!v) setRevoke(null); }} title="Remove from knowledge?" confirmLabel="Remove" confirmVariant="danger"
        onConfirm={async () => { await api.del(`/api/assistant/knowledge/${revoke!.id}`); toast.success('Removed'); setRevoke(null); void list.refetch(); }}>
        The assistant stops using it right away.
      </ConfirmDialog>
    </div>
  );
}

function ApproveDialog({ brandId, onClose, onDone }: { brandId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const c = useApi<{ items: Array<{ kind: 'source_item' | 'saved_reply'; ref_id: string; title: string; approved: boolean }> }>(`/api/assistant/knowledge/candidates?brand_id=${brandId}`);
  const [pick, setPick] = useState('');
  const [topics, setTopics] = useState('');
  const [review, setReview] = useState('');
  const [busy, setBusy] = useState(false);
  const items = (c.data?.items ?? []).filter((i) => !i.approved);
  const chosen = items.find((i) => `${i.kind}:${i.ref_id}` === pick);
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} title="Approve knowledge source" footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" loading={busy} disabledReason={!chosen ? 'Choose a source' : null} onClick={async () => {
        setBusy(true);
        try {
          await api.post('/api/assistant/knowledge', { brand_id: brandId, kind: chosen!.kind, ref_id: chosen!.ref_id, topics: topics.split(',').map((t) => t.trim()).filter(Boolean), review_by: review || null });
          toast.success('Approved'); onDone();
        } catch (e) { toast.error(e); } finally { setBusy(false); }
      }}>Approve</Button>
    </>}>
      <div className="flex flex-col gap-4">
        <Field label="Source">
          <Select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{c.data ? (items.length ? 'Choose…' : 'Nothing left to approve') : 'Loading…'}</option>
            {items.map((i) => <option key={`${i.kind}:${i.ref_id}`} value={`${i.kind}:${i.ref_id}`}>{i.kind === 'saved_reply' ? 'Saved reply' : 'Document'} · {i.title}</option>)}
          </Select>
        </Field>
        <Field label="Topics" optional hint="Comma-separated, e.g. shipping, returns"><Input value={topics} onChange={(e) => setTopics(e.target.value)} maxLength={200} /></Field>
        <Field label="Review by" optional hint="After this date it is not used for prices, refunds or commitments."><Input type="date" value={review} onChange={(e) => setReview(e.target.value)} /></Field>
        <p className="text-xs text-muted">Link documents in the <Link href="/library" className="underline">Content library</Link> first.</p>
      </div>
    </Dialog>
  );
}
