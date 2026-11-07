'use client';
// Admin → Collaboration settings: client discussion access, who may assign tasks, offboarding, reminders, presence,
// default notification channels for members who haven't chosen, and eligible reviewers per brand (from the approval policy).
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Button, Card, CardHeader, ErrorState, Field, Input, PageHeader, Select, SkeletonRows, Switch, useToast } from '@/components/ui';

interface Settings {
  client_comments: boolean; task_assign: 'contributors' | 'managers'; offboarding: 'flag' | 'unassign'; reminder_lead_hours: number; max_overdue_reminders: number;
  presence_enabled: boolean; notification_defaults: Record<string, { in_app?: boolean; email?: boolean; digest?: boolean }>; can_manage: boolean;
}
const EVENTS: Array<[string, string]> = [['mention', 'Mentions'], ['comment', 'Replies and client comments'], ['review_requested', 'Review requests'], ['review_decided', 'Review decisions'], ['assignment', 'Tasks and assignments'], ['reminder', 'Deadline reminders']];

export default function CollaborationSettingsPage() {
  const toast = useToast();
  const { session } = useSession();
  const { data, error, loading, refetch } = useApi<Settings>('/api/collaboration/settings');
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setForm(data); }, [data]);
  const [brand, setBrand] = useState(session.brands[0]?.id ?? '');
  const reviewers = useApi<{ separation_of_duties: boolean; stages: Array<{ position: number; name: string; quorum: number; allow_guests: boolean; people: Array<{ id: string; name: string | null; email: string }> }> }>(brand ? `/api/admin/collaboration/reviewers?brand_id=${brand}` : null);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const ro = !data?.can_manage;
  return (
    <>
      <PageHeader title="Collaboration settings" />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !form ? <SkeletonRows rows={8} /> : (
        <div className="flex max-w-3xl flex-col gap-6">
          <Card aria-labelledby="h-gen">
            <CardHeader id="h-gen" title="Discussions and tasks" />
            <div className="flex flex-col gap-4 px-4 pb-4">
              <Switch label="Clients can comment on shared reviews" checked={form.client_comments} onCheckedChange={(v) => set('client_comments', v)} disabled={ro} />
              <Switch label="Show who’s viewing or editing a post" checked={form.presence_enabled} onCheckedChange={(v) => set('presence_enabled', v)} disabled={ro} />
              <Field label="Who can assign tasks to others"><Select value={form.task_assign} onChange={(e) => set('task_assign', e.target.value as Settings['task_assign'])} disabled={ro}>
                <option value="contributors">Anyone who edits, submits or reviews</option><option value="managers">Brand managers and admins only</option></Select></Field>
              <Field label="When someone loses access" info="Applies to their open tasks. Reviews and post owners are listed on Reassign work.">
                <Select value={form.offboarding} onChange={(e) => set('offboarding', e.target.value as Settings['offboarding'])} disabled={ro}>
                  <option value="flag">Keep the assignee, flag for reassignment</option><option value="unassign">Unassign and flag for reassignment</option></Select></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Remind before a deadline (hours)"><Input type="number" min={1} max={168} value={form.reminder_lead_hours} onChange={(e) => set('reminder_lead_hours', Number(e.target.value))} disabled={ro} /></Field>
                <Field label="Overdue reminders (max)"><Input type="number" min={0} max={10} value={form.max_overdue_reminders} onChange={(e) => set('max_overdue_reminders', Number(e.target.value))} disabled={ro} /></Field>
              </div>
            </div>
          </Card>
          <Card aria-labelledby="h-def">
            <CardHeader id="h-def" title="Notification defaults" />
            <div className="overflow-x-auto px-4 pb-4">
              <p className="mb-2 text-xs text-muted">For members who haven’t changed their own settings. Quiet hours are personal.</p>
              <table className="w-full text-[13px]">
                <thead><tr className="text-left text-xs text-muted"><th className="py-2 font-medium">Type</th><th className="py-2 font-medium">In app</th><th className="py-2 font-medium">Email</th></tr></thead>
                <tbody>
                  {EVENTS.map(([k, label]) => {
                    const v = form.notification_defaults[k] ?? {};
                    const upd = (patch: Record<string, boolean>) => set('notification_defaults', { ...form.notification_defaults, [k]: { in_app: v.in_app ?? true, email: v.email ?? (k !== 'comment' && k !== 'review_decided' && k !== 'reminder'), ...patch } });
                    return (
                      <tr key={k} className="border-t border-border">
                        <th scope="row" className="py-2 text-left font-normal">{label}</th>
                        <td><input type="checkbox" aria-label={`${label}: in app`} className="size-[18px] accent-[var(--text)]" checked={v.in_app ?? true} disabled={ro} onChange={(e) => upd({ in_app: e.target.checked })} /></td>
                        <td><input type="checkbox" aria-label={`${label}: email`} className="size-[18px] accent-[var(--text)]" checked={v.email ?? (k !== 'comment' && k !== 'review_decided' && k !== 'reminder')} disabled={ro} onChange={(e) => upd({ email: e.target.checked })} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          {!ro ? (
            <Button variant="primary" className="self-start" loading={busy} onClick={async () => {
              setBusy(true);
              try { const { can_manage: _c, ...body } = form; await api.put('/api/collaboration/settings', body); toast.success('Saved'); await refetch(); }
              catch (e) { toast.error(e, 'Couldn’t save'); } finally { setBusy(false); }
            }}>Save</Button>
          ) : null}
          <Card aria-labelledby="reviewers" id="reviewers">
            <CardHeader id="reviewers-h" title="Eligible reviewers" actions={<a className="text-[13px] text-[var(--accent-text)]" href="/admin/settings/publishing/approvals">Approval policy</a>} />
            <div className="flex flex-col gap-3 px-4 pb-4">
              <Field label="Brand"><Select value={brand} onChange={(e) => setBrand(e.target.value)}>{session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
              {reviewers.data ? (reviewers.data.stages.length ? reviewers.data.stages.map((s) => (
                <div key={s.position}>
                  <p className="text-[13px] font-medium">{s.name} · {s.quorum} needed{s.allow_guests ? ' · clients allowed' : ''}</p>
                  <p className="text-xs text-muted">{s.people.map((p) => p.name || p.email).join(', ') || 'Nobody is eligible yet'}</p>
                </div>
              )) : <p className="text-[13px] text-muted">No review required for this brand</p>) : <SkeletonRows rows={2} />}
              {reviewers.data?.separation_of_duties ? <p className="text-xs text-muted">Authors can’t approve their own posts.</p> : null}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
