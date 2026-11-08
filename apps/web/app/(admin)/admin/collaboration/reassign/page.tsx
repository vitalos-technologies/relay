'use client';
// Admin → Reassign work: open tasks, reviews and post assignments held by people who lost access (offboarding), and a
// one-step reassignment to someone who can see each brand (items they can't see are skipped and reported).
import { useState } from 'react';
import { UserRoundCog } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Button, Card, CardHeader, EmptyState, ErrorState, Field, PageHeader, Select, SkeletonRows, useToast } from '@/components/ui';
import { Ago } from '@/components/admin/ui';

interface Work {
  tasks: Array<{ id: string; title: string; brand: string; assignee_id: string | null; assignee: string | null; due_at: string | null; reason: string | null }>;
  reviews: Array<{ id: string; post_id: string; title: string | null; brand: string; assignee_id: string; assignee: string | null; due_at: string | null }>;
  posts: Array<{ id: string; title: string | null; brand: string; assignee_id: string; assignee: string | null; due_at: string | null }>;
}
interface Member { user_id: string; email: string; name: string | null; status?: string }

export default function ReassignPage() {
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<Work>('/api/admin/collaboration/reassign');
  const members = useApi<{ members: Member[] }>('/api/members?status=active');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const holders = new Map<string, string>();
  for (const x of [...(data?.tasks ?? []), ...(data?.reviews ?? []), ...(data?.posts ?? [])]) if (x.assignee_id) holders.set(x.assignee_id, x.assignee ?? 'Former member');
  const empty = data && !data.tasks.length && !data.reviews.length && !data.posts.length;
  return (
    <>
      <PageHeader title="Reassign work" />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={6} /> : (
        <div className="flex max-w-4xl flex-col gap-6">
          <Card aria-labelledby="h-move">
            <CardHeader id="h-move" title="Move open work" />
            <div className="grid grid-cols-1 gap-3 px-4 pb-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="From">
                <Select value={from} onChange={(e) => setFrom(e.target.value)}>
                  <option value="">Choose a person</option>
                  {[...holders.entries()].map(([id, n]) => <option key={id} value={id}>{n} (lost access)</option>)}
                  {(members.data?.members ?? []).filter((m) => !holders.has(m.user_id)).map((m) => <option key={m.user_id} value={m.user_id}>{m.name || m.email}</option>)}
                </Select>
              </Field>
              <Field label="To">
                <Select value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="">Unassign</option>
                  {(members.data?.members ?? []).filter((m) => m.user_id !== from).map((m) => <option key={m.user_id} value={m.user_id}>{m.name || m.email}</option>)}
                </Select>
              </Field>
              <Button variant="primary" icon={<UserRoundCog aria-hidden className="size-4" />} loading={busy} disabledReason={!from ? 'Choose who to move work from.' : null}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api.post<{ tasks: number; reviews: number; posts: number; skipped: number }>('/api/admin/collaboration/reassign', { from_user_id: from, to_user_id: to || null });
                    toast.success('Work moved', `${r.tasks} tasks · ${r.reviews} reviews · ${r.posts} posts${r.skipped ? ` · ${r.skipped} skipped (no access)` : ''}`);
                    await refetch();
                  } catch (e) { toast.error(e, 'Couldn’t move the work'); } finally { setBusy(false); }
                }}>Move</Button>
            </div>
          </Card>
          {empty ? <EmptyState icon={<UserRoundCog aria-hidden />} title="Nothing needs a new owner" /> : (
            <>
              <List title="Tasks" items={data.tasks.map((t) => ({ id: t.id, title: t.title, meta: `${t.brand} · ${t.assignee ?? 'Unassigned'}`, due: t.due_at, href: `/tasks?task=${t.id}&view=team` }))} />
              <List title="Reviews" items={data.reviews.map((r) => ({ id: r.id, title: r.title || 'Untitled post', meta: `${r.brand} · ${r.assignee ?? ''}`, due: r.due_at, href: `/admin/approvals/${r.id}` }))} />
              <List title="Post owners" items={data.posts.map((p) => ({ id: p.id, title: p.title || 'Untitled post', meta: `${p.brand} · ${p.assignee ?? ''}`, due: p.due_at, href: `/posts/${p.id}` }))} />
            </>
          )}
        </div>
      )}
    </>
  );
}

function List({ title, items }: { title: string; items: Array<{ id: string; title: string; meta: string; due: string | null; href: string }> }) {
  if (!items.length) return null;
  return (
    <Card aria-label={title}>
      <CardHeader title={`${title} (${items.length})`} />
      <ul className="flex flex-col px-2 pb-2">
        {items.map((i) => (
          <li key={i.id}><a href={i.href} className="flex flex-col gap-0.5 rounded-md px-2 py-2 hover:bg-raised"><span className="truncate text-[13px] font-medium">{i.title}</span><span className="text-xs text-muted">{i.meta}{i.due ? <> · due <Ago at={i.due} /></> : null}</span></a></li>
        ))}
      </ul>
    </Card>
  );
}
