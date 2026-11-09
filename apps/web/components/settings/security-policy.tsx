'use client';
// Settings → Security (owner only): workspace security policy. Saving needs verified two-step; making anything
// less strict also needs a fresh verification (the API answers step_up_required → verify → back here).
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Button, Card, EmptyState, ErrorNotice, ErrorState, Field, Input, Skeleton, Switch, useToast } from '@/components/ui';

interface Policy { mfa_required_all: boolean; mfa_required_for: string[]; step_up_seconds: number; invite_ttl_hours: number; guest_max_days: number; guest_default_days: number }
interface View { policy: Policy; policy_version: number; roles: string[] }

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', team_manager: 'Team manager', brand_manager: 'Brand manager', editor: 'Editor', approver: 'Approver',
  publisher: 'Publisher', analyst: 'Analyst', viewer: 'Viewer', exporter: 'Exporter', guest: 'Guest', care_agent: 'Care agent',
};

export function SecurityPolicySettings() {
  const { canV2 } = useSession();
  const allowed = canV2('security.manage');
  const { data, error, loading, refetch, setData } = useApi<View>(allowed ? '/api/workspace/security-policy' : null);
  if (!allowed) return <EmptyState icon={<ShieldCheck aria-hidden />} title="Owners only" />;
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Skeleton className="h-64 w-full max-w-2xl rounded-xl" />;
  return <PolicyForm key={data.policy_version} view={data} onSaved={(v) => setData(v)} />;
}

function PolicyForm({ view, onSaved }: { view: View; onSaved: (v: View) => void }) {
  const toast = useToast();
  const [p, setP] = useState<Policy>(view.policy);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const set = (patch: Partial<Policy>) => setP((x) => ({ ...x, ...patch }));
  const changed = JSON.stringify(p) !== JSON.stringify(view.policy);
  const toggleRole = (r: string, on: boolean) => set({ mfa_required_for: on ? [...p.mfa_required_for, r] : p.mfa_required_for.filter((x) => x !== r) });
  const num = (v: string) => (v === '' ? NaN : Number(v));
  const bad = [p.step_up_seconds, p.invite_ttl_hours, p.guest_max_days, p.guest_default_days].some((v) => !Number.isInteger(v));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.put<{ policy: Policy; policy_version: number }>('/api/workspace/security-policy', { ...p, expected_policy_version: view.policy_version });
      onSaved({ ...view, policy: r.policy, policy_version: r.policy_version });
      toast.success('Saved');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <Card className="max-w-2xl" data-testid="security-policy">
      <div className="flex flex-col gap-6 p-4">
        <Switch checked={p.mfa_required_all} onCheckedChange={(v) => set({ mfa_required_all: v })} label="Require two-step for everyone"
          description="Members without it keep reading but can’t do sensitive actions." />
        {!p.mfa_required_all ? (
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Require two-step for</legend>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              {view.roles.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-[18px] accent-[var(--text)]" checked={r === 'owner' || p.mfa_required_for.includes(r)} disabled={r === 'owner'}
                    onChange={(e) => toggleRole(r, e.target.checked)} data-testid={`mfa-role-${r}`} />
                  {ROLE_LABEL[r] ?? r}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Re-verify after (minutes)" info="Sensitive actions ask for a fresh sign-in after this long. 1–60.">
            <Input type="number" inputMode="numeric" min={1} max={60} value={Number.isFinite(p.step_up_seconds) ? Math.round(p.step_up_seconds / 60) : ''}
              onChange={(e) => set({ step_up_seconds: num(e.target.value) * 60 })} data-testid="policy-step-up" />
          </Field>
          <Field label="Invitations expire after (hours)" info="1–720.">
            <Input type="number" inputMode="numeric" min={1} max={720} value={Number.isFinite(p.invite_ttl_hours) ? p.invite_ttl_hours : ''} onChange={(e) => set({ invite_ttl_hours: num(e.target.value) })} />
          </Field>
          <Field label="Guest access, default (days)">
            <Input type="number" inputMode="numeric" min={1} max={365} value={Number.isFinite(p.guest_default_days) ? p.guest_default_days : ''} onChange={(e) => set({ guest_default_days: num(e.target.value) })} />
          </Field>
          <Field label="Guest access, maximum (days)">
            <Input type="number" inputMode="numeric" min={1} max={365} value={Number.isFinite(p.guest_max_days) ? p.guest_max_days : ''} onChange={(e) => set({ guest_max_days: num(e.target.value) })} />
          </Field>
        </div>
        {err ? <ErrorNotice error={err} /> : null}
        <div className="flex gap-2">
          <Button variant="primary" onClick={save} loading={busy} disabled={!changed} disabledReason={bad ? 'Fill in every number.' : null} data-testid="policy-save">Save</Button>
          {changed ? <Button variant="ghost" onClick={() => { setP(view.policy); setErr(null); }} disabled={busy}>Reset</Button> : null}
        </div>
      </div>
    </Card>
  );
}
