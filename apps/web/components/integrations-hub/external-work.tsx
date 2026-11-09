'use client';
// External work for one Relay item (post, campaign, conversation, case): linked Asana tasks / monday.com items with their
// external status, create (with a preview of exactly what leaves Relay), link existing, refresh, unlink; and for cases
// the HubSpot ticket (one per case). Renders nothing when no task/CRM integration is installed.
import { useMemo, useRef, useState } from 'react';
import { ExternalLink, Link2, Plus, RefreshCw, TicketCheck } from 'lucide-react';
import type { ExternalTaskJson, HubOverviewJson, HubspotTicketJson, OutboundPreviewJson, TaskRelayType } from '@social-lite/core/contracts/v35-integrations';
import type { IntegrationResourceJson } from '@social-lite/core/contracts/v35-connectors';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import { Badge, Banner, Button, Dialog, Field, Input, Select, SimulatedBadge, Textarea, useToast } from '@/components/ui';
import { CONNECTOR_META } from './meta';

const STATUS: Record<string, { label: string; tone: 'success' | 'info' | 'neutral' }> = { done: { label: 'Done', tone: 'success' }, in_progress: { label: 'In progress', tone: 'info' }, open: { label: 'Open', tone: 'neutral' } };
const newKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export function ExternalWork({ relayType, relayId, brandId, title }: { relayType: TaskRelayType; relayId: string; brandId: string; title?: string }) {
  const toast = useToast();
  const hub = useApi<HubOverviewJson>('/api/connectors/hub');
  const tasks = useApi<{ items: ExternalTaskJson[] }>(`/api/connectors/tasks?relay_type=${relayType}&relay_id=${relayId}`, { poll: 20_000 });
  const ticket = useApi<{ link_id: string | null; job: { id: string; state: string; last_error: string | null } | null; ticket: HubspotTicketJson | null }>(relayType === 'case' ? `/api/connectors/hubspot/cases/${relayId}` : null, { poll: 20_000 });
  const installs = useMemo(() => (hub.data?.connectors ?? []).flatMap((c) => c.installations.filter((i) => !i.disconnected_at && i.status !== 'reconnect_required' && (!i.brand_id || i.brand_id === brandId))), [hub.data, brandId]);
  const taskInstalls = installs.filter((i) => i.connector === 'asana' || i.connector === 'monday');
  const hubspot = installs.find((i) => i.connector === 'hubspot');
  const [dialog, setDialog] = useState<'create' | 'link' | 'ticket' | null>(null);
  if (!hub.data || (!taskInstalls.length && !(hubspot && relayType === 'case') && !tasks.data?.items.length)) return null;
  const refreshAll = async () => { await Promise.all([tasks.refetch(), ticket.refetch()]); };
  return (
    <section aria-labelledby={`xw-${relayId}`} data-testid="external-work">
      <h3 id={`xw-${relayId}`} className="mb-2 text-xs font-medium uppercase tracking-[0.06em] text-subtle">{title ?? 'External work'}</h3>
      <ul className="flex flex-col gap-2">
        {(tasks.data?.items ?? []).map((t) => <TaskRow key={t.id} t={t} onChanged={refreshAll} />)}
        {relayType === 'case' && ticket.data?.link_id ? (
          <li className="flex flex-col gap-1 rounded-lg border border-border p-2.5 text-[13px]">
            <div className="flex items-center gap-2"><TicketCheck aria-hidden className="size-4 text-muted" /><span className="min-w-0 flex-1 truncate font-medium">HubSpot ticket</span>
              {ticket.data.ticket?.stage ? <Badge tone="info">{ticket.data.ticket.stage}</Badge> : null}
              {ticket.data.ticket?.url ? <a href={ticket.data.ticket.url} target="_blank" rel="noreferrer noopener" aria-label="Open in HubSpot" className="text-muted hover:text-fg"><ExternalLink aria-hidden className="size-4" /></a> : null}</div>
            {ticket.data.ticket?.fetched_at ? <p className="text-xs text-subtle">Checked {fmtRelative(ticket.data.ticket.fetched_at)}{ticket.data.ticket.owner ? ` · ${ticket.data.ticket.owner}` : ''}</p> : null}
          </li>
        ) : relayType === 'case' && ticket.data?.job && ticket.data.job.state !== 'succeeded' ? (
          <li className="rounded-lg border border-border p-2.5 text-[13px]"><span className="font-medium">HubSpot ticket</span> <Badge tone={ticket.data.job.state === 'failed' ? 'danger' : 'warn'}>{ticket.data.job.state === 'unknown' ? 'Not confirmed' : ticket.data.job.state === 'failed' ? 'Failed' : 'Creating'}</Badge>
            {ticket.data.job.last_error ? <p className="mt-1 text-xs text-muted">{ticket.data.job.last_error}</p> : null}</li>
        ) : null}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        {taskInstalls.length ? <>
          <Button size="sm" variant="secondary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setDialog('create')}>Create task</Button>
          <Button size="sm" variant="ghost" icon={<Link2 aria-hidden className="size-4" />} onClick={() => setDialog('link')}>Link task</Button>
        </> : null}
        {relayType === 'case' && hubspot && !ticket.data?.link_id && !(ticket.data?.job && ['queued', 'running', 'waiting_retry'].includes(ticket.data.job.state)) ? (
          <Button size="sm" variant="ghost" icon={<TicketCheck aria-hidden className="size-4" />} onClick={() => setDialog('ticket')}>HubSpot ticket</Button>
        ) : null}
      </div>
      {dialog === 'create' || dialog === 'link' ? (
        <TaskDialog mode={dialog} relayType={relayType} relayId={relayId} installs={taskInstalls} onClose={() => setDialog(null)} onDone={async () => { setDialog(null); toast.success(dialog === 'create' ? 'Task requested' : 'Task linked'); await refreshAll(); }} />
      ) : null}
      {dialog === 'ticket' && hubspot ? <TicketDialog integrationId={hubspot.id} caseId={relayId} onClose={() => setDialog(null)} onDone={async () => { setDialog(null); toast.success('Ticket requested'); await refreshAll(); }} /> : null}
    </section>
  );
}

function TaskRow({ t, onChanged }: { t: ExternalTaskJson; onChanged: () => Promise<unknown> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const M = CONNECTOR_META[t.connector];
  const s = STATUS[t.status]!;
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border p-2.5 text-[13px]" data-testid="external-task">
      <div className="flex items-center gap-2">
        <M.icon aria-hidden className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
        {t.link_state === 'linked' ? <Badge tone={s.tone}>{s.label}</Badge> : t.link_state === 'pending' ? <Badge tone="info">Creating</Badge> : t.link_state === 'failed' ? <Badge tone="danger">Failed</Badge> : <Badge tone="warn">Unavailable</Badge>}
        {t.is_simulated ? <SimulatedBadge /> : null}
        {t.external_url ? <a href={t.external_url} target="_blank" rel="noreferrer noopener" aria-label={`Open in ${M.name}`} className="text-muted hover:text-fg"><ExternalLink aria-hidden className="size-4" /></a> : null}
      </div>
      <p className="text-xs text-subtle">{M.name}{t.resource_name ? ` · ${t.resource_name}` : ''}{t.external_status ? ` · ${t.external_status}` : ''}{t.due_on ? ` · due ${t.due_on}` : ''}{t.last_pulled_at ? ` · checked ${fmtRelative(t.last_pulled_at)}` : ''}</p>
      {t.link_detail ? <p className="text-xs text-warn">{t.link_detail}</p> : null}
      {t.conflict ? <Banner tone="warn" title="Changed in both places">{Object.entries(t.conflict).map(([f, v]) => `${f}: Relay “${String(v.relay)}”, ${M.name} “${String(v.external)}”`).join(' · ')}</Banner> : null}
      <div className="flex flex-wrap gap-1">
        {t.external_id ? <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden className="size-3.5" />} loading={busy} onClick={async () => { setBusy(true); try { await api.post(`/api/connectors/tasks/${t.id}/refresh`); await onChanged(); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Refresh</Button> : null}
        {t.conflict ? <>
          <Button size="sm" variant="ghost" onClick={async () => { try { await api.patch(`/api/connectors/tasks/${t.id}`, { expected_version: t.version, resolve_conflict: 'take_external' }); await onChanged(); } catch (e) { toast.error(e); } }}>Use {M.name}</Button>
        </> : null}
      </div>
    </li>
  );
}

function TaskDialog({ mode, relayType, relayId, installs, onClose, onDone }: { mode: 'create' | 'link'; relayType: TaskRelayType; relayId: string; installs: HubOverviewJson['connectors'][number]['installations']; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const key = useRef(newKey());
  const [integ, setInteg] = useState(installs[0]!.id);
  const res = useApi<{ items: IntegrationResourceJson[] }>(`/api/connectors/${integ}/resources`);
  const targets = (res.data?.items ?? []).filter((r) => r.selected && (r.resource_type === 'project' || r.resource_type === 'board'));
  const [resource, setResource] = useState('');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState('normal');
  const [desc, setDesc] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const [preview, setPreview] = useState<OutboundPreviewJson | null>(null);
  const [busy, setBusy] = useState(false);
  const rid = resource || targets[0]?.id || '';
  const body = { integration_id: integ, relay_type: relayType, relay_id: relayId, resource_id: rid, title: title.trim(), due_on: due || null, priority, ...(desc !== null ? { description: desc } : {}) };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={mode === 'create' ? 'Create task' : 'Link existing task'} size="lg" footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      {mode === 'create' && !preview ? (
        <Button variant="primary" loading={busy} disabledReason={!rid ? 'Select a project or board in Business apps first' : !title.trim() ? 'Add a title' : null} onClick={async () => {
          setBusy(true); try { const p = await api.post<OutboundPreviewJson>('/api/connectors/tasks/preview', body); setPreview(p); setDesc(p.fields.find((f) => f.label === 'Description')?.value ?? ''); } catch (e) { toast.error(e); } finally { setBusy(false); }
        }}>Review</Button>
      ) : mode === 'create' ? (
        <Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await api.post('/api/connectors/tasks', { ...body, description: desc ?? undefined, idempotency_key: key.current }); await onDone(); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Create</Button>
      ) : (
        <Button variant="primary" loading={busy} disabledReason={!rid ? 'Select a project or board first' : !ref.trim() ? 'Paste a link' : null} onClick={async () => {
          setBusy(true); try { await api.post('/api/connectors/tasks/link', { integration_id: integ, relay_type: relayType, relay_id: relayId, resource_id: rid, external_ref: ref.trim() }); await onDone(); } catch (e) { toast.error(e); } finally { setBusy(false); }
        }}>Link</Button>
      )}
    </>}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Integration"><Select value={integ} onChange={(e) => { setInteg(e.target.value); setResource(''); setPreview(null); }}>{installs.map((i) => <option key={i.id} value={i.id}>{i.display_name}</option>)}</Select></Field>
          <Field label="Project or board"><Select value={rid} onChange={(e) => { setResource(e.target.value); setPreview(null); }}>{targets.length ? targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>) : <option value="">None selected</option>}</Select></Field>
        </div>
        {mode === 'link' ? <Field label="Task link or id"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="https://…" /></Field> : (
          <>
            <Field label="Title"><Input value={title} onChange={(e) => { setTitle(e.target.value); setPreview(null); }} maxLength={255} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Due"><Input type="date" value={due} onChange={(e) => { setDue(e.target.value); setPreview(null); }} /></Field>
              <Field label="Priority"><Select value={priority} onChange={(e) => { setPriority(e.target.value); setPreview(null); }}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></Select></Field>
            </div>
            {preview ? (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-sunken p-3" data-testid="outbound-preview">
                <p className="text-xs font-medium text-muted">Leaves Relay → {preview.destination}</p>
                <Field label="Description"><Textarea rows={4} value={desc ?? ''} onChange={(e) => setDesc(e.target.value)} maxLength={4000} /></Field>
                <p className="text-xs text-muted">Not sent: {preview.excluded.join(', ')}.</p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

function TicketDialog({ integrationId, caseId, onClose, onDone }: { integrationId: string; caseId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [preview, setPreview] = useState<OutboundPreviewJson | null>(null);
  const [busy, setBusy] = useState(false);
  const body = { integration_id: integrationId, case_id: caseId };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="HubSpot ticket" footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      {!preview ? <Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { setPreview(await api.post<OutboundPreviewJson>('/api/connectors/hubspot/tickets/preview', body)); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Review</Button>
        : <Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await api.post('/api/connectors/hubspot/tickets', body); await onDone(); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Create ticket</Button>}
    </>}>
      {preview ? (
        <div className="flex flex-col gap-2" data-testid="outbound-preview">
          <p className="text-xs font-medium text-muted">Leaves Relay → {preview.destination}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">{preview.fields.map((f) => <div key={f.label} className="contents"><dt className="text-muted">{f.label}</dt><dd className="min-w-0 break-words">{f.value}</dd></div>)}</dl>
          <p className="text-xs text-muted">Not sent: {preview.excluded.join(', ')}. One ticket per case.</p>
        </div>
      ) : <p className="text-[13px] text-muted">Relay creates one ticket for this case with a link back. Customer messages stay in Relay.</p>}
    </Dialog>
  );
}
