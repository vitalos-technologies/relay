'use client';
import { useState, type ReactNode } from 'react';
import { Activity, CircleCheck, OctagonX, RefreshCw } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { fmtNumber } from '@/lib/client/format';
import type { DiagnosticsCheck } from '@/lib/client/types';
import { Banner, Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, SkeletonRows, Table, Td, Th, THead, TimeWithZone, Tr } from '@/components/ui';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export default function OperationsPage() {
  const { can, session } = useSession();
  const allowed = can('diagnostics.read');
  const ops = useApi<Record<string, Json>>(allowed ? '/api/ops' : null, { poll: 30_000 });
  const diag = useApi<{ checks: DiagnosticsCheck[] }>(allowed ? '/api/diagnostics' : null, { poll: 60_000 });
  const [at, setAt] = useState(() => new Date().toISOString());
  const tz = session.workspace?.timezone ?? 'UTC';
  if (!allowed) return <><PageHeader title="Operations" /><EmptyState icon={<Activity aria-hidden />} title="Owners and admins only" /></>;

  const dispatch = ops.data?.dispatch_enabled;
  const rest = Object.entries(ops.data ?? {}).filter(([k]) => k !== 'dispatch_enabled');

  return (
    <>
      <PageHeader
        title="Operations"
        description={<>Live figures reported by the server. Nothing here is estimated. Last refreshed <TimeWithZone instant={at} tz={tz} format="time" />.</>}
        actions={<Button icon={<RefreshCw aria-hidden className="size-4" />} loading={ops.refreshing || diag.refreshing} onClick={async () => { await Promise.all([ops.refetch(), diag.refetch()]); setAt(new Date().toISOString()); }}>Refresh</Button>}
      />
      <div className="flex flex-col gap-6">
        {typeof dispatch === 'boolean' ? (
          dispatch
            ? <Banner tone="success" title="Dispatch is enabled">The worker sends due posts.</Banner>
            : <Banner tone="danger" title="Dispatch is disabled">No posts are being sent by the worker. This is a deployment-level switch.</Banner>
        ) : null}

        <Card aria-labelledby="h-diag">
          <CardHeader id="h-diag" title="Diagnostics" description="Connectivity and configuration checks." />
          <div className="p-4">
            {diag.error && !diag.data ? <ErrorState error={diag.error} onRetry={diag.refetch} /> : diag.loading ? <SkeletonRows rows={3} /> : !diag.data?.checks.length ? <p className="text-[13px] text-muted">No checks reported.</p> : (
              <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {diag.data.checks.map((c) => (
                  <li key={c.name} className="flex items-start gap-3 rounded-lg border border-border bg-sunken px-3 py-2.5">
                    {c.ok ? <CircleCheck aria-hidden className="mt-0.5 size-4 text-success" /> : <OctagonX aria-hidden className="mt-0.5 size-4 text-danger" />}
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium">{c.name} <span className={c.ok ? 'text-success' : 'text-danger'}>· {c.ok ? 'OK' : 'Failing'}</span></p>
                      {c.detail ? <p className="break-words text-xs text-muted">{c.detail}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        {ops.error && !ops.data ? <ErrorState error={ops.error} onRetry={ops.refetch} /> : ops.loading ? <SkeletonRows rows={4} /> : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {rest.map(([k, v]) => (
              <Card key={k} aria-label={label(k)}>
                <CardHeader title={label(k)} />
                <div className="p-4"><Value v={v} tz={tz} /></div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function label(k: string) {
  const s = k.replace(/_/g, ' ').replace(/\bp(\d{2})\b/g, 'p$1');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isIso(s: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);
}

/** Ratio objects are shown with their denominator (and period, when given) — never as a bare percentage. */
function ratio(o: { [k: string]: Json }): ReactNode | null {
  const num = (o.numerator ?? o.succeeded ?? o.success ?? o.published) as Json;
  const den = (o.denominator ?? o.total ?? o.eligible) as Json;
  if (typeof num !== 'number' || typeof den !== 'number') return null;
  const pct = den > 0 ? ` (${((num / den) * 100).toFixed(1)}%)` : '';
  const period = typeof o.period === 'string' ? o.period : typeof o.window === 'string' ? o.window : null;
  return <span className="tabular"><strong className="text-[15px]">{fmtNumber(num)}</strong> of {fmtNumber(den)}{pct}{period ? <span className="text-muted"> · {period}</span> : null}</span>;
}

function Value({ v, tz }: { v: Json; tz: string }): ReactNode {
  if (v === null) return <span className="text-muted">—</span>;
  if (typeof v === 'boolean') return v ? <span className="inline-flex items-center gap-1.5"><CircleCheck aria-hidden className="size-4 text-success" />Yes</span> : <span className="inline-flex items-center gap-1.5"><OctagonX aria-hidden className="size-4 text-danger" />No</span>;
  if (typeof v === 'number') return <span className="text-[15px] font-semibold tabular">{fmtNumber(v)}</span>;
  if (typeof v === 'string') return isIso(v) ? <TimeWithZone instant={v} tz={tz} /> : <span className="break-words">{v}</span>;
  if (Array.isArray(v)) {
    if (!v.length) return <span className="text-muted">None</span>;
    const objs = v.every((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objs) {
      const cols = Array.from(new Set(v.flatMap((x) => Object.keys(x as object))));
      return (
        <Table className="rounded-lg">
          <THead><tr>{cols.map((c) => <Th key={c}>{label(c)}</Th>)}</tr></THead>
          <tbody>
            {v.map((row, i) => (
              <Tr key={i}>{cols.map((c) => <Td key={c}><Value v={(row as { [k: string]: Json })[c] ?? null} tz={tz} /></Td>)}</Tr>
            ))}
          </tbody>
        </Table>
      );
    }
    return <span>{v.map(String).join(', ')}</span>;
  }
  const r = ratio(v);
  if (r) return r;
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-2 text-[13px]">
      {Object.entries(v).map(([k, x]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{label(k)}</dt>
          <dd className="min-w-0"><Value v={x} tz={tz} /></dd>
        </div>
      ))}
    </dl>
  );
}
