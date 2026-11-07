'use client';
import { useEffect, useState } from 'react';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, isApiError } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import {
  Banner, Button, Card, CardHeader, Checkbox, ErrorNotice, Field, IconButton, InfoTip, Input, MetaChip, Skeleton, Switch, useToast,
} from '@/components/ui';
import type { PolicyDto, StageDef } from './types';

const ROLES: Array<{ value: StageDef['eligible_roles'][number]; label: string }> = [
  { value: 'approver', label: 'Approver' }, { value: 'admin', label: 'Admin' }, { value: 'owner', label: 'Owner' },
];

const blank = (n: number): StageDef => ({ name: n === 1 ? 'Internal review' : 'Client review', quorum: 1, eligible_roles: [], eligible_team_ids: [], allow_guests: n === 2 });

/** Mirrors the server rule: anything that is not a pure tightening needs fresh authentication. */
function weakens(before: PolicyDto, after: { sod: boolean; stages: StageDef[] }): boolean {
  if (before.separation_of_duties && !after.sod) return true;
  return before.stages.some((b, i) => {
    const a = after.stages[i];
    if (!a || a.quorum < b.quorum || (!b.allow_guests && a.allow_guests)) return true;
    const broader = (x: string[], y: string[]) => y.length > 0 && (x.length === 0 || x.some((v) => !y.includes(v)));
    return broader(a.eligible_roles, b.eligible_roles) || broader(a.eligible_team_ids, b.eligible_team_ids);
  });
}

const draftKey = (brandId: string) => `sl-policy-draft:${brandId}`;

export function ApprovalPolicyCard({ brandId }: { brandId: string }) {
  const toast = useToast();
  const { data, error, loading, refetch, setData } = useApi<PolicyDto>(`/api/brands/${brandId}/approval-policy`);
  const [sod, setSod] = useState(false);
  const [stages, setStages] = useState<StageDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<unknown>(null);

  useEffect(() => {
    if (!data) return;
    // A draft kept across the re-authentication redirect is restored once (same generation only).
    let restored = false;
    try {
      const raw = sessionStorage.getItem(draftKey(brandId));
      if (raw) {
        const d = JSON.parse(raw) as { generation: number; sod: boolean; stages: StageDef[] };
        sessionStorage.removeItem(draftKey(brandId));
        if (d.generation === data.generation) { setSod(d.sod); setStages(d.stages); restored = true; }
      }
    } catch { /* ignore */ }
    if (!restored) { setSod(data.separation_of_duties); setStages(data.stages.map((s) => ({ ...s }))); }
  }, [data, brandId]);

  if (error && !data) return <Card><CardHeader title="Approval policy" /><div className="p-4"><ErrorNotice error={error} /></div></Card>;
  if (loading || !data) return <Skeleton className="h-56 w-full rounded-xl" />;

  const editable = data.can_manage;
  const dirty = sod !== data.separation_of_duties || JSON.stringify(stages.map(({ position: _p, ...s }) => s)) !== JSON.stringify(data.stages.map(({ position: _p, ...s }) => s));
  const needsStepUp = dirty && weakens(data, { sod, stages });
  const setStage = (i: number, patch: Partial<StageDef>) => setStages((list) => list.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  const fe = isApiError(saveErr) ? saveErr.fieldErrors : undefined;

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    const body = { expected_generation: data.generation, separation_of_duties: sod, stages: stages.map(({ position: _p, ...s }) => ({ ...s, name: s.name.trim() })) };
    try {
      if (needsStepUp) sessionStorage.setItem(draftKey(brandId), JSON.stringify({ generation: data.generation, sod, stages }));
    } catch { /* ignore */ }
    try {
      const r = await api.put<{ policy: PolicyDto; voided_requests: number; held_schedules: number }>(`/api/brands/${brandId}/approval-policy`, body);
      try { sessionStorage.removeItem(draftKey(brandId)); } catch { /* ignore */ }
      setData({ ...data, ...r.policy });
      toast.success('Policy saved', [r.voided_requests ? `${r.voided_requests} open review${r.voided_requests === 1 ? '' : 's'} need resubmitting` : null,
        r.held_schedules ? `${r.held_schedules} approved post${r.held_schedules === 1 ? '' : 's'} held until re-reviewed` : null].filter(Boolean).join(' · ') || undefined);
    } catch (e) {
      setSaveErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><ShieldCheck aria-hidden className="size-4" /> Approval policy</span>}
        actions={<>{editable ? null : <MetaChip>View only</MetaChip>}<MetaChip>Gen {data.generation}</MetaChip></>}
      />
      <div className="flex flex-col gap-4 p-4">
        {stages.length === 0 ? <p className="text-[13px] text-muted">No review — posts can be scheduled directly.</p> : null}
        {stages.map((s, i) => (
          <fieldset key={i} className="rounded-lg border border-border p-3" aria-label={`Stage ${i + 1}`}>
            <div className="mb-3 flex items-center gap-2">
              <legend className="text-xs font-medium uppercase tracking-wide text-subtle">Stage {i + 1}</legend>
              <span className="flex-1" />
              {editable ? <IconButton label={`Remove stage ${i + 1}`} size="sm" icon={<Trash2 aria-hidden className="size-4" />} onClick={() => setStages((l) => l.filter((_, n) => n !== i))} /> : null}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
              <Field label="Name" error={fe?.[`stages.${i}.name`]}><Input value={s.name} maxLength={60} onChange={(e) => setStage(i, { name: e.target.value })} readOnly={!editable} /></Field>
              <Field label="Quorum" info="Distinct people needed. Someone in two teams counts once.">
                <Input type="number" inputMode="numeric" min={1} max={10} value={s.quorum} onChange={(e) => setStage(i, { quorum: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} readOnly={!editable} />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2" role="group" aria-label="Eligible roles">
              <span className="text-xs text-muted">Roles<InfoTip label="About roles" className="ml-0.5">None selected = anyone who can approve on this brand.</InfoTip></span>
              {ROLES.map((r) => (
                <Checkbox key={r.value} label={r.label} checked={s.eligible_roles.includes(r.value)} disabled={!editable}
                  onChange={(e) => setStage(i, { eligible_roles: e.target.checked ? [...s.eligible_roles, r.value] : s.eligible_roles.filter((x) => x !== r.value) })} />
              ))}
            </div>
            {data.teams.length ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2" role="group" aria-label="Eligible teams">
                <span className="text-xs text-muted">Teams<InfoTip label="About teams" className="ml-0.5">None selected = any team.</InfoTip></span>
                {data.teams.map((t) => (
                  <Checkbox key={t.id} label={t.name} checked={s.eligible_team_ids.includes(t.id)} disabled={!editable}
                    onChange={(e) => setStage(i, { eligible_team_ids: e.target.checked ? [...s.eligible_team_ids, t.id] : s.eligible_team_ids.filter((x) => x !== t.id) })} />
                ))}
              </div>
            ) : null}
            <div className="mt-3"><Switch checked={s.allow_guests} onCheckedChange={(v) => setStage(i, { allow_guests: v })} disabled={!editable} label="Client guests can approve" description="Only guests this review was shared with." /></div>
          </fieldset>
        ))}
        {editable && stages.length < 2 ? (
          <Button variant="secondary" size="sm" className="self-start" icon={<Plus aria-hidden className="size-4" />} onClick={() => setStages((l) => [...l, blank(l.length + 1)])}>Add stage</Button>
        ) : null}
        <Switch checked={sod} onCheckedChange={setSod} disabled={!editable || stages.length === 0} label="Separation of duties" description="Authors and editors can’t approve their own work." />
        {needsStepUp ? <Banner tone="warn" title="This weakens review">You’ll confirm it’s you. Open reviews restart; approved posts stay held until re-reviewed.</Banner>
          : dirty ? <Banner tone="info" title="Open reviews restart under the new policy" /> : null}
        {saveErr && !fe ? <ErrorNotice error={saveErr} /> : null}
        {editable ? (
          <div className="flex gap-2">
            <Button variant="primary" onClick={save} loading={busy} disabledReason={!dirty ? 'No changes.' : stages.some((s) => !s.name.trim()) ? 'Name every stage.' : null}>
              {needsStepUp ? 'Confirm & save' : 'Save policy'}
            </Button>
            {dirty ? <Button variant="ghost" onClick={() => { setSod(data.separation_of_duties); setStages(data.stages.map((s) => ({ ...s }))); }}>Reset</Button> : null}
          </div>
        ) : null}
        {data.updated_by_email ? <p className="text-[11px] text-subtle">Last changed by {data.updated_by_email}</p> : null}
      </div>
    </Card>
  );
}
