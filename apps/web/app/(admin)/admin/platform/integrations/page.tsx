'use client';
// Platform → Integrations: Relay's provider APPS on this installation (credentials present or missing — never their
// values), separate from each customer's account authorization (per connection, in the workspace). "Configured" does
// not mean "fully operational": network review/approval and each customer's permissions are separate.
import { PROVIDER_LABEL, type Provider } from '@social-lite/core';
import { useApi } from '@/lib/client/use-api';
import { Badge, Card, ErrorState, PageHeader, PlatformIcon, SkeletonRows } from '@/components/ui';
import { RecordList } from '@/components/admin/ui';
import type { PlatformIntegration } from '@social-lite/services/admin/platform';

const STATUS = { configured: ['Configured', 'success'], not_configured: ['Not configured', 'warn'], no_app_needed: ['No app needed', 'neutral'], not_available: ['Not available', 'neutral'] } as const;

export default function PlatformIntegrationsPage() {
  const { data, error, loading, refetch } = useApi<{ items: PlatformIntegration[] }>('/api/platform/integrations');
  const label = (i: PlatformIntegration) => (i.kind === 'social' ? PROVIDER_LABEL[i.key as Provider] : i.label);
  return (
    <>
      <PageHeader title="Integrations" />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={8} /> : (
        <Card className="overflow-hidden">
          <RecordList caption="Integration infrastructure" rows={data.items} rowKey={(i) => i.key}
            columns={[
              { key: 'n', label: 'Integration', cell: (i) => <span className="flex items-center gap-2">{i.kind === 'social' ? <PlatformIcon provider={i.key as Provider} size="sm" /> : null}<span className="font-medium">{label(i)}</span></span> },
              { key: 's', label: 'Relay app', cell: (i) => <Badge tone={STATUS[i.status][1]}>{STATUS[i.status][0]}</Badge> },
              { key: 'm', label: 'Missing', cell: (i) => <span className="text-xs text-muted">{i.missing.join(', ') || '—'}</span> },
              { key: 'a', label: 'Accounts', cell: (i) => i.live_accounts === null ? <span className="text-subtle">—</span> : <span className="tabular">{i.live_accounts} live{i.simulated_accounts ? ` · ${i.simulated_accounts} sim` : ''}</span> },
              { key: 'x', label: 'Note', secondary: true, cell: (i) => <span className="text-xs text-muted">{i.note ?? ''}</span> },
            ]}
            card={(i) => <span className="flex flex-col gap-1"><span className="flex items-center gap-2"><span className="min-w-0 flex-1 font-medium">{label(i)}</span><Badge tone={STATUS[i.status][1]}>{STATUS[i.status][0]}</Badge></span>{i.missing.length ? <span className="text-xs text-muted">Missing: {i.missing.join(', ')}</span> : null}</span>} />
        </Card>
      )}
      <p className="mt-4 text-xs text-muted">Keys are entered in Instance setup or the server environment. Secrets are never shown.</p>
    </>
  );
}
