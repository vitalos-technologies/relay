'use client';
// Signup step 2 (signed in): create the workspace; on a paid plan the server starts its one 14-day no-card trial in the same
// transaction; on Free (D33) the workspace starts on Free with no trial. Users who already belong to a workspace are sent to that workspace's Billing instead (no second trial).
import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { PlanCatalogueEntry, PublicPlanId } from '@social-lite/core/contracts/v4-plans';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { allTimeZones } from '@/lib/client/format';
import { Button, ErrorNotice, ErrorState, Field, Input, Select, Spinner, cn } from '@/components/ui';
import { Logo } from '@/components/shell/logo';
import { SessionProvider } from '@/lib/client/session';
import { money } from '@/components/billing/format';

interface Ctx { can_create_workspace: boolean; workspaces: Array<{ id: string; name: string; status: string }>; catalogue: PlanCatalogueEntry[] }

export default function SignupWorkspacePage() {
  return (
    <SessionProvider requireWorkspace={false} fallback={<main className="flex min-h-dvh items-center justify-center"><Spinner label="Loading your account" /></main>}
      renderError={(e, retry) => <main className="p-6"><ErrorState error={e} onRetry={retry} /></main>}>
      <SignupWorkspace />
    </SessionProvider>
  );
}

function SignupWorkspace() {
  const { data, error, refetch } = useApi<Ctx>('/api/billing/signup');
  const initial = useSearchParams().get('plan');
  const [plan, setPlan] = useState<PublicPlanId>(initial === 'professional' || initial === 'free' ? initial : 'standard');
  return (
    <main className="flex min-h-dvh items-start justify-center px-4 py-10 sm:items-center">
      <div className="w-full max-w-[480px]">
        <div className="mb-8"><Logo /></div>
        {error && !data ? <ErrorState error={error} onRetry={refetch} /> : !data ? <Spinner label="Loading" /> : data.can_create_workspace
          ? <CreateForm ctx={data} plan={plan} setPlan={setPlan} />
          : <AlreadyMember ctx={data} />}
      </div>
    </main>
  );
}

function AlreadyMember({ ctx }: { ctx: Ctx }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
      <h1 className="text-[22px] font-semibold">You already have a workspace</h1>
      <p className="mt-2 text-[13px] text-muted">{ctx.workspaces[0] ? `${ctx.workspaces[0].name} — choose or change its plan in Billing.` : 'Ask a workspace owner to invite you.'}</p>
      {ctx.workspaces[0] ? <Link href="/settings/workspace/billing" className="touch-target mt-6 inline-flex h-11 items-center rounded-lg bg-accent px-5 text-[15px] font-medium text-on-accent hover:bg-accent-hover">Open Billing</Link> : null}
    </section>
  );
}

function CreateForm({ ctx, plan, setPlan }: { ctx: Ctx; plan: PublicPlanId; setPlan: (p: PublicPlanId) => void }) {
  const selected = ctx.catalogue.find((p) => p.id === plan);
  const isFree = selected?.unit_amount_minor === 0;
  const zones = useMemo(() => allTimeZones(), []);
  const [name, setName] = useState('');
  const [tz, setTz] = useState('Europe/London');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setFieldErr('Enter a name.'); return; }
    setFieldErr(null); setBusy(true); setErr(null);
    try {
      const r = await api.post<{ workspace: { id: string } }>('/api/billing/signup', { name: name.trim(), timezone: tz, plan }, { idempotent: true });
      try { await api.post('/api/session/workspace', { workspace_id: r.workspace.id }); } catch { /* already active */ }
      window.location.assign(isFree ? '/overview' : '/settings/workspace/billing?welcome=1');
    } catch (x) { setErr(x); setBusy(false); }
  };
  return (
    <section className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
      <h1 className="text-[22px] font-semibold">Create your workspace</h1>
      <p className="mt-1 text-[13px] text-muted" data-testid="signup-ws-lead">{isFree ? `${selected!.name} for one person. No card needed.` : `Your ${selected?.trial_days ?? 14}-day free trial starts now. No card needed.`}</p>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-5" noValidate>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-medium">Plan</legend>
          <div role="radiogroup" aria-label="Plan" className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-3">
            {ctx.catalogue.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={plan === p.id} onClick={() => setPlan(p.id)} data-testid={`signup-ws-plan-${p.id}`}
                className={cn('touch-target flex flex-col items-start rounded-lg border px-3 py-2 text-left', plan === p.id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-raised')}>
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-xs text-muted tabular">{p.unit_amount_minor === 0 ? `${money(0)} · 1 user` : `then ${money(p.unit_amount_minor)} / user / month`}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <Field label="Workspace name" error={fieldErr}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="organization" maxLength={120} autoFocus placeholder="Northwind Studio" />
        </Field>
        <Field label="Time zone">
          <Select value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </Select>
        </Field>
        {err ? <ErrorNotice error={err} /> : null}
        <Button type="submit" variant="primary" size="lg" loading={busy}>{isFree ? 'Create workspace' : 'Start free trial'}</Button>
      </form>
    </section>
  );
}
