'use client';
// Automation: rules (trigger → conditions → actions, scope, schedule, limits, test preview, enable/disable), the bounded
// policies they run under, execution history and a workspace-wide emergency stop. automation.manage only.
import { useState } from 'react';
import Link from 'next/link';
import { CirclePause, CirclePlay, History, OctagonX, Plus, ShieldCheck, Workflow } from 'lucide-react';
import type { AutomationCatalogDto, AutomationPolicyDto, AutomationRuleDto, AutomationRunDto } from '@social-lite/core/contracts/v35-automation';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import {
  Badge, Banner, Button, ConfirmDialog, EmptyState, ErrorState, PageHeader, SkeletonRows, Switch, Tabs, TabsContent, TabsList, TabsTrigger, useToast,
} from '@/components/ui';
import { ACTION_LABEL, OUTCOME_LABEL, OUTCOME_TONE, POLICY_STATUS_LABEL, POLICY_STATUS_TONE, TRIGGER_LABEL } from './labels';
import { RuleBuilder } from './rule-builder';
import { PolicyEditor } from './policy-editor';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export function AutomationApp() {
  const { canV2 } = useSession();
  const toast = useToast();
  const catalog = useApi<AutomationCatalogDto>(canV2('automation.manage') ? '/api/automation/catalog' : null);
  const policies = useApi<{ items: AutomationPolicyDto[] }>(canV2('automation.manage') ? '/api/automation/policies' : null);
  const [tab, setTab] = useState('rules');
  const [stopOpen, setStopOpen] = useState(false);
  if (!canV2('automation.manage')) return <div><PageHeader title="Automation" eyebrow={<nav aria-label="Breadcrumb"><Link href="/assistant" className="hover:underline">Assistant</Link><span aria-hidden> / </span><span aria-current="page">Automation</span></nav>} /><Banner tone="info" title="Owners and admins manage automation">Ask an owner or admin for access.</Banner></div>;
  if (catalog.error && !catalog.data) return <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />;
  const stop = catalog.data?.emergency_stop;
  const refresh = () => { void catalog.refetch(); void policies.refetch(); };
  return (
    <div>
      <PageHeader title="Automation" eyebrow={<nav aria-label="Breadcrumb"><Link href="/assistant" className="hover:underline">Assistant</Link><span aria-hidden> / </span><span aria-current="page">Automation</span></nav>} meta={stop?.active ? 'Stopped' : undefined}
        actions={stop ? (stop.active
          ? <Button variant="primary" icon={<CirclePlay aria-hidden className="size-4" />} onClick={async () => { try { await api.post('/api/automation/emergency-stop', { active: false }); toast.success('Automation resumed'); refresh(); } catch (e) { toast.error(e); } }}>Resume automation</Button>
          : <Button variant="danger" icon={<OctagonX aria-hidden className="size-4" />} onClick={() => setStopOpen(true)}>Emergency stop</Button>) : null} />
      {stop?.active ? <Banner tone="danger" title="Emergency stop is on" className="mb-5">No rule runs and queued automatic replies were cancelled. {stop.by ? `Stopped by ${stop.by}, ` : ''}{fmt(stop.at)}.</Banner> : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Automation sections">
          <TabsTrigger value="rules"><Workflow aria-hidden className="size-4" />Rules</TabsTrigger>
          <TabsTrigger value="policies"><ShieldCheck aria-hidden className="size-4" />Policies</TabsTrigger>
          <TabsTrigger value="history"><History aria-hidden className="size-4" />History</TabsTrigger>
        </TabsList>
        <TabsContent value="rules" className="pt-5">{catalog.data && policies.data ? <Rules catalog={catalog.data} policies={policies.data.items} /> : <SkeletonRows rows={4} />}</TabsContent>
        <TabsContent value="policies" className="pt-5">{catalog.data && policies.data ? <Policies catalog={catalog.data} policies={policies.data.items} onChanged={refresh} /> : <SkeletonRows rows={3} />}</TabsContent>
        <TabsContent value="history" className="pt-5">{tab === 'history' ? <Runs /> : null}</TabsContent>
      </Tabs>
      <ConfirmDialog open={stopOpen} onOpenChange={setStopOpen} title="Stop all automation?" confirmLabel="Stop everything" confirmVariant="danger"
        onConfirm={async () => { const r = await api.post<{ cancelled: number }>('/api/automation/emergency-stop', { active: true }); toast.success(r.cancelled ? `Stopped · ${r.cancelled} queued replies cancelled` : 'Stopped'); refresh(); }}>
        Every rule stops and queued automatic replies are cancelled. Replies already sent are not affected.
      </ConfirmDialog>
    </div>
  );
}

function Rules({ catalog, policies }: { catalog: AutomationCatalogDto; policies: AutomationPolicyDto[] }) {
  const toast = useToast();
  const rules = useApi<{ items: AutomationRuleDto[] }>('/api/automation/rules');
  const [edit, setEdit] = useState<AutomationRuleDto | 'new' | null>(null);
  const policyName = new Map(policies.map((p) => [p.id, p]));
  if (rules.error && !rules.data) return <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />;
  if (!rules.data) return <SkeletonRows rows={4} />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">Rules run in order. Each runs under a policy and never exceeds it.</p>
        <Button variant="primary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setEdit('new')} disabledReason={!policies.length ? 'Create a policy first' : null}>New rule</Button>
      </div>
      {!rules.data.items.length ? <EmptyState compact icon={<Workflow aria-hidden />} title="No rules yet" /> : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {rules.data.items.map((r) => {
            const p = policyName.get(r.policy_id);
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEdit(r)}>
                  <p className="truncate font-medium">{r.name}</p>
                  <p className="truncate text-xs text-muted">{TRIGGER_LABEL[r.trigger]} → {r.actions.map((a) => ACTION_LABEL[a.type]).join(', ')}</p>
                </button>
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  {p ? <Badge tone={POLICY_STATUS_TONE[p.status]} className="h-5 px-1.5 text-[11px]">{p.name}</Badge> : null}
                  <span className="tabular">{r.runs_24h} today</span>
                </span>
                <Switch label={<span className="sr-only">Enabled</span>} checked={r.enabled} onCheckedChange={async (v) => {
                  try { await api.post(`/api/automation/rules/${r.id}/enabled`, { enabled: v }); toast.success(v ? 'Rule on' : 'Rule off'); void rules.refetch(); } catch (e) { toast.error(e); }
                }} />
              </li>
            );
          })}
        </ul>
      )}
      {edit ? <RuleBuilder catalog={catalog} policies={policies} rule={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void rules.refetch(); }} /> : null}
    </div>
  );
}

function Policies({ catalog, policies, onChanged }: { catalog: AutomationCatalogDto; policies: AutomationPolicyDto[]; onChanged: () => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState<AutomationPolicyDto | 'new' | null>(null);
  const setStatus = async (p: AutomationPolicyDto, status: 'active' | 'paused' | 'stopped') => {
    try { await api.post(`/api/automation/policies/${p.id}/status`, { status }); toast.success(status === 'active' ? 'Policy active' : status === 'paused' ? 'Paused' : 'Stopped'); onChanged(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">A policy sets what automation may do: brands, channels, actions, sources, limits, escalation and expiry.</p>
        <Button variant="secondary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setEdit('new')}>New policy</Button>
      </div>
      {!policies.length ? <EmptyState compact icon={<ShieldCheck aria-hidden />} title="No policies yet" /> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {policies.map((p) => (
            <li key={p.id} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-[13px]">
              <div className="flex items-start justify-between gap-2">
                <button type="button" className="min-w-0 text-left" onClick={() => setEdit(p)}><p className="truncate font-medium">{p.name}</p></button>
                <Badge tone={POLICY_STATUS_TONE[p.status]}>{POLICY_STATUS_LABEL[p.status]}</Badge>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted">Scope</dt><dd>{p.brand_ids.length} brand{p.brand_ids.length === 1 ? '' : 's'} · {p.channel_ids.length} channel{p.channel_ids.length === 1 ? '' : 's'}</dd>
                <dt className="text-muted">Actions</dt><dd className="truncate">{p.allowed_actions.map((a) => ACTION_LABEL[a]).join(', ')}</dd>
                <dt className="text-muted">Auto replies</dt><dd className="tabular">{p.usage.auto_replies_today} / {p.limits.max_auto_replies_per_day} today</dd>
                <dt className="text-muted">Actions/hour</dt><dd className="tabular">{p.usage.actions_last_hour} / {p.limits.max_actions_per_hour}</dd>
                <dt className="text-muted">Expires</dt><dd>{new Date(p.expires_at).toLocaleDateString()}</dd>
                <dt className="text-muted">Owner</dt><dd className="truncate">{p.owner?.name ?? '—'}</dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                {p.status === 'active'
                  ? <><Button size="sm" variant="secondary" icon={<CirclePause aria-hidden className="size-4" />} onClick={() => setStatus(p, 'paused')}>Pause</Button><Button size="sm" variant="danger" onClick={() => setStatus(p, 'stopped')}>Stop</Button></>
                  : <Button size="sm" variant="primary" icon={<CirclePlay aria-hidden className="size-4" />} onClick={() => setStatus(p, 'active')} disabledReason={p.status === 'expired' || new Date(p.expires_at) < new Date() ? 'Set a new expiry first' : null}>Activate</Button>}
                <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>Edit</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {edit ? <PolicyEditor catalog={catalog} policy={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} /> : null}
    </div>
  );
}

function Runs() {
  const runs = useApi<{ items: AutomationRunDto[] }>('/api/automation/runs?limit=100', { poll: 15_000 });
  if (runs.error && !runs.data) return <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />;
  if (!runs.data) return <SkeletonRows rows={5} />;
  if (!runs.data.items.length) return <EmptyState compact icon={<History aria-hidden />} title="Nothing has run yet" />;
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
      {runs.data.items.map((r) => (
        <li key={r.id} className="flex flex-col gap-1.5 px-4 py-3 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">{r.rule?.name ?? 'Rule'}</span>
            <Badge tone={OUTCOME_TONE[r.outcome]}>{OUTCOME_LABEL[r.outcome]}</Badge>
            <span className="tabular text-xs text-subtle">{fmt(r.created_at)}</span>
          </div>
          <p className="text-xs text-muted">
            {TRIGGER_LABEL[r.trigger]}{r.subject.type === 'conversation' ? <> · <a className="underline-offset-2 hover:underline" href={`/inbox?c=${r.subject.id}`}>conversation</a></> : ' · case'}
            {r.reason ? ` · ${r.reason}` : ''}
          </p>
          {r.actions.length ? (
            <ul className="flex min-w-0 flex-col gap-0.5">
              {r.actions.map((a, i) => (
                <li key={i} className="flex min-w-0 items-start gap-1.5 text-xs">
                  <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${a.status === 'done' ? 'bg-[var(--success)]' : a.status === 'failed' ? 'bg-[var(--danger)]' : a.status === 'pending' ? 'bg-[var(--info)]' : 'bg-[var(--warn)]'}`} />
                  <span className="min-w-0 break-words"><span className="font-medium">{ACTION_LABEL[a.type]}</span> · {a.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
