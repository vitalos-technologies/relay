'use client';
// Settings → Integrations (owner): bind TipSignal to one brand. V2: events create drafts as the TipSignal SERVICE
// ACCOUNT (create drafts only, on that brand); the owner is its named owner. Signing secret: status only.
import { useState, type ReactNode } from 'react';
import { KeyRound, Plug } from 'lucide-react';
import { useApi } from '@/lib/client/use-api';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorNotice, ErrorState, Facts, Field, InfoTip, LinkButton, Select, Skeleton, TimeWithZone, useToast } from '@/components/ui';

interface BindingView {
  binding: {
    brand_id: string; brand_name: string; created_at: string;
    service_account: { id: string; name: string; owner_user_id: string; owner_email: string; owner_name: string | null; last_used_at: string | null; active: boolean; permissions: string[] };
  } | null;
  bound_elsewhere: boolean;
  signing_secret: { is_set: boolean; source: 'env' | 'setup' | null };
  endpoint: string;
  brands: Array<{ id: string; name: string }>;
}

export function IntegrationsSettings() {
  const { can, session } = useSession();
  const toast = useToast();
  const { data, error, loading, refetch, setData } = useApi<BindingView>(can('setup.manage') ? '/api/integrations/tipsignal/binding' : null);
  const [picked, setBrandId] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [unbindOpen, setUnbindOpen] = useState(false);
  // Until the owner picks one, the selection follows the current binding (or the first brand).
  const brandId = picked || data?.binding?.brand_id || data?.brands[0]?.id || '';

  if (!can('setup.manage')) return <EmptyState icon={<Plug aria-hidden />} title="Owner only" />;
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Skeleton className="h-64 w-full max-w-2xl rounded-xl" />;
  const changed = !data.binding || data.binding.brand_id !== brandId;
  const tz = session.workspace?.timezone ?? 'Europe/London';

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      setData(await api.put<BindingView>('/api/integrations/tipsignal/binding', { brand_id: brandId }));
      toast.success('TipSignal bound');
    } catch (e) {
      setSaveErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="max-w-2xl">
      <CardHeader
        title={<span className="flex items-center gap-1">TipSignal <InfoTip>Signed events create drafts in one brand. Nothing is published automatically.</InfoTip></span>}
        actions={data.binding ? <Badge tone="success">Bound</Badge> : <Badge>Not bound</Badge>}
      />
      <div className="flex flex-col gap-6 p-4">
        <Facts items={[
          ['Signing secret', <span key="s" className="inline-flex items-center gap-2">
            <KeyRound aria-hidden className="size-4 text-muted" />
            {data.signing_secret.is_set ? <Badge tone="success">Set{data.signing_secret.source === 'env' ? ' · env' : ''}</Badge> : <Badge tone="warn">Not set</Badge>}
            {!data.signing_secret.is_set ? <LinkButton href="/setup" size="sm" variant="ghost">Setup</LinkButton> : null}
          </span>],
          ['Endpoint', <code key="e" className="font-mono text-[12px]">{data.endpoint}</code>],
          ...(data.binding ? [
            ['Drafts by', <span key="sa" className="inline-flex flex-wrap items-center gap-2" data-testid="tipsignal-service-account">
              <Badge tone="neutral">Service account</Badge>{data.binding.service_account.name}
              <span className="text-muted">· {data.binding.service_account.permissions.join(', ')} · owner {data.binding.service_account.owner_name ?? data.binding.service_account.owner_email}</span>
            </span>] as [string, ReactNode],
            ['Since', <TimeWithZone key="t" instant={data.binding.created_at} tz={tz} format="date" />] as [string, ReactNode],
          ] : []),
        ]} />
        {data.bound_elsewhere ? (
          <p className="text-[13px] text-warn">Bound to another workspace on this installation.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Brand" info="Events create drafts here only. The TipSignal service account cannot publish or read other content.">
              <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                {data.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
          </div>
        )}
        {saveErr ? <ErrorNotice error={saveErr} /> : null}
        {!data.bound_elsewhere ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={save} loading={busy} disabled={!changed} disabledReason={!brandId ? 'Choose a brand.' : null}>
              {data.binding ? 'Save' : 'Bind'}
            </Button>
            {data.binding ? <Button variant="quiet" onClick={() => setUnbindOpen(true)}>Unbind</Button> : null}
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={unbindOpen}
        onOpenChange={setUnbindOpen}
        title="Unbind TipSignal?"
        description="New events will be refused. Existing drafts stay."
        confirmLabel="Unbind"
        confirmVariant="danger"
        onConfirm={async () => { setData(await api.del<BindingView>('/api/integrations/tipsignal/binding')); toast.success('Unbound'); }}
      />
    </Card>
  );
}
