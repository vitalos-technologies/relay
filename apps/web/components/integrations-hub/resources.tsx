'use client';
// Explicit resource selection: Relay lists what the provider offers (on request) and saves only what a person ticks.
import { useState } from 'react';
import { Download } from 'lucide-react';
import type { AvailableResourceJson, HubConnector } from '@social-lite/core/contracts/v35-integrations';
import type { IntegrationConnectionJson, IntegrationResourceJson } from '@social-lite/core/contracts/v35-connectors';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Segmented, SkeletonRows, useToast } from '@/components/ui';
import { CONNECTOR_META } from './meta';

export function ResourcesPanel({ integration, connector, canManage }: { integration: IntegrationConnectionJson; connector: HubConnector; canManage: boolean }) {
  const toast = useToast();
  const types = CONNECTOR_META[connector].resources;
  const [type, setType] = useState(types[0]![0]);
  const saved = useApi<{ items: IntegrationResourceJson[] }>(`/api/connectors/${integration.id}/resources`);
  const [avail, setAvail] = useState<AvailableResourceJson[] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    setBusy('load');
    try {
      const r = await api.get<{ items: AvailableResourceJson[] }>(`/api/connectors/hub/${integration.id}/discover`, { type });
      setAvail(r.items); setPicked(Object.fromEntries(r.items.map((x) => [x.external_id, x.selected])));
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const save = async () => {
    if (!avail) return;
    setBusy('save');
    try {
      await api.put(`/api/connectors/${integration.id}/resources`, { resources: avail.map((x) => ({ resource_type: x.resource_type, external_id: x.external_id, name: x.name.slice(0, 200), url: x.url, selected: !!picked[x.external_id] })) });
      toast.success('Selection saved'); setAvail(null); await saved.refetch();
    } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  const mine = (saved.data?.items ?? []).filter((r) => r.resource_type === type);
  return (
    <Card aria-labelledby="h-res">
      <CardHeader id="h-res" title="Resources" actions={canManage && !avail ? <Button size="sm" variant="secondary" icon={<Download aria-hidden className="size-4" />} loading={busy === 'load'} disabledReason={integration.status === 'reconnect_required' ? 'Reconnect first' : null} onClick={load}>Choose</Button> : undefined} />
      <div className="flex flex-col gap-3 px-4 pb-4">
        {types.length > 1 ? <Segmented label="Type" value={type} onChange={(v) => { setType(v); setAvail(null); }} options={types.map(([v, l]) => ({ value: v, label: l }))} /> : null}
        {avail ? (
          <>
            {!avail.length ? <EmptyState compact title="Nothing available" /> : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {avail.map((x) => (
                  <li key={x.external_id} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox label={x.name} checked={!!picked[x.external_id]} onChange={(e) => setPicked({ ...picked, [x.external_id]: e.target.checked })} />
                    {x.detail ? <span className="ml-auto truncate text-xs text-muted">{x.detail.includes('|') ? `${x.detail.split('|').length} stages` : x.detail}</span> : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2"><Button variant="primary" loading={busy === 'save'} onClick={save}>Save selection</Button><Button variant="ghost" onClick={() => setAvail(null)}>Cancel</Button></div>
          </>
        ) : saved.error ? <ErrorState error={saved.error} onRetry={saved.refetch} /> : !saved.data ? <SkeletonRows rows={2} /> : !mine.filter((r) => r.selected).length ? (
          <EmptyState compact title="Nothing selected" />
        ) : (
          <ul className="divide-y divide-border" data-testid="selected-resources">
            {mine.filter((r) => r.selected).map((r) => (
              <li key={r.id} className="flex items-center gap-2 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                {r.access_state === 'unavailable' ? <Badge tone="warn">Unavailable</Badge> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
