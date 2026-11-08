'use client';
// Settings → Budgets: workspace caps and per-team caps (owner edits; owner/admin read) with this
// period's usage and open reservations (V2: one reservation mechanism for AI, storage, exports and
// provider calls; usage is charged to the workspace and to the acting person's teams).
import { useEffect, useState } from 'react';
import { Gauge, Users } from 'lucide-react';
import { useApi } from '@/lib/client/use-api';
import { api, isApiError } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { Card, CardHeader, EmptyState, ErrorNotice, ErrorState, InfoTip, Input, MetaChip, Skeleton, Button, useToast } from '@/components/ui';

type Unit = 'tokens' | 'calls' | 'bytes' | 'exports';
interface MeterRow { cap: number | null; used: number; reserved: number; percent: number | null; unit: Unit; label: string }
interface LimitsView {
  period: string; can_edit: boolean;
  items: Array<MeterRow & { key: string; meter: string; effective_cap: number | null; period: string }>;
  teams: Array<{ id: string; name: string; meters: Array<MeterRow & { meter: string }> }>;
}

const HELP: Record<string, string> = {
  x_monthly_writes: 'X posts sent this month. At the cap, X posts are held; other networks continue.',
  x_monthly_reads: 'Billable X reads (status checks, analytics). At the cap, they are skipped.',
  ai_monthly_tokens: 'AI drafting tokens this month. Default 200,000 when empty.',
  storage_bytes: 'Media originals stored (all time). Enter megabytes.',
  monthly_exports: 'Activity and client handover exports this month.',
};

const MB = 1_048_576;
const toInput = (unit: Unit, v: number | null) => (v === null ? '' : unit === 'bytes' ? String(Math.round((v / MB) * 100) / 100) : String(v));
const fromInput = (unit: Unit, s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return unit === 'bytes' ? Math.round(n * MB) : n;
};
const fmt = (unit: Unit, n: number) => (unit === 'bytes' ? `${(n / MB).toLocaleString('en-GB', { maximumFractionDigits: 1 })} MB` : n.toLocaleString('en-GB'));
const valid = (v: number | null) => v === null || (Number.isFinite(v) && Number.isInteger(v) && v >= 0);

function UsageLine({ row, cap }: { row: MeterRow; cap: number | null }) {
  const pct = cap ? Math.min(100, Math.round(((row.used + row.reserved) / cap) * 100)) : 0;
  const tone = pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warn' : 'bg-[var(--text)]';
  return (
    <>
      <p className="mt-1 text-xs text-muted tabular">
        {fmt(row.unit, row.used)} used{row.reserved ? ` · ${fmt(row.unit, row.reserved)} reserved` : ''}{cap !== null ? ` of ${fmt(row.unit, cap)} · ${row.percent ?? pct}%` : ' · no cap'}
      </p>
      {cap !== null ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label={`${row.label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </>
  );
}

export function BudgetsSettings() {
  const { can } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch, setData } = useApi<LimitsView>(can('workspace.settings') ? '/api/workspace/limits' : null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<unknown>(null);
  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.items.map((i) => [i.key, toInput(i.unit, i.cap)])));
  }, [data]);
  if (!can('workspace.settings')) return <EmptyState icon={<Gauge aria-hidden />} title="Owners and admins only" />;
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Skeleton className="h-48 w-full max-w-2xl rounded-xl" />;
  const parsed = Object.fromEntries(data.items.map((i) => [i.key, fromInput(i.unit, draft[i.key] ?? '')])) as Record<string, number | null>;
  const bad = Object.values(parsed).some((v) => !valid(v));
  const changed = data.items.some((i) => parsed[i.key] !== i.cap);
  const fe = isApiError(saveErr) ? saveErr.fieldErrors : undefined;

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      const patch = Object.fromEntries(data.items.filter((i) => parsed[i.key] !== i.cap).map((i) => [i.key, parsed[i.key]]));
      setData(await api.patch<LimitsView>('/api/workspace/limits', patch));
      toast.success('Budgets saved');
    } catch (e) {
      setSaveErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Card>
        <CardHeader title={<span className="flex items-center gap-1">Workspace <InfoTip>Monthly meters reset each calendar month (UTC). Storage is a running total. Empty = no cap.</InfoTip></span>}
          actions={data.can_edit ? <MetaChip>{data.period}</MetaChip> : <MetaChip>Read only · {data.period}</MetaChip>} />
        <ul className="divide-y divide-border">
          {data.items.map((i) => (
            <li key={i.key} className="grid grid-cols-1 items-center gap-3 px-4 py-3 sm:grid-cols-[1fr_160px]">
              <div className="min-w-0">
                <p className="flex items-center gap-1 text-sm font-medium">{i.label.replace(' (bytes)', '')}<InfoTip>{HELP[i.key] ?? i.meter}</InfoTip></p>
                <UsageLine row={i} cap={i.effective_cap} />
              </div>
              {data.can_edit ? (
                <label className="flex flex-col gap-1 text-xs text-muted">
                  <span className="sr-only">{i.label} cap</span>
                  <Input type="number" inputMode="decimal" min={0} step={i.unit === 'bytes' ? 'any' : 1} placeholder={i.effective_cap !== null && i.cap === null ? `Default ${fmt(i.unit, i.effective_cap)}` : 'No cap'}
                    value={draft[i.key] ?? ''} aria-invalid={!!fe?.[i.key] || !valid(parsed[i.key] ?? null)}
                    onChange={(e) => setDraft({ ...draft, [i.key]: e.target.value })} className="tabular" />
                  {i.unit === 'bytes' ? <span aria-hidden>MB</span> : null}
                </label>
              ) : (
                <span className="text-sm tabular sm:text-right">{i.effective_cap === null ? 'No cap' : fmt(i.unit, i.effective_cap)}</span>
              )}
            </li>
          ))}
        </ul>
        {data.can_edit ? (
          <div className="flex flex-col gap-3 p-4">
            {saveErr ? <ErrorNotice error={saveErr} /> : null}
            <div><Button variant="primary" onClick={save} loading={busy} disabled={!changed} disabledReason={bad ? 'Use whole numbers ≥ 0.' : null}>Save</Button></div>
          </div>
        ) : null}
      </Card>
      <TeamBudgets view={data} onSaved={setData} />
    </div>
  );
}

function TeamBudgets({ view, onSaved }: { view: LimitsView; onSaved: (v: LimitsView) => void }) {
  if (!view.teams.length) {
    return (
      <Card>
        <CardHeader title={<span className="flex items-center gap-1">Teams <InfoTip>Team caps limit what members of a team use together. Usage also counts toward the workspace.</InfoTip></span>} />
        <EmptyState compact icon={<Users aria-hidden />} title="No teams yet" />
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-1">Teams <InfoTip>Team caps limit what members of a team use together. Usage also counts toward the workspace.</InfoTip></span>} />
      <ul className="divide-y divide-border">
        {view.teams.map((t) => <TeamRow key={t.id} team={t} canEdit={view.can_edit} onSaved={onSaved} />)}
      </ul>
    </Card>
  );
}

function TeamRow({ team, canEdit, onSaved }: { team: LimitsView['teams'][number]; canEdit: boolean; onSaved: (v: LimitsView) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => setDraft(Object.fromEntries(team.meters.map((m) => [m.meter, toInput(m.unit, m.cap)]))), [team]);
  const parsed = Object.fromEntries(team.meters.map((m) => [m.meter, fromInput(m.unit, draft[m.meter] ?? '')])) as Record<string, number | null>;
  const changed = team.meters.some((m) => parsed[m.meter] !== m.cap);
  const bad = Object.values(parsed).some((v) => !valid(v));
  const capped = team.meters.filter((m) => m.cap !== null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      onSaved(await api.patch<LimitsView>(`/api/workspace/limits/teams/${team.id}`, Object.fromEntries(team.meters.filter((m) => parsed[m.meter] !== m.cap).map((m) => [m.meter, parsed[m.meter]]))));
      toast.success(`${team.name} budgets saved`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <li className="px-4 py-3">
      <button type="button" className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="text-sm font-medium">{team.name}</span>
        <span className="text-xs text-muted">{capped.length ? `${capped.length} cap${capped.length === 1 ? '' : 's'}` : 'No caps'}</span>
      </button>
      {open ? (
        <div className="mt-3 flex flex-col gap-3">
          {team.meters.map((m) => (
            <div key={m.meter} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_160px]">
              <div className="min-w-0"><p className="text-[13px]">{m.label}</p><UsageLine row={m} cap={m.cap} /></div>
              {canEdit ? (
                <label className="flex flex-col gap-1 text-xs text-muted">
                  <span className="sr-only">{team.name} {m.label} cap</span>
                  <Input type="number" inputMode="decimal" min={0} step={m.unit === 'bytes' ? 'any' : 1} placeholder="No cap" value={draft[m.meter] ?? ''}
                    aria-invalid={!valid(parsed[m.meter] ?? null)} onChange={(e) => setDraft({ ...draft, [m.meter]: e.target.value })} className="tabular" />
                  {m.unit === 'bytes' ? <span aria-hidden>MB</span> : null}
                </label>
              ) : <span className="text-sm tabular sm:text-right">{m.cap === null ? 'No cap' : fmt(m.unit, m.cap)}</span>}
            </div>
          ))}
          {canEdit ? (
            <div className="flex flex-col gap-2">
              {err ? <ErrorNotice error={err} /> : null}
              <div><Button variant="primary" size="sm" onClick={save} loading={busy} disabled={!changed} disabledReason={bad ? 'Use whole numbers ≥ 0.' : null}>Save {team.name}</Button></div>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
