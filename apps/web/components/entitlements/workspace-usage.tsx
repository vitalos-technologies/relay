'use client';
// Admin → Usage: plan, allowances (included / used / reserved / limit / warning), held work, what stays active after a
// lowered limit, plan features, and Relay adjustments. Reads stored state only (no provider calls on render).
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, Gauge, Hourglass, LockKeyhole } from 'lucide-react';
import { FEATURES, PLANS, type Feature } from '@social-lite/core/contracts/v4-plans';
import { FEATURE_LABEL, type AllowanceState, type EntitlementsDto, type SelectionDto } from '@social-lite/core/contracts/v4-entitlements';
import { useApi } from '@/lib/client/use-api';
import { api } from '@/lib/client/api';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorNotice, ErrorState, Facts, LinkButton, MetaChip, Skeleton, useToast } from '@/components/ui';
import { AccessBanner } from './prompts';
import { BILLING_HREF, upgradeTarget } from './use-entitlements';

const GB = 1024 ** 3;
export function fmtAmount(unit: AllowanceState['unit'], n: number): string {
  if (unit === 'bytes') return n >= GB ? `${(n / GB).toLocaleString('en-GB', { maximumFractionDigits: 1 })} GB` : `${Math.round(n / 1_048_576).toLocaleString('en-GB')} MB`;
  return n.toLocaleString('en-GB');
}
const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

const STATUS: Record<AllowanceState['status'], { label: string; tone: 'neutral' | 'warn' | 'danger' | 'success' } | null> = {
  ok: null, unmetered: null,
  warning: { label: 'Nearly used', tone: 'warn' },
  exhausted: { label: 'Limit reached', tone: 'danger' },
  over_limit: { label: 'Over limit', tone: 'danger' },
};

export function AllowanceRow({ a }: { a: AllowanceState }) {
  const pct = a.hard_limit ? Math.min(100, Math.round(((a.used + a.reserved) / a.hard_limit) * 100)) : a.hard_limit === 0 ? 100 : 0;
  const s = STATUS[a.status];
  const bar = a.status === 'exhausted' || a.status === 'over_limit' ? 'bg-danger' : a.status === 'warning' ? 'bg-warn' : 'bg-[var(--text)]';
  const per = a.period_kind === 'trial' ? 'this trial' : a.period_kind === 'period' ? 'this period' : null;
  return (
    <li className="px-4 py-3" data-testid={`allowance-${a.key}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm font-medium">{a.label}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {a.source === 'override' ? <Badge tone="info">Adjusted by Relay</Badge> : null}
          {s ? <Badge tone={s.tone}>{s.label}</Badge> : null}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted tabular">
        {a.hard_limit === null
          ? `${fmtAmount(a.unit, a.used)} used${per ? ` ${per}` : ''} · not limited by plan`
          : `${fmtAmount(a.unit, a.used)}${a.reserved ? ` + ${fmtAmount(a.unit, a.reserved)} reserved` : ''} of ${fmtAmount(a.unit, a.hard_limit)}${per ? ` ${per}` : ''}`}
        {a.customer_cap !== null && a.included !== null && a.customer_cap < a.included ? ` · your budget ${fmtAmount(a.unit, a.customer_cap)} (plan ${fmtAmount(a.unit, a.included)})` : ''}
        {a.included === null && a.hard_limit !== null ? (a.customer_cap !== null ? ' · your budget' : ' · default safety cap') : ''}
      </p>
      {a.hard_limit !== null ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label={`${a.label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </li>
  );
}

function PlanCard({ e }: { e: EntitlementsDto }) {
  const trialDays = e.trial ? Math.max(0, Math.ceil((new Date(e.trial.ends_at).getTime() - Date.now()) / 86_400_000)) : null;
  const status = e.status === 'legacy' ? 'Legacy · all features' : e.status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">{e.plan?.name ?? 'No plan'}{e.trial && e.status === 'trialing' ? <Badge tone="accent">Trial</Badge> : null}</span>}
        actions={e.can_manage && e.plan?.id !== 'legacy' ? <LinkButton href={BILLING_HREF} size="sm" variant="secondary">Billing<ArrowUpRight aria-hidden className="size-3.5" /></LinkButton> : null} />
      <div className="px-4 pb-4">
        <Facts items={[
          ['Status', status],
          ['Access', e.access === 'full' ? 'Full' : e.access === 'restricted' ? 'Paid actions paused' : 'Suspended'],
          ...(trialDays !== null && e.status === 'trialing' ? [['Trial ends', `${fmtDate(e.trial!.ends_at)} · ${trialDays} day${trialDays === 1 ? '' : 's'} left`] as [string, string]] : []),
          ['Allowances reset', e.period.kind === 'trial' ? 'Not during the trial' : fmtDate(e.period.resets_at)],
        ]} />
      </div>
    </Card>
  );
}

function HeldCard({ e }: { e: EntitlementsDto }) {
  const h = e.held;
  const rows: Array<[string, number, string | null]> = [
    ['Scheduled posts held', h.scheduled_posts, '/queue'],
    ['Replies held', h.queued_replies, '/inbox'],
    ['Integration jobs held', h.sync_jobs, null],
    ['Automation runs blocked (24 h)', h.automation_runs_blocked_24h, '/automation'],
    ['Accounts over the limit', h.held_social_accounts, null],
    ['Searches over the limit', h.held_listening_searches, null],
    ['Brands over the limit', h.held_brands, null],
    ['People with paused access', h.held_members, '/settings/workspace/members'],
  ];
  const shown = rows.filter((r) => r[1] > 0);
  if (!shown.length) return null;
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Hourglass aria-hidden className="size-4 text-warn" />Held work</span>} actions={<MetaChip>Nothing is deleted</MetaChip>} />
      <ul className="divide-y divide-border">
        {shown.map(([label, n, href]) => (
          <li key={label} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            {href ? <Link className="underline-offset-2 hover:underline" href={href}>{label}</Link> : <span>{label}</span>}
            <span className="tabular font-medium">{n}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const SEL_LABEL: Record<SelectionDto['allowance'], { title: string; noun: string }> = {
  social_accounts: { title: 'Accounts that stay active', noun: 'accounts' },
  listening_searches: { title: 'Searches that stay active', noun: 'searches' },
  brands: { title: 'Brands that stay active', noun: 'brands' },
  members: { title: 'People who keep access', noun: 'people' },
};

function SelectionCard({ sel, canManage, onSaved }: { sel: SelectionDto; canManage: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => setChosen(sel.items.filter((i) => i.active).map((i) => i.id)), [sel]);
  const limit = sel.limit ?? sel.items.length;
  const changed = useMemo(() => chosen.slice().sort().join() !== sel.items.filter((i) => i.active).map((i) => i.id).sort().join(), [chosen, sel]);
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length < limit ? [...c, id] : c));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.put('/api/entitlements/selections', { allowance: sel.allowance, resource_ids: chosen });
      toast.success('Saved');
      onSaved();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const l = SEL_LABEL[sel.allowance];
  return (
    <Card data-testid={`selection-${sel.allowance}`}>
      <CardHeader title={l.title} actions={<MetaChip>{chosen.length} of {limit}</MetaChip>} />
      <p className="px-4 text-xs text-muted">{sel.allowance === 'members'
        ? <>Up to {limit} can use the workspace. Owners always keep access; others keep their account but are paused. Nothing is deleted.</>
        : <>Up to {limit} can stay active. The others stay connected but paused. Nothing is deleted.</>}</p>
      <ul className="mt-2 divide-y divide-border">
        {sel.items.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-2">
            {canManage ? (
              <Checkbox checked={chosen.includes(i.id)} onChange={() => toggle(i.id)} disabled={!chosen.includes(i.id) && chosen.length >= limit}
                label={<span className="text-sm">{i.name}{i.detail ? <span className="ml-1.5 text-xs capitalize text-muted">{i.detail}</span> : null}</span>} />
            ) : <span className="text-sm">{i.name}</span>}
            {i.active ? <Badge tone="success">Active</Badge> : <Badge tone="warn">Paused</Badge>}
          </li>
        ))}
      </ul>
      {canManage ? (
        <div className="flex flex-col gap-2 p-4">
          {err ? <ErrorNotice error={err} /> : null}
          <div><Button variant="primary" size="sm" onClick={save} loading={busy} disabled={!changed}>Save choice</Button></div>
        </div>
      ) : <p className="p-4 text-xs text-muted">People who manage billing can change this.</p>}
    </Card>
  );
}

function FeaturesCard({ e }: { e: EntitlementsDto }) {
  const shown = FEATURES.filter((f) => f !== 'support');
  return (
    <Card>
      <CardHeader title="Plan features" />
      <ul className="grid grid-cols-1 gap-x-6 px-4 pb-4 sm:grid-cols-2">
        {shown.map((f: Feature) => {
          const on = e.features[f].enabled;
          const to = upgradeTarget(f);
          return (
            <li key={f} className="flex items-center justify-between gap-2 border-b border-border py-2 text-sm last:border-0 sm:[&:nth-last-child(2)]:border-0">
              <span className={on ? '' : 'text-muted'}>{FEATURE_LABEL[f]}</span>
              {on ? <Check aria-label="Included" className="size-4 text-success" /> : <span className="flex items-center gap-1 text-xs text-muted"><LockKeyhole aria-hidden className="size-3.5" />{to ? PLANS[to].name : 'Not included'}</span>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function WorkspaceUsage() {
  const { data, error, loading, refetch } = useApi<EntitlementsDto>('/api/entitlements');
  const sel = useApi<{ items: SelectionDto[]; can_manage: boolean }>(data && data.allowances.length ? '/api/entitlements/selections' : null);
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!data.allowances.length) return <EmptyState icon={<Gauge aria-hidden />} title="Owners, admins and billing managers only" />;
  const over = (sel.data?.items ?? []).filter((s) => s.over_limit);
  const metered = data.allowances.filter((a) => a.hard_limit !== null || a.used > 0);
  return (
    <div className="flex flex-col gap-6" data-testid="workspace-usage">
      <AccessBanner entitlements={data} />
      <PlanCard e={data} />
      <HeldCard e={data} />
      {over.map((s) => <SelectionCard key={s.allowance} sel={s} canManage={!!sel.data?.can_manage} onSaved={() => { void sel.refetch(); void refetch(); }} />)}
      <Card>
        <CardHeader title="Allowances" actions={<MetaChip>{data.period.kind === 'trial' ? 'Trial' : data.period.kind === 'subscription' ? 'Billing period' : 'Calendar month'}</MetaChip>} />
        {metered.length ? <ul className="divide-y divide-border">{metered.map((a) => <AllowanceRow key={a.key} a={a} />)}</ul>
          : <p className="px-4 pb-4 text-sm text-muted">Nothing is limited by your plan. Your own budgets below still apply.</p>}
        <p className="px-4 pb-4 text-xs text-muted">No overage is ever charged: at a limit, the action waits or is refused.</p>
      </Card>
      <FeaturesCard e={data} />
      {data.overrides.length ? (
        <Card>
          <CardHeader title="Adjusted by Relay" />
          <ul className="divide-y divide-border">
            {data.overrides.map((o) => (
              <li key={o.id} className="px-4 py-2.5 text-sm">
                <p className="font-medium">{o.kind === 'feature' ? FEATURE_LABEL[o.key as Feature] ?? o.key : o.kind === 'access' ? 'Full access kept on' : data.allowances.find((a) => a.key === o.key)?.label ?? o.key}</p>
                <p className="text-xs text-muted">{o.expires_at ? `Until ${fmtDate(o.expires_at)}` : 'No end date'}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
