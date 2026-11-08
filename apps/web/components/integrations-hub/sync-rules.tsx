'use client';
// Synchronization contract (source of truth, direction, deletion, revocation) + explicit field mappings for Asana /
// monday.com. Two-way sync only for fields someone mapped two-way; protected fields are refused by the server.
import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { AvailableResourceJson, HubConnector } from '@social-lite/core/contracts/v35-integrations';
import type { FieldMapping, IntegrationConnectionJson, IntegrationResourceJson } from '@social-lite/core/contracts/v35-connectors';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Th, THead, Tr, useToast } from '@/components/ui';
import { CONNECTOR_META } from './meta';

const DIRECTION: Record<string, string> = { relay_to_external: 'Relay → external', external_to_relay: 'External → Relay', two_way: 'Two-way' };
const CONFLICT: Record<string, string> = { manual_review: 'Ask a person', source_wins: 'Source of truth wins', skip: 'Skip' };

export function SyncRulesPanel({ integration, connector, canManage }: { integration: IntegrationConnectionJson; connector: HubConnector; canManage: boolean }) {
  const M = CONNECTOR_META[connector];
  const mappable = connector === 'asana' || connector === 'monday';
  return (
    <div className="flex flex-col gap-6">
      <Card aria-labelledby="h-contract">
        <CardHeader id="h-contract" title="Sync contract" />
        <div className="overflow-x-auto px-1 pb-2">
          <Table caption="Synchronization contract">
            <THead><Tr><Th>Field</Th><Th>Source of truth</Th><Th>Direction</Th><Th>If deleted</Th><Th>If access is revoked</Th></Tr></THead>
            <tbody>{M.contract.map((r) => <Tr key={r[0]}>{r.map((c, i) => <Td key={i} className={i === 0 ? 'font-medium' : undefined}>{c}</Td>)}</Tr>)}</tbody>
          </Table>
        </div>
      </Card>
      {mappable ? <MappingsCard integration={integration} connector={connector} canManage={canManage} /> : null}
    </div>
  );
}

function MappingsCard({ integration, connector, canManage }: { integration: IntegrationConnectionJson; connector: 'asana' | 'monday'; canManage: boolean }) {
  const toast = useToast();
  const maps = useApi<{ items: FieldMapping[] }>(`/api/connectors/${integration.id}/mappings`);
  const res = useApi<{ items: IntegrationResourceJson[] }>(`/api/connectors/${integration.id}/resources`);
  const [edit, setEdit] = useState<{ resource_id: string; relay_field: string; external_field: string; direction: string; conflict: string } | null>(null);
  const [cols, setCols] = useState<AvailableResourceJson[] | null>(null);
  const boards = (res.data?.items ?? []).filter((r) => r.selected && (r.resource_type === 'board' || r.resource_type === 'project'));
  const resName = (id: string | null) => (id ? boards.find((b) => b.id === id)?.name ?? 'Board' : 'All');
  const loadCols = async (resourceId: string) => {
    setCols(null);
    if (connector !== 'monday' || !resourceId) return;
    const b = boards.find((x) => x.id === resourceId);
    try { setCols((await api.get<{ items: AvailableResourceJson[] }>(`/api/connectors/hub/${integration.id}/discover`, { type: 'column', parent: b?.external_id ?? '' })).items); } catch (e) { toast.error(e); }
  };
  return (
    <Card aria-labelledby="h-maps">
      <CardHeader id="h-maps" title="Field mappings" actions={canManage ? <Button size="sm" variant="secondary" icon={<Plus aria-hidden className="size-4" />}
        onClick={() => { const r = connector === 'monday' ? boards[0]?.id ?? '' : ''; setEdit({ resource_id: r, relay_field: 'status', external_field: connector === 'asana' ? 'completed' : '', direction: 'relay_to_external', conflict: 'manual_review' }); void loadCols(r); }}>Add</Button> : undefined} />
      {!maps.data?.items.length ? <p className="px-4 pb-4 text-[13px] text-muted">No mappings: every field flows Relay → {connector === 'asana' ? 'Asana' : 'monday.com'} only.</p> : (
        <div className="overflow-x-auto px-1 pb-2">
          <Table caption="Field mappings">
            <THead><Tr><Th>Relay field</Th><Th>External field</Th><Th>Applies to</Th><Th>Direction</Th><Th>Conflicts</Th></Tr></THead>
            <tbody>{maps.data.items.map((m) => (
              <Tr key={m.id}>
                <Td className="font-medium">{m.relay_field}{m.protected ? <Badge tone="neutral" className="ml-2">Protected</Badge> : null}</Td>
                <Td><code className="text-xs">{m.external_field}</code></Td><Td>{resName(m.resource_id)}</Td><Td>{DIRECTION[m.direction]}</Td><Td>{CONFLICT[m.conflict]}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        </div>
      )}
      {edit ? (
        <Dialog open onOpenChange={(o) => !o && setEdit(null)} title="Field mapping" footer={<>
          <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
          <Button variant="primary" disabledReason={!edit.external_field ? 'Choose the external field' : null} onClick={async () => {
            try {
              await api.put(`/api/connectors/${integration.id}/mappings`, { resource_id: edit.resource_id || null, relay_object: 'task', relay_field: edit.relay_field, external_field: edit.external_field,
                source_of_truth: edit.direction === 'external_to_relay' ? 'external' : 'relay', direction: edit.direction, conflict: edit.conflict, on_delete: 'mark_unavailable', on_revoke: 'mark_unavailable', enabled: true });
              toast.success('Mapping saved'); setEdit(null); await maps.refetch();
            } catch (e) { toast.error(e); }
          }}>Save</Button>
        </>}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {connector === 'monday' ? (
              <Field label="Board"><Select value={edit.resource_id} onChange={(e) => { setEdit({ ...edit, resource_id: e.target.value }); void loadCols(e.target.value); }}>{boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            ) : null}
            <Field label="Relay field"><Select value={edit.relay_field} onChange={(e) => setEdit({ ...edit, relay_field: e.target.value, external_field: connector === 'asana' ? ({ status: 'completed', title: 'name', due_on: 'due_on', priority: 'notes' } as Record<string, string>)[e.target.value]! : edit.external_field })}>
              <option value="status">Status</option><option value="title">Title</option><option value="due_on">Due date</option><option value="priority">Priority</option></Select></Field>
            <Field label={connector === 'monday' ? 'Column' : 'Asana field'}>
              {connector === 'monday' && cols ? (
                <Select value={edit.external_field} onChange={(e) => setEdit({ ...edit, external_field: e.target.value })}><option value="">Choose…</option>{cols.map((c) => <option key={c.external_id} value={c.external_id}>{c.name} ({c.detail})</option>)}</Select>
              ) : <Input value={edit.external_field} readOnly={connector === 'asana'} onChange={(e) => setEdit({ ...edit, external_field: e.target.value })} />}
            </Field>
            <Field label="Direction"><Select value={edit.direction} onChange={(e) => setEdit({ ...edit, direction: e.target.value })} disabled={edit.relay_field === 'priority'}>
              <option value="relay_to_external">Relay → external</option><option value="two_way">Two-way</option><option value="external_to_relay">External → Relay</option></Select></Field>
            <Field label="When both changed"><Select value={edit.conflict} onChange={(e) => setEdit({ ...edit, conflict: e.target.value })}>
              <option value="manual_review">Ask a person</option><option value="source_wins">Source of truth wins</option><option value="skip">Skip</option></Select></Field>
          </div>
        </Dialog>
      ) : null}
    </Card>
  );
}
