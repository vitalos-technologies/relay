'use client';
// Platform → Rollouts: installation feature-flag rows (default, rollout %, kill switch). A kill switch beats every
// workspace override; rollout buckets are stable per workspace. Workspace admins keep their own overrides.
import { useState } from 'react';
import type { PlatformFlag } from '@social-lite/core/contracts/v31-admin';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Button, Card, ErrorState, Field, Input, PageHeader, SkeletonRows, Switch, useToast } from '@/components/ui';
import { Ago, ReasonDialog } from '@/components/admin/ui';

export default function PlatformRolloutsPage() {
  const { session } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch, setData } = useApi<{ items: PlatformFlag[] }>('/api/platform/flags');
  const [edit, setEdit] = useState<PlatformFlag | null>(null);
  const [pct, setPct] = useState('0');
  const [killed, setKilled] = useState(false);
  const [def, setDef] = useState(false);
  const operator = session.platform_role === 'operator';
  return (
    <>
      <PageHeader title="Rollouts" />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={5} /> : (
        <ul className="flex flex-col gap-3">
          {data.items.map((f) => (
            <Card as="li" key={f.key} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium">{f.description || f.key}
                  {f.killed ? <Badge tone="danger">Killed</Badge> : f.rollout_percent > 0 ? <Badge tone="info">{f.rollout_percent}%</Badge> : f.default_enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}</p>
                <p className="mt-0.5 text-xs text-muted"><code>{f.key}</code> · {f.overrides} workspace override{f.overrides === 1 ? '' : 's'}{f.updated_at ? <> · changed <Ago at={f.updated_at} /></> : null}</p>
              </div>
              <Button size="sm" disabledReason={!operator ? 'Operators only' : null} onClick={() => { setEdit(f); setPct(String(f.rollout_percent)); setKilled(f.killed); setDef(f.default_enabled); }}>Change</Button>
            </Card>
          ))}
        </ul>
      )}
      <ReasonDialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit ? `Roll out ${edit.description || edit.key}` : ''} confirmLabel="Save"
        description="Applies to every workspace on its next request. Workspace overrides still win unless the flag is killed."
        onConfirm={async (reason) => { if (!edit) return; const r = await api.patch<{ items: PlatformFlag[] }>(`/api/platform/flags/${encodeURIComponent(edit.key)}`, { rollout_percent: Math.max(0, Math.min(100, Number(pct) || 0)), killed, default_enabled: def, reason }); setData(r); toast.success('Saved'); }}>
        <div className="flex flex-col gap-4">
          <Field label="Rollout (% of workspaces)"><Input type="number" min={0} max={100} inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
          <Switch checked={def} onCheckedChange={setDef} label="On by default" />
          <Switch checked={killed} onCheckedChange={setKilled} label="Kill switch (off everywhere)" />
        </div>
      </ReasonDialog>
    </>
  );
}
