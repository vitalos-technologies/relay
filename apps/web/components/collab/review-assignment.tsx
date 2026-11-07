'use client';
import { useState } from 'react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { toLocalInput } from '@social-lite/core';
import { ErrorNotice, Field, Input, Select, useToast } from '@/components/ui';
import { wallToIso } from './conflict-copy';

/** Reviewer assignee + review due date. Only people who can approve on the brand are offered (server re-checks). */
export function ReviewAssignment({ approvalId, brandId, assignee, dueAt, tz, onSaved }: {
  approvalId: string; brandId: string; assignee: { id: string; email: string } | null; dueAt: string | null; tz: string; onSaved: () => unknown;
}) {
  const toast = useToast();
  const opts = useApi<{ people: Array<{ id: string; email: string; name: string | null; can_review: boolean }> }>(`/api/brands/${brandId}/assignment-options`);
  const [err, setErr] = useState<unknown>(null);
  const save = async (body: Record<string, unknown>) => {
    setErr(null);
    try { await api.post(`/api/approvals/${approvalId}/assignment`, body); toast.success('Saved'); await onSaved(); } catch (e) { setErr(e); }
  };
  return (
    <div className="flex flex-col gap-3">
      <Field label="Reviewer">
        <Select value={assignee?.id ?? ''} onChange={(e) => void save({ assignee_user_id: e.target.value || null })}>
          <option value="">Unassigned</option>
          {assignee && !(opts.data?.people ?? []).some((p) => p.id === assignee.id) ? <option value={assignee.id}>{assignee.email}</option> : null}
          {(opts.data?.people ?? []).filter((p) => p.can_review).map((p) => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
        </Select>
      </Field>
      <Field label={`Review by (${tz})`}>
        <Input type="datetime-local" value={dueAt ? toLocalInput(new Date(dueAt), tz) : ''} onChange={(e) => void save({ due_at: wallToIso(e.target.value, tz) })} />
      </Field>
      {err ? <ErrorNotice error={err} /> : null}
    </div>
  );
}
