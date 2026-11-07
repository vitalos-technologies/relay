'use client';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { toLocalInput } from '@social-lite/core';
import { Button, ErrorNotice, Field, Input, Select, Skeleton, useToast } from '@/components/ui';
import { wallToIso } from './conflict-copy';
import type { PlanningDto } from './types';

interface Options { people: Array<{ id: string; email: string; name: string | null }>; teams: Array<{ id: string; name: string }> }
interface Campaigns { items: Array<{ id: string; name: string; archived: boolean }>; can_manage: boolean }

/** Campaign (0..1), assignee (entitled to the brand), due date and owning team. Saved immediately; never changes content. */
export function PlanningPanel({ postId, brandId, tz }: { postId: string; brandId: string; tz: string }) {
  const toast = useToast();
  const plan = useApi<PlanningDto>(`/api/posts/${postId}/planning`);
  const opts = useApi<Options>(`/api/brands/${brandId}/assignment-options`);
  const camps = useApi<Campaigns>(`/api/brands/${brandId}/campaigns`);
  const [err, setErr] = useState<unknown>(null);
  const [newCamp, setNewCamp] = useState('');
  if (plan.error && !plan.data) return <ErrorNotice error={plan.error} />;
  if (!plan.data) return <Skeleton className="h-40 w-full rounded-lg" />;
  const p = plan.data;
  const ro = !p.can_edit;
  const patch = async (body: Record<string, unknown>) => {
    setErr(null);
    try { plan.setData(await api.patch<PlanningDto>(`/api/posts/${postId}/planning`, body)); toast.success('Saved'); } catch (e) { setErr(e); }
  };
  const addCampaign = async () => {
    setErr(null);
    try {
      const c = await api.post<{ id: string }>(`/api/brands/${brandId}/campaigns`, { name: newCamp.trim() });
      setNewCamp(''); await camps.refetch(); await patch({ campaign_id: c.id });
    } catch (e) { setErr(e); }
  };
  return (
    <div className="flex flex-col gap-4">
      <Field label="Campaign">
        <Select value={p.campaign?.id ?? ''} disabled={ro} onChange={(e) => void patch({ campaign_id: e.target.value || null })}>
          <option value="">None</option>
          {(camps.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      {!ro && camps.data?.can_manage ? (
        <div className="flex gap-2">
          <label htmlFor={`nc-${postId}`} className="sr-only">New campaign name</label>
          <Input id={`nc-${postId}`} value={newCamp} onChange={(e) => setNewCamp(e.target.value)} placeholder="New campaign" maxLength={120} />
          <Button size="sm" icon={<Plus aria-hidden className="size-4" />} onClick={addCampaign} disabledReason={!newCamp.trim() ? 'Name it first.' : null}><span className="sr-only">Add campaign</span></Button>
        </div>
      ) : null}
      <Field label="Assignee" info="Only people with access to this brand.">
        <Select value={p.assignee?.id ?? ''} disabled={ro} onChange={(e) => void patch({ assignee_user_id: e.target.value || null })}>
          <option value="">Unassigned</option>
          {(opts.data?.people ?? []).map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
        </Select>
      </Field>
      <Field label={`Due (${tz})`}>
        <Input type="datetime-local" disabled={ro} value={p.due_at ? toLocalInput(new Date(p.due_at), tz) : ''}
          onChange={(e) => void patch({ due_at: wallToIso(e.target.value, tz) })} />
      </Field>
      <Field label="Team">
        <Select value={p.team?.id ?? ''} disabled={ro} onChange={(e) => void patch({ team_id: e.target.value || null })}>
          <option value="">No team</option>
          {(opts.data?.teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </Field>
      {err ? <ErrorNotice error={err} /> : null}
    </div>
  );
}
