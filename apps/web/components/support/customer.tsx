'use client';
// Help → Contact support / My requests (V4 SUP). Talks to Relay staff — never to the workspace's social audience.
// Everything shown comes from /api/support/** which only returns public messages (no internal notes, no staff names).
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, Download, Inbox, LifeBuoy, Lock, MessageSquarePlus, RotateCcw, Search, ShieldCheck, UserPlus } from 'lucide-react';
import {
  RESTRICTED_SUPPORT_CATEGORIES, SUPPORT_CATEGORY_LABEL, SUPPORT_TICKET_CATEGORIES, type CustomerTicketDetail, type CustomerTicketsResponse, type SupportTicketCategory,
  type SupportTicketStatus,
} from '@social-lite/core/contracts/v4-support';
import { api, recentCorrelationIds } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { ConversationComposer } from '@/components/conversation/composer';
import { ConversationTimeline, type TimelineEntryView } from '@/components/conversation/timeline';
import {
  Badge, Banner, Button, Card, CardHeader, Checkbox, ConfirmDialog, EmptyState, ErrorNotice, ErrorState, Facts, Field, Input, LinkButton, PageHeader, Select, SkeletonRows,
  Textarea, cn, useToast,
} from '@/components/ui';
import { AttachmentLinks, AttachmentPicker, useAttachments } from './attachments';

export const CUSTOMER_STATUS: Record<SupportTicketStatus, { label: string; tone: 'info' | 'warn' | 'success' | 'neutral' | 'accent' }> = {
  new: { label: 'Received', tone: 'info' },
  waiting_on_relay: { label: 'With Relay', tone: 'info' },
  waiting_on_customer: { label: 'Awaiting your reply', tone: 'warn' },
  resolved: { label: 'Resolved', tone: 'success' },
  archived: { label: 'Closed', tone: 'neutral' },
};

const ago = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
};

// ------------------------------------------------------------------ shell (left sub-navigation)
const HELP_NAV = [
  { href: '/help/contact', label: 'Contact support', icon: MessageSquarePlus },
  { href: '/help/requests', label: 'My requests', icon: Inbox },
];

export function HelpShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  return (
    <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10">
      <aside aria-label="Help" className="hidden lg:block">
        <div className="sticky top-[88px]">
          <p className="mb-3 text-[13px] font-semibold text-muted">Help</p>
          <ul className="flex flex-col gap-0.5">
            {HELP_NAV.map((n) => {
              const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
              return (
                <li key={n.href}>
                  <Link href={n.href} aria-current={active ? 'page' : undefined}
                    className={cn('group flex h-9 items-center gap-2.5 rounded-lg px-2 text-[13px] font-medium', active ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg')}>
                    <n.icon aria-hidden strokeWidth={1.75} className={cn('size-4', active ? 'text-accent-text' : 'text-subtle')} />{n.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
      <div className="min-w-0">
        <nav aria-label="Help" className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 lg:hidden">
          {HELP_NAV.map((n) => {
            const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
            return (
              <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined}
                className={cn('touch-target inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-[13px] font-medium', active ? 'border-[var(--accent)] bg-accent-soft text-fg' : 'border-border text-muted')}>
                <n.icon aria-hidden className="size-4" />{n.label}
              </Link>
            );
          })}
        </nav>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ contact form
function browserFamilyGuess(): string | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  if (/SamsungBrowser/i.test(ua)) return 'samsung';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

export function ContactSupportForm({ initialCategory }: { initialCategory?: SupportTicketCategory | null }) {
  const router = useRouter();
  const toast = useToast();
  const files = useAttachments('/api/support/attachments');
  const notes = useApi<{ current_version: string }>('/api/release-notes');
  const [category, setCategory] = useState<SupportTicketCategory | ''>(initialCategory ?? '');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [withTech, setWithTech] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const refs = useMemo(() => recentCorrelationIds().slice(0, 5), []);
  const restricted = !!category && RESTRICTED_SUPPORT_CATEGORIES.includes(category);
  const tech = { app_version: notes.data?.current_version ?? null, route: typeof document !== 'undefined' && document.referrer ? new URL(document.referrer).pathname : null,
    occurred_at: new Date().toISOString(), browser_family: browserFamilyGuess(), correlation_ids: refs.map((r) => r.id) };
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const t = await api.post<CustomerTicketDetail>('/api/support/requests', {
        category, subject: subject.trim(), message: message.trim(), attachment_ids: files.readyIds, diagnostics: withTech ? tech : null,
      }, { idempotent: true });
      toast.success(`Sent · ${t.reference}`);
      router.push(`/help/requests/${t.reference}`);
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Contact support" />
      <Card className="max-w-2xl p-4 sm:p-6">
        <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value as SupportTicketCategory)} required data-testid="support-category">
              <option value="" disabled>Choose…</option>
              {SUPPORT_TICKET_CATEGORIES.map((c) => <option key={c} value={c}>{SUPPORT_CATEGORY_LABEL[c]}</option>)}
            </Select>
          </Field>
          {restricted ? <Banner tone="info" icon={<Lock aria-hidden className="size-4" />}>Only you and people you add can see this request.</Banner> : null}
          <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} required /></Field>
          <Field label="Message"><Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={6} maxLength={10000} required /></Field>
          <AttachmentPicker state={files} label="Attach screenshot or file" />
          <Checkbox label="Include technical details" checked={withTech} onChange={(e) => setWithTech(e.target.checked)}
            description={[tech.app_version ? `Version ${tech.app_version}` : null, tech.browser_family ? `Browser: ${tech.browser_family}` : null, refs.length ? `${refs.length} error reference${refs.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || 'App version and browser'} />
          {err ? <ErrorNotice error={err} /> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="submit" variant="primary" loading={busy}
              disabledReason={!category ? 'Choose a category' : !subject.trim() ? 'Add a subject' : !message.trim() ? 'Write a message' : files.busy ? 'Files are still being checked' : null}>Send</Button>
          </div>
        </form>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ my requests
export function MyRequests() {
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [scope, setScope] = useState<'mine' | 'workspace'>('mine');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const path = `/api/support/requests?${new URLSearchParams({ status, scope, ...(query ? { q: query } : {}) }).toString()}`;
  const { data, error, loading, refetch } = useApi<CustomerTicketsResponse>(path, { poll: 30_000, keepPrevious: true });
  return (
    <>
      <PageHeader title="My requests" actions={<LinkButton href="/help/contact" variant="primary" icon={<MessageSquarePlus aria-hidden className="size-4" />}>New request</LinkButton>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Status" className="inline-flex rounded-lg border border-border bg-sunken p-0.5">
          {(['open', 'resolved', 'all'] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={status === s} onClick={() => setStatus(s)}
              className={cn('touch-target h-8 rounded-md px-3 text-[13px] font-medium', status === s ? 'bg-surface text-fg shadow-sm' : 'text-muted')}>{s === 'open' ? 'Open' : s === 'resolved' ? 'Resolved' : 'All'}</button>
          ))}
        </div>
        {data?.can_see_workspace ? (
          <Select aria-label="Whose requests" value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'workspace')} className="h-9 w-auto">
            <option value="mine">Mine</option><option value="workspace">Whole workspace</option>
          </Select>
        ) : null}
        <div className="relative min-w-0 flex-1 basis-[200px]">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input type="search" aria-label="Search requests" placeholder="Search or RLY-…" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 pl-8" />
        </div>
      </div>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading && !data ? <SkeletonRows rows={4} /> : !data?.items.length ? (
        <EmptyState icon={<LifeBuoy aria-hidden />} title={query ? 'No matches' : status === 'open' ? 'No open requests' : 'No requests'} action={<LinkButton href="/help/contact" size="sm">Contact support</LinkButton>} />
      ) : (
        <Card as="div" className="overflow-hidden">
          <ul className="divide-y divide-border" data-testid="support-requests">
            {data.items.map((t) => (
              <li key={t.id}>
                <Link href={`/help/requests/${t.reference}`} className="flex min-h-[64px] items-start gap-3 px-4 py-3 hover:bg-raised/50">
                  <span aria-hidden className={cn('mt-2 size-2 shrink-0 rounded-full', t.unread ? 'bg-accent' : 'bg-transparent')} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cn('truncate text-[14px]', t.unread ? 'font-semibold' : 'font-medium')}>{t.subject}</span>
                      {t.restricted ? <Lock aria-label="Private" className="size-3.5 shrink-0 text-subtle" /> : null}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {t.reference} · {SUPPORT_CATEGORY_LABEL[t.category]}{!t.requester.mine && t.requester.name ? ` · ${t.requester.name}` : ''} · {ago(t.updated_at)}
                    </span>
                  </span>
                  <Badge tone={CUSTOMER_STATUS[t.status].tone} className="shrink-0">{CUSTOMER_STATUS[t.status].label}</Badge>
                  {t.unread ? <span className="sr-only">New reply</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

// ------------------------------------------------------------------ one request
export function RequestThread({ reference }: { reference: string }) {
  const toast = useToast();
  const { refresh: refreshSession } = useSession();
  const { data, error, loading, refetch, setData } = useApi<CustomerTicketDetail>(`/api/support/requests/${encodeURIComponent(reference)}`);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [deciding, setDeciding] = useState<{ id: string; decision: 'approve' | 'decline'; minutes: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const files = useAttachments('/api/support/attachments');
  const cursor = useRef(0);
  useEffect(() => { if (data) cursor.current = Math.max(cursor.current, data.cursor); }, [data]);
  // Change feed: content-free ids; on any new event refetch through the authorized API.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop || document.hidden || !cursor.current) return;
      try {
        const r = await api.get<{ items: Array<{ id: number }>; cursor: number }>(`/api/support/requests/${encodeURIComponent(reference)}/events`, { after: cursor.current });
        if (r.items.length) { cursor.current = r.cursor; await refetch(); }
      } catch { /* keep showing the last data */ }
    };
    const t = setInterval(() => void tick(), 5000);
    return () => { stop = true; clearInterval(t); };
  }, [reference, refetch]);

  if (error && !data) return <ErrorState error={error} onRetry={refetch} title={error.status === 404 ? 'Request not found' : undefined} />;
  if (loading || !data) return <SkeletonRows rows={5} />;
  const act = async (name: string, fn: () => Promise<CustomerTicketDetail>, msg: string) => {
    setBusy(name); setErr(null);
    try { setData(await fn()); toast.success(msg); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const entries: TimelineEntryView[] = [
    ...data.messages.map((m) => ({ key: m.id, kind: 'message' as const, side: m.author.kind === 'staff' ? 'them' as const : 'us' as const, author: m.author.mine ? 'You' : m.author.name, body: m.body, at: m.created_at,
      attachments: m.attachments.length ? [<AttachmentLinks key="a" files={m.attachments} />] : undefined })),
    ...data.activity.filter((a) => a.kind !== 'ticket.created').map((a) => ({ key: `a${a.id}`, kind: 'system' as const, text: a.text, at: a.at })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const st = CUSTOMER_STATUS[data.status];
  const pendingAccess = data.support_access.filter((g) => g.status === 'requested' || g.status === 'active');
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/help/requests" className="hover:underline">My requests</Link>}
        title={data.subject}
        meta={<><Badge tone={st.tone}>{st.label}</Badge><span className="text-xs text-muted">{data.reference}</span>{data.restricted ? <Badge icon={<Lock aria-hidden className="size-3" />}>Private</Badge> : null}</>}
        actions={<a href={`/api/support/requests/${data.reference}/transcript`} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted hover:bg-raised hover:text-fg"><Download aria-hidden className="size-4" />Transcript</a>}
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          {pendingAccess.map((g) => (
            <Banner key={g.id} tone={g.status === 'active' ? 'warn' : 'info'} icon={<ShieldCheck aria-hidden className="size-4" />}>
              <span className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">{g.status === 'active' ? `Relay support has read-only access until ${new Date(g.expires_at!).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}` : `Relay support asked for read-only access (${g.duration_minutes} min): ${g.reason}`}</span>
                {data.can.decide_access ? (g.status === 'requested' ? <>
                  <Button size="sm" onClick={() => setDeciding({ id: g.id, decision: 'decline', minutes: g.duration_minutes })}>Decline</Button>
                  <Button size="sm" variant="primary" onClick={() => setDeciding({ id: g.id, decision: 'approve', minutes: g.duration_minutes })}>Approve</Button>
                </> : <Button size="sm" variant="danger" onClick={async () => { try { await api.post(`/api/admin/support-access/${g.id}/end`, {}); toast.success('Access ended'); await refetch(); await refreshSession(); } catch (e) { toast.error(e, 'Not ended'); } }}>End access</Button>) : null}
              </span>
            </Banner>
          ))}
          <Card className="p-4">
            <ConversationTimeline entries={entries} />
          </Card>
          {err ? <ErrorNotice error={err} /> : null}
          {data.can.reply ? (
            <div className="z-10 md:sticky md:bottom-0 md:-mx-1 md:bg-[var(--bg)] md:px-1 md:pb-4 md:pt-2">
              <ConversationComposer modes={[{ value: 'reply', label: 'Reply', audience: 'private' }]} mode="reply" onModeChange={() => undefined}
                body={body} onBodyChange={setBody} busy={busy === 'reply'} maxLength={10000} placeholder={data.status === 'resolved' ? 'Reply to reopen this request…' : 'Write a reply…'}
                audienceText={{ private: 'Sent to Relay support' }} submitDisabledReason={files.busy ? 'Files are still being checked' : null}
                below={<AttachmentPicker state={files} compact />}
                onSubmit={() => void act('reply', async () => { const r = await api.post<CustomerTicketDetail>(`/api/support/requests/${data.reference}/messages`, { body: body.trim(), attachment_ids: files.readyIds }, { idempotent: true }); setBody(''); files.clear(); return r; }, 'Sent')} />
            </div>
          ) : <p className="text-[13px] text-muted">This request is closed. <Link href="/help/contact" className="font-medium text-accent-text hover:underline">Start a new request</Link></p>}
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <Card className="p-4">
            <Facts items={[
              ['Reference', data.reference],
              ['Category', SUPPORT_CATEGORY_LABEL[data.category]],
              ['Opened', new Date(data.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })],
              ['Requested by', data.requester.mine ? 'You' : data.requester.name ?? '—'],
              ...(data.problem_report ? [['From', 'Problem report'] as [string, string]] : []),
            ]} />
            <div className="mt-4 flex flex-wrap gap-2">
              {data.can.resolve ? <Button size="sm" icon={<CircleCheck aria-hidden className="size-4" />} loading={busy === 'resolve'} onClick={() => void act('resolve', () => api.post(`/api/support/requests/${data.reference}/resolve`, {}), 'Marked resolved')}>Mark resolved</Button> : null}
              {data.can.reopen ? <Button size="sm" icon={<RotateCcw aria-hidden className="size-4" />} loading={busy === 'reopen'} onClick={() => void act('reopen', () => api.post(`/api/support/requests/${data.reference}/reopen`, {}), 'Reopened')}>Reopen</Button> : null}
            </div>
          </Card>
          <Card>
            <CardHeader title="People" actions={data.can.add_participants ? <Button size="sm" variant="ghost" icon={<UserPlus aria-hidden className="size-4" />} onClick={() => setAdding(true)}>Add</Button> : null} />
            <ul className="flex flex-col gap-1 px-4 pb-4 text-[13px]">
              <li>{data.requester.mine ? 'You' : data.requester.name} <span className="text-xs text-muted">· requester</span></li>
              {data.participants.map((p) => <li key={p.id} className="truncate">{p.name || p.email}</li>)}
            </ul>
          </Card>
        </aside>
      </div>
      <ConfirmDialog open={!!deciding} onOpenChange={(o) => !o && setDeciding(null)}
        title={deciding?.decision === 'approve' ? `Give Relay support read-only access for ${deciding.minutes} minutes?` : 'Decline this request?'}
        description={deciding?.decision === 'approve' ? 'They can read posts, media and settings in this workspace until it ends. They can’t change, approve or publish anything. You can end it any time.' : undefined}
        confirmLabel={deciding?.decision === 'approve' ? 'Approve' : 'Decline'} confirmVariant={deciding?.decision === 'approve' ? 'primary' : 'danger'}
        onConfirm={async () => { if (!deciding) return; await api.post(`/api/admin/support-access/${deciding.id}/decision`, { decision: deciding.decision, note: null }); toast.success(deciding.decision === 'approve' ? 'Access granted' : 'Declined'); await refetch(); await refreshSession(); }} />
      <AddParticipantDialog open={adding} onOpenChange={setAdding} reference={data.reference} exclude={[data.requester.id, ...data.participants.map((p) => p.id)].filter((x): x is string => !!x)} onAdded={setData} />
    </>
  );
}

function AddParticipantDialog({ open, onOpenChange, reference, exclude, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; reference: string; exclude: string[]; onAdded: (d: CustomerTicketDetail) => void }) {
  const { data } = useApi<{ items: Array<{ id: string; name: string | null; email: string }> }>(open ? '/api/support/participants' : null);
  const [who, setWho] = useState('');
  const options = (data?.items ?? []).filter((m) => !exclude.includes(m.id));
  return (
    <ConfirmDialog open={open} onOpenChange={onOpenChange} title="Add someone to this request" confirmLabel="Add" confirmVariant="primary" confirmDisabledReason={!who ? 'Choose someone' : null}
      onConfirm={async () => { onAdded(await api.post<CustomerTicketDetail>(`/api/support/requests/${reference}/participants`, { user_id: who })); setWho(''); }}>
      <Field label="Person">
        <Select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Choose…</option>
          {options.map((m) => <option key={m.id} value={m.id}>{m.name ? `${m.name} (${m.email})` : m.email}</option>)}
        </Select>
      </Field>
    </ConfirmDialog>
  );
}
