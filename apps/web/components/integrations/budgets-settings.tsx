'use client';
// Settings → Budgets: monthly caps (owner edits; owner/admin read) with this period's usage from usage_counters.
import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { useApi } from '@/lib/client/use-api';
import { api, isApiError } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { Card, CardHeader, EmptyState, ErrorNotice, ErrorState, InfoTip, Input, MetaChip, Skeleton, Button, useToast } from '@/components/ui';

interface LimitsView {
  period: string; can_edit: boolean;
  items: Array<{ key: string; meter: string; label: string; cap: number | null; used: number; percent: number | null }>;
}

const HELP: Record<string, string> = {
  x_monthly_writes: 'X posts sent this month. At the cap, X posts are held; other networks continue.',
  x_monthly_reads: 'Billable X reads (status checks, analytics). At the cap, they are skipped.',
  ai_monthly_tokens: 'AI drafting tokens this month.',
};

export function BudgetsSettings() {
  const { can } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch, setData } = useApi<LimitsView>(can('workspace.settings') ? '/api/workspace/limits' : null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<unknown>(null);
  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.items.map((i) => [i.key, i.cap === null ? '' : String(i.cap)])));
  }, [data]);
  if (!can('workspace.settings')) return <EmptyState icon={<Gauge aria-hidden />} title="Owners and admins only" />;
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Skeleton className="h-48 w-full max-w-2xl rounded-xl" />;
  const parsed = Object.fromEntries(data.items.map((i) => {
    const v = (draft[i.key] ?? '').trim();
    return [i.key, v === '' ? null : Number(v)];
  })) as Record<string, number | null>;
  const bad = Object.values(parsed).some((v) => v !== null && (!Number.isInteger(v) || v < 0));
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
    <Card className="max-w-2xl">
      <CardHeader title={<span className="flex items-center gap-1">Monthly budgets <InfoTip>Usage resets each calendar month (UTC). Empty = no cap.</InfoTip></span>}
        actions={data.can_edit ? <MetaChip>{data.period}</MetaChip> : <MetaChip>Read only · {data.period}</MetaChip>} />
      <ul className="divide-y divide-border">
        {data.items.map((i) => {
          const pct = i.percent ?? 0;
          const tone = pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warn' : 'bg-[var(--text)]';
          return (
            <li key={i.key} className="grid grid-cols-1 items-center gap-3 px-4 py-3 sm:grid-cols-[1fr_160px]">
              <div className="min-w-0">
                <p className="flex items-center gap-1 text-sm font-medium">{i.label}<InfoTip>{HELP[i.key] ?? i.meter}</InfoTip></p>
                <p className="mt-1 text-xs text-muted tabular">
                  {i.used.toLocaleString('en-GB')} used{i.cap !== null ? ` of ${i.cap.toLocaleString('en-GB')} · ${i.percent}%` : ' · no cap'}
                </p>
                {i.cap !== null ? (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label={`${i.label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct)}>
                    <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                ) : null}
              </div>
              {data.can_edit ? (
                <label className="flex flex-col gap-1 text-xs text-muted">
                  <span className="sr-only">{i.label} cap</span>
                  <Input type="number" inputMode="numeric" min={0} placeholder="No cap" value={draft[i.key] ?? ''} aria-invalid={!!fe?.[i.key]}
                    onChange={(e) => setDraft({ ...draft, [i.key]: e.target.value })} className="tabular" />
                </label>
              ) : (
                <span className="text-sm tabular sm:text-right">{i.cap === null ? 'No cap' : i.cap.toLocaleString('en-GB')}</span>
              )}
            </li>
          );
        })}
      </ul>
      {data.can_edit ? (
        <div className="flex flex-col gap-3 p-4">
          {saveErr ? <ErrorNotice error={saveErr} /> : null}
          <div><Button variant="primary" onClick={save} loading={busy} disabled={!changed} disabledReason={bad ? 'Use whole numbers ≥ 0.' : null}>Save</Button></div>
        </div>
      ) : null}
    </Card>
  );
}
