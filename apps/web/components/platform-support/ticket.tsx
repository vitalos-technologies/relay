'use client';
// Platform → Support → one ticket (V4 SUP). Public reply and internal note are separate modes with distinct frames
// (shared conversation composer): replies reach the customer, notes never do. Workspace context is metadata only.
// AI assistance returns drafts that a person inserts and edits; nothing is sent or changed automatically.
import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';
import { BookOpenText, Copy, KeyRound, Lock, MoreHorizontal, Sparkles } from 'lucide-react';
import {
  SUPPORT_CATEGORY_LABEL, SUPPORT_PRIORITIES, SUPPORT_RESOLUTION_REASONS, SUPPORT_TICKET_CATEGORIES, type SavedReplyDto, type StaffTicketDetail, type SupportAiDraftDto,
  type SupportAiTask, type SupportResolutionReason, type SupportStaffDto, type SupportTicketCategory,
} from '@social-lite/core/contracts/v4-support';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { ConversationComposer } from '@/components/conversation/composer';
import { ConversationTimeline, type TimelineEntryView } from '@/components/conversation/timeline';
import {
  Badge, Banner, Button, Card, CardHeader, ConfirmDialog, ErrorNotice, ErrorState, Facts, Field, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, PageHeader,
  Select, SkeletonRows, Textarea, useToast,
} from '@/components/ui';
import { Ago } from '@/components/admin/ui';
import { AttachmentLinks, AttachmentPicker, useAttachments } from '@/components/support/attachments';
import { PRIORITY_TONE, STAFF_STATUS, useStaffFeed } from './inbox';

const REASON_LABEL: Record<SupportResolutionReason, string> = {
  answered: 'Answered', fixed: 'Fixed', duplicate: 'Duplicate', not_reproducible: 'Could not reproduce', wont_fix: 'Won’t fix', customer_resolved: 'Resolved by customer', no_response: 'No response', other: 'Other',
};
const EMAIL_LABEL: Record<string, string> = { sent: 'emailed', pending: 'email queued', not_configured: 'email not configured', failed: 'email failed', skipped: 'email skipped', none: 'in-app only' };

function deliveryText(d: { recipients: number; email: Record<string, number> } | undefined): ReactNode {
  if (!d) return <span className="text-subtle">· not notified yet</span>;
  const parts = Object.entries(d.email).map(([k, n]) => `${n} ${EMAIL_LABEL[k] ?? k}`);
  const bad = d.email.failed || d.email.not_configured;
  return <span className={bad ? 'text-warn' : 'text-subtle'}>· notified {d.recipients}{parts.length ? ` (${parts.join(', ')})` : ''}</span>;
}

export function StaffTicketView({ reference }: { reference: string }) {
  const toast = useToast();
  const { session } = useSession();
  const me = session.user.id;
  const path = `/api/platform/support/tickets/${encodeURIComponent(reference)}`;
  const { data, error, loading, refetch, setData } = useApi<StaffTicketDetail>(path);
  const staff = useApi<{ items: SupportStaffDto[] }>('/api/platform/support/staff');
  const saved = useApi<{ items: SavedReplyDto[] }>('/api/platform/support/saved-replies');
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [body, setBody] = useState('');
  const [resolveOnSend, setResolveOnSend] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [dialog, setDialog] = useState<null | 'resolve' | 'duplicate' | 'access'>(null);
  const files = useAttachments('/api/platform/support/attachments');
  const composer = useRef<HTMLDivElement>(null);
  useStaffFeed(() => void refetch(), 6000);

  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <SkeletonRows rows={6} />;
  const run = async (name: string, fn: () => Promise<StaffTicketDetail>, msg: string) => {
    setBusy(name); setErr(null);
    try { setData(await fn()); toast.success(msg); } catch (e) { setErr(e); toast.error(e, 'Not done'); } finally { setBusy(null); }
  };
  const patch = (b: Record<string, unknown>, msg = 'Saved') => run('patch', () => api.patch<StaffTicketDetail>(path, b), msg);
  const send = () => run(mode, async () => {
    const url = `${path}/${mode === 'reply' ? 'replies' : 'notes'}`;
    const r = await api.post<StaffTicketDetail>(url, { body: body.trim(), attachment_ids: files.readyIds, ...(mode === 'reply' && resolveOnSend ? { resolve: 'answered' } : {}) }, { idempotent: true });
    setBody(''); files.clear(); return r;
  }, mode === 'reply' ? 'Reply sent' : 'Note added');
  const insert = (text: string, as: 'reply' | 'note' = 'reply') => { setMode(as); setResolveOnSend(false); setBody((b) => (b.trim() ? `${b.trim()}\n\n${text}` : text)); composer.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); };

  const entries: TimelineEntryView[] = data.timeline.map((i) => {
    if (i.type === 'note') return { key: `n${i.id}`, kind: 'note', author: i.author.name, body: i.body, at: i.created_at, attachments: i.attachments.length ? [<AttachmentLinks key="a" files={i.attachments} />] : undefined };
    if (i.type === 'activity') return { key: `a${i.id}`, kind: 'system', text: i.audience === 'staff' ? `Staff only · ${i.text}` : i.text, at: i.created_at };
    return { key: `m${i.id}`, kind: 'message', side: i.author.kind === 'staff' ? 'us' : 'them', author: i.author.kind === 'staff' ? `${i.author.name} (Relay)` : i.author.name, body: i.body, at: i.created_at,
      meta: i.author.kind === 'staff' ? deliveryText(i.delivery) : undefined, attachments: i.attachments.length ? [<AttachmentLinks key="a" files={i.attachments} />] : undefined };
  });
  const st = STAFF_STATUS[data.status];
  const closed = data.status === 'resolved' || data.status === 'archived';
  const ctx = data.context;
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/admin/platform/support" className="hover:underline">Support</Link>}
        title={data.subject}
        meta={<>
          <Badge tone={st.tone}>{st.label}</Badge>
          {data.priority !== 'normal' ? <Badge tone={PRIORITY_TONE[data.priority]}>{data.priority}</Badge> : null}
          {data.restricted ? <Badge icon={<Lock aria-hidden className="size-3" />}>Restricted</Badge> : null}
          <span className="text-xs text-muted">{data.reference} · {data.source === 'problem_report' ? 'from problem report' : data.source === 'widget' ? 'marketing widget' : data.source}</span>
        </>}
        actions={
          <Menu>
            <MenuTrigger asChild><Button size="sm" icon={<MoreHorizontal aria-hidden className="size-4" />}>Actions</Button></MenuTrigger>
            <MenuContent align="end">
              {!closed ? <MenuItem onSelect={() => setDialog('resolve')}>Resolve…</MenuItem> : null}
              {data.status === 'resolved' ? <MenuItem onSelect={() => void patch({ status: 'archived' }, 'Archived')}>Archive</MenuItem> : null}
              {closed ? <MenuItem onSelect={() => void patch({ status: 'waiting_on_relay' }, 'Reopened')}>Reopen</MenuItem> : null}
              {!closed ? <MenuItem onSelect={() => void patch({ status: data.status === 'waiting_on_customer' ? 'waiting_on_relay' : 'waiting_on_customer' })}>{data.status === 'waiting_on_customer' ? 'Mark waiting on Relay' : 'Mark waiting on customer'}</MenuItem> : null}
              <MenuSeparator />
              <MenuItem icon={<Copy aria-hidden />} onSelect={() => setDialog('duplicate')}>Mark as duplicate…</MenuItem>
              {data.workspace ? <MenuItem icon={<KeyRound aria-hidden />} onSelect={() => setDialog('access')}>Request support access…</MenuItem> : null}
              {data.visitor ? (
                <MenuItem onSelect={() => { const blocked = !!data.visitor?.blocked; void run('block', async () => { await api.post(`${path}/visitor`, { blocked: !blocked }); return api.get<StaffTicketDetail>(path); }, blocked ? 'Visitor unblocked' : 'Visitor blocked'); }}>
                  {data.visitor.blocked ? 'Unblock visitor' : 'Block visitor…'}
                </MenuItem>
              ) : null}
            </MenuContent>
          </Menu>
        }
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
            <Field label="Assignee">
              <Select value={data.assignee?.id ?? ''} disabled={busy === 'assign'} onChange={(e) => void run('assign', () => api.post(`${path}/assign`, { assignee_id: e.target.value || null }), 'Assigned')}>
                <option value="">Unassigned</option>
                {(staff.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.id === me ? `Me (${s.name ?? s.email})` : s.name ?? s.email}</option>)}
              </Select>
            </Field>
            <Field label="Priority">
              <Select value={data.priority} onChange={(e) => void patch({ priority: e.target.value })}>
                {SUPPORT_PRIORITIES.map((p) => <option key={p} value={p}>{p[0]!.toUpperCase() + p.slice(1)}</option>)}
              </Select>
            </Field>
            <Field label="Category">
              <Select value={data.category} onChange={(e) => void patch({ category: e.target.value })}>
                {SUPPORT_TICKET_CATEGORIES.map((c) => <option key={c} value={c}>{SUPPORT_CATEGORY_LABEL[c]}</option>)}
              </Select>
            </Field>
          </Card>
          {data.duplicate_of ? <Banner tone="info">Duplicate of {data.duplicates.find((d) => d.id === data.duplicate_of)?.reference ?? 'another ticket'}</Banner> : null}
          <Card className="p-4"><ConversationTimeline entries={entries} /></Card>
          {err ? <ErrorNotice error={err} /> : null}
          <div ref={composer} className="z-10 md:sticky md:bottom-0 md:-mx-1 md:bg-[var(--bg)] md:px-1 md:pb-4 md:pt-2">
            <ConversationComposer
              modes={[{ value: 'reply', label: 'Reply to customer', audience: 'private', disabled: data.status === 'archived', reason: data.status === 'archived' ? 'Reopen the ticket to reply.' : null },
                { value: 'note', label: 'Internal note', audience: 'internal' }]}
              mode={mode} onModeChange={(m) => { setMode(m); setResolveOnSend(false); }} body={body} onBodyChange={setBody} busy={busy === mode} maxLength={10000}
              audienceText={{ private: `Sent to ${data.requester.name ?? 'the customer'}`, internal: 'Staff only — never shown to the customer' }}
              submitDisabledReason={files.busy ? 'Files are still being checked' : null}
              toolbar={
                <Menu>
                  <MenuTrigger asChild><Button size="sm" variant="ghost" icon={<BookOpenText aria-hidden className="size-4" />}>Saved replies</Button></MenuTrigger>
                  <MenuContent align="end" className="max-h-[50dvh] w-72 overflow-y-auto">
                    {(saved.data?.items ?? []).length ? saved.data!.items.map((s) => <MenuItem key={s.id} onSelect={() => insert(s.body, mode)}><span className="truncate">{s.title}</span></MenuItem>)
                      : <p className="px-3 py-2 text-[13px] text-muted">None yet · <Link href="/admin/platform/support/saved-replies" className="underline">add</Link></p>}
                  </MenuContent>
                </Menu>
              }
              below={<div className="flex flex-wrap items-center justify-between gap-2">
                <AttachmentPicker state={files} compact />
                {mode === 'reply' && !closed ? <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={resolveOnSend} onChange={(e) => setResolveOnSend(e.target.checked)} className="size-4" />Resolve after sending</label> : null}
              </div>}
              onSubmit={() => void send()} />
          </div>
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader title="Customer" />
            <div className="px-4 pb-4">
              <Facts items={[
                ['Requester', data.requester.name ? `${data.requester.name}${data.requester_kind === 'visitor' ? ' (visitor)' : ''}` : '—'],
                ['Email', data.requester.email ? `${data.requester.email}${data.visitor ? (data.visitor.email_verified ? ' · verified' : ' · not verified') : ''}` : '—'],
                ...(data.visitor ? [
                  ['Account', 'Not linked — visitors are never matched to accounts by email'] as [string, string],
                  ['Chat sessions', `${data.visitor.sessions} active${data.visitor.other_conversations ? ` · ${data.visitor.other_conversations} other conversation${data.visitor.other_conversations === 1 ? '' : 's'}` : ''}`] as [string, string],
                  ...(data.visitor.blocked ? [['Status', 'Blocked'] as [string, string]] : []),
                ] : []),
                ['Workspace', data.workspace ? <Link key="w" className="hover:underline" href={`/admin/platform/workspaces/${data.workspace.id}`}>{data.workspace.name}</Link> : '—'],
                ...(ctx.workspace ? [
                  ['State', ctx.workspace.state + (ctx.workspace.is_demo ? ' · demo' : '')] as [string, string],
                  ['Members', String(ctx.workspace.members)] as [string, string],
                ] : []),
                ...(ctx.commercial ? [['Plan', [ctx.commercial.plan, ctx.commercial.status, ctx.commercial.access && ctx.commercial.access !== 'full' ? ctx.commercial.access : null].filter(Boolean).join(' · ') || '—'] as [string, string]] : []),
                ['Connections', ctx.connections.total ? `${ctx.connections.healthy}/${ctx.connections.total} healthy` : 'None'],
                ...(ctx.connections.problems.length ? [['Problems', ctx.connections.problems.map((p) => `${p.provider} ${p.status.replace(/_/g, ' ')} ×${p.count}`).join(', ')] as [string, string]] : []),
                ['Failures (7d)', ctx.recent_failures.failed || ctx.recent_failures.unknown ? `${ctx.recent_failures.failed} failed · ${ctx.recent_failures.unknown} unknown${ctx.recent_failures.codes.length ? ` · ${ctx.recent_failures.codes.map((c) => c.code).join(', ')}` : ''}` : 'None'],
                ['Participants', data.participants.length ? data.participants.map((p) => p.name ?? p.email).join(', ') : '—'],
              ]} />
            </div>
          </Card>
          {Object.keys(data.diagnostics).length ? (
            <Card>
              <CardHeader title="Diagnostics" />
              <div className="px-4 pb-4"><Facts items={Object.entries(data.diagnostics).map(([k, v]) => [k.replace(/_/g, ' '), <span key={k} className="break-all">{Array.isArray(v) ? v.join(', ') : String(v)}</span>])} /></div>
            </Card>
          ) : null}
          <SupportAccessCard ctx={ctx} ticketId={data.id} onRequest={() => setDialog('access')} canRequest={!!data.workspace} />
          <AiAssistCard path={path} onInsert={(t) => insert(t, 'reply')} onCategory={(c) => void patch({ category: c }, 'Category updated')} />
          {data.problem_reports.length || data.duplicates.length || ctx.other_open_tickets.length ? (
            <Card>
              <CardHeader title="Related" />
              <ul className="flex flex-col gap-2 px-4 pb-4 text-[13px]">
                {data.problem_reports.map((r) => <li key={r.id}><Badge>Problem report</Badge> <span className="text-muted"><Ago at={r.created_at} /></span><p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words">{r.summary}</p></li>)}
                {data.duplicates.map((d) => <li key={d.id}><Link className="hover:underline" href={`/admin/platform/support/${d.reference}`}>{d.reference}</Link> · {d.subject} <span className="text-xs text-muted">({d.id === data.duplicate_of ? 'original' : 'duplicate'})</span></li>)}
                {ctx.other_open_tickets.map((t) => <li key={t.id}><Link className="hover:underline" href={`/admin/platform/support/${t.reference}`}>{t.reference}</Link> · <span className="text-muted">{t.subject}</span></li>)}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
      <ResolveDialog open={dialog === 'resolve'} onOpenChange={(o) => !o && setDialog(null)} onResolve={(reason) => api.patch<StaffTicketDetail>(path, { status: 'resolved', resolution_reason: reason }).then(setData)} />
      <DuplicateDialog open={dialog === 'duplicate'} onOpenChange={(o) => !o && setDialog(null)} onSubmit={(of) => api.post<StaffTicketDetail>(`${path}/duplicate`, { of }).then(setData)} />
      <AccessDialog open={dialog === 'access'} onOpenChange={(o) => !o && setDialog(null)} workspace={data.workspace?.name ?? ''} reference={data.reference}
        onSubmit={(b) => api.post<StaffTicketDetail>(`${path}/access`, b).then((d) => { setData(d); toast.success('Requested — the workspace owner decides'); })} />
    </>
  );
}

function SupportAccessCard({ ctx, ticketId, onRequest, canRequest }: { ctx: StaffTicketDetail['context']; ticketId: string; onRequest: () => void; canRequest: boolean }) {
  const open = ctx.support_access.filter((g) => g.status === 'requested' || g.status === 'active');
  return (
    <Card>
      <CardHeader title="Support access" actions={canRequest && !open.length ? <Button size="sm" variant="ghost" icon={<KeyRound aria-hidden className="size-4" />} onClick={onRequest}>Request</Button> : null} />
      <ul className="flex flex-col gap-1.5 px-4 pb-4 text-[13px]">
        {!ctx.support_access.length ? <li className="text-muted">None. Ticket access does not include workspace access.</li> : ctx.support_access.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center gap-2">
            <Badge tone={g.status === 'active' ? 'warn' : g.status === 'requested' ? 'info' : 'neutral'}>{g.status}</Badge>
            <span className="min-w-0 flex-1 truncate">{g.operator}{g.support_ticket_id === ticketId ? ' · this ticket' : ''}</span>
            <span className="text-xs text-muted">{g.status === 'active' ? <>ends <Ago at={g.expires_at} /></> : g.status === 'requested' ? <>lapses <Ago at={g.request_expires_at} /></> : null}</span>
          </li>
        ))}
        {open.some((g) => g.status === 'active') ? <li><Link href="/admin/platform/support/access" className="text-xs font-medium text-accent-text hover:underline">Manage my access</Link></li> : null}
      </ul>
    </Card>
  );
}

const AI_TASKS: Array<{ task: SupportAiTask; label: string }> = [
  { task: 'summarize', label: 'Summarize' }, { task: 'draft_reply', label: 'Draft reply' }, { task: 'suggest_category', label: 'Suggest category' }, { task: 'related', label: 'Related' },
];

function AiAssistCard({ path, onInsert, onCategory }: { path: string; onInsert: (t: string) => void; onCategory: (c: SupportTicketCategory) => void }) {
  const { data, refetch } = useApi<{ items: SupportAiDraftDto[] }>(`${path}/ai`);
  const [busy, setBusy] = useState<SupportAiTask | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const latest = (t: SupportAiTask) => data?.items.find((i) => i.task === t);
  const go = async (task: SupportAiTask) => { setBusy(task); setErr(null); try { await api.post(`${path}/ai`, { task }); await refetch(); } catch (e) { setErr(e); } finally { setBusy(null); } };
  const shown = AI_TASKS.map((t) => latest(t.task)).filter((x): x is SupportAiDraftDto => !!x);
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-1.5"><Sparkles aria-hidden className="size-4 text-accent-text" />Assist</span>} />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex flex-wrap gap-1.5">
          {AI_TASKS.map((t) => <Button key={t.task} size="sm" loading={busy === t.task} onClick={() => void go(t.task)}>{t.label}</Button>)}
        </div>
        {err ? <ErrorNotice error={err} /> : null}
        {shown.map((d) => (
          <div key={d.id} className="rounded-lg border border-dashed border-border p-3 text-[13px]" data-testid={`ai-${d.task}`}>
            <p className="mb-1 text-xs font-medium text-muted">{AI_TASKS.find((t) => t.task === d.task)?.label} · draft</p>
            {d.state !== 'succeeded' ? <p className="text-muted">{d.message}</p> : <>
              {d.summary ? <p className="whitespace-pre-wrap break-words">{d.summary}</p> : null}
              {d.draft ? <><p className="mt-2 whitespace-pre-wrap break-words rounded bg-sunken p-2">{d.draft}</p><Button size="sm" variant="ghost" className="mt-1" onClick={() => onInsert(d.draft!)}>Use as reply draft</Button></> : null}
              {d.category ? <p className="flex flex-wrap items-center gap-2">{SUPPORT_CATEGORY_LABEL[d.category]}<Button size="sm" variant="ghost" onClick={() => onCategory(d.category!)}>Apply</Button></p> : null}
              {d.related.length ? <ul className="mt-1 flex flex-col gap-1">{d.related.map((r) => <li key={r.id}><Link className="hover:underline" href={`/admin/platform/support/${r.reference}`}>{r.reference}</Link> · {r.subject}</li>)}</ul> : null}
              {d.knowledge.length ? <p className="mt-1 text-xs text-muted">Saved replies: {d.knowledge.map((k) => k.title).join(', ')}</p> : null}
              {d.message ? <p className="mt-1 text-xs text-muted">{d.message}</p> : null}
            </>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function ResolveDialog({ open, onOpenChange, onResolve }: { open: boolean; onOpenChange: (o: boolean) => void; onResolve: (r: SupportResolutionReason) => Promise<unknown> }) {
  const [reason, setReason] = useState<SupportResolutionReason>('answered');
  return (
    <ConfirmDialog open={open} onOpenChange={onOpenChange} title="Resolve ticket" confirmLabel="Resolve" onConfirm={() => onResolve(reason)}>
      <Field label="Resolution">
        <Select value={reason} onChange={(e) => setReason(e.target.value as SupportResolutionReason)}>
          {SUPPORT_RESOLUTION_REASONS.filter((r) => r !== 'customer_resolved' && r !== 'duplicate').map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
        </Select>
      </Field>
    </ConfirmDialog>
  );
}

function DuplicateDialog({ open, onOpenChange, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; onSubmit: (of: string) => Promise<unknown> }) {
  const [of, setOf] = useState('');
  return (
    <ConfirmDialog open={open} onOpenChange={onOpenChange} title="Mark as duplicate" confirmLabel="Mark duplicate" confirmDisabledReason={!/^RLY-\d{5,10}$/i.test(of.trim()) ? 'Enter a reference like RLY-123456' : null}
      description="Links the tickets and resolves this one. The customer sees “Resolved · duplicate”." onConfirm={() => onSubmit(of.trim().toUpperCase())}>
      <Field label="Original ticket"><Input value={of} onChange={(e) => setOf(e.target.value)} placeholder="RLY-123456" autoCapitalize="characters" /></Field>
    </ConfirmDialog>
  );
}

function AccessDialog({ open, onOpenChange, workspace, reference, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; workspace: string; reference: string; onSubmit: (b: { reason: string; duration_minutes: number }) => Promise<unknown> }) {
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(60);
  return (
    <ConfirmDialog open={open} onOpenChange={onOpenChange} title={`Request access to ${workspace}`} confirmLabel="Send request" confirmDisabledReason={reason.trim().length < 10 ? 'Give a reason (10+ characters)' : null}
      description="Read-only, whole workspace. An owner or admin must approve; it ends on its own." onConfirm={() => onSubmit({ reason: reason.trim(), duration_minutes: minutes })}>
      <div className="flex flex-col gap-3">
        <Field label="Reason"><Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`For ${reference}: …`} /></Field>
        <Field label="Duration">
          <Select value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[30, 60, 120, 240, 480, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>)}
          </Select>
        </Field>
      </div>
    </ConfirmDialog>
  );
}
