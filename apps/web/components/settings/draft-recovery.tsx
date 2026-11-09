'use client';
// Settings → Workspace → Draft recovery: where unsaved composer copies may live in the browser (V3.1 §9).
// GET/PUT /api/workspace/data-policy (workspace.manage to change; audited server-side).
import { useEffect, useState } from 'react';
import type { DraftRecoveryPolicy, LocalRecoveryMode } from '@social-lite/core/contracts/v31-data';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Button, Card, ErrorNotice, ErrorState, Field, Input, MetaChip, RadioGroup, Skeleton, Switch, useToast } from '@/components/ui';

type Policy = DraftRecoveryPolicy & { can_manage: boolean };

const MODES: Array<{ value: LocalRecoveryMode; label: string; description: string }> = [
  { value: 'persistent', label: 'This browser', description: 'Survives a restart.' },
  { value: 'session', label: 'This tab only', description: 'Cleared when the tab closes.' },
  { value: 'off', label: 'Off', description: 'Nothing kept in the browser.' },
];

export function DraftRecoverySettings() {
  const toast = useToast();
  const { refresh } = useSession();
  const { data, error, loading, refetch, setData } = useApi<Policy>('/api/workspace/data-policy');
  const [f, setF] = useState<{ mode: LocalRecoveryMode; hours: string; clear: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (data) setF({ mode: data.local_recovery, hours: String(data.max_age_hours), clear: data.clear_on_logout }); }, [data]);
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data || !f) return <Skeleton className="h-64 w-full max-w-2xl rounded-xl" />;
  const hours = Number(f.hours);
  const badHours = !Number.isInteger(hours) || hours < 1 || hours > 720;
  const changed = f.mode !== data.local_recovery || hours !== data.max_age_hours || f.clear !== data.clear_on_logout;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const next = await api.put<DraftRecoveryPolicy>('/api/workspace/data-policy', { local_recovery: f.mode, max_age_hours: hours, clear_on_logout: f.clear });
      setData({ ...next, can_manage: data.can_manage });
      await refresh();
      toast.success('Saved');
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const ro = !data.can_manage;
  return (
    <Card className="max-w-2xl">
      <div className="flex flex-col gap-6 p-4">
        {ro ? <div className="-mb-2 flex justify-end"><MetaChip>View only</MetaChip></div> : null}
        <RadioGroup legend="Keep unsaved copies" name="local-recovery" value={f.mode} onChange={(v) => setF({ ...f, mode: v })} options={MODES.map((m) => ({ ...m, disabled: ro }))} />
        {f.mode !== 'off' ? (
          <>
            <Field label="Discard after (hours)" error={badHours ? '1–720' : null}>
              <Input type="number" inputMode="numeric" min={1} max={720} value={f.hours} readOnly={ro} onChange={(e) => setF({ ...f, hours: e.target.value })} className="max-w-[140px] tabular" />
            </Field>
            <Switch label="Clear on sign out" checked={f.clear} disabled={ro} onCheckedChange={(v) => setF({ ...f, clear: v })} />
          </>
        ) : null}
        {err ? <ErrorNotice error={err} /> : null}
        {!ro ? (
          <div>
            <Button variant="primary" onClick={save} loading={busy} disabled={!changed} disabledReason={changed && badHours ? '1–720 hours.' : null}>Save</Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
