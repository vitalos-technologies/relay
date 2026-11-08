'use client';
// Connector-specific settings: Slack channel alerts + delivery history + linked people; Translation workspace control
// + usage/cost estimate; Google location metrics; HubSpot ticket defaults; Mailchimp webhook URL; Asana/monday updates.
import { useState } from 'react';
import { BellRing, Copy, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  SLACK_CATEGORIES, SLACK_PRIVATE_ONLY, type AvailableResourceJson, type HubConnector, type SlackCategory, type SlackDeliveryJson, type SlackRouteJson, type TranslationSettingsJson,
} from '@social-lite/core/contracts/v35-integrations';
import type { IntegrationConnectionJson, IntegrationResourceJson } from '@social-lite/core/contracts/v35-connectors';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { fmtNumber, fmtRelative } from '@/lib/client/format';
import {
  Badge, Banner, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, ErrorState, Facts, Field, Input, Select, SkeletonRows, Switch, Table, Td, Th, THead, Tr, useToast,
} from '@/components/ui';

/** Every hub connector has a settings tab (alerts, workspace control, metrics, defaults, webhooks). */
export const hasConnectorSettings = (c: HubConnector) => !!c;

export function ConnectorSettingsPanel({ integration, connector, canManage }: { integration: IntegrationConnectionJson; connector: HubConnector; canManage: boolean }) {
  switch (connector) {
    case 'slack': return <SlackSettings integration={integration} canManage={canManage} />;
    case 'google_translate': return <TranslationSettings />;
    case 'google_business_profile': return <GbpSettings integration={integration} />;
    case 'hubspot': return <HubspotSettings integration={integration} canManage={canManage} />;
    case 'mailchimp': return <MailchimpSettings integration={integration} canManage={canManage} />;
    default: return <TaskUpdatesSettings integration={integration} canManage={canManage} />;
  }
}

// ------------------------------------------------------------------ Slack
const CAT_LABEL: Record<SlackCategory, string> = {
  approvals: 'Approval requests', assignments: 'Assignments', connection_alerts: 'Connection alerts', delivery_alerts: 'Publishing alerts', care_escalations: 'Care escalations',
  listening_alerts: 'Listening alerts', summaries: 'Daily summary',
};
const DSTATE: Record<string, 'success' | 'warn' | 'danger' | 'neutral' | 'info'> = { sent: 'success', queued: 'info', sending: 'info', deferred: 'warn', failed: 'danger', unknown: 'warn', suppressed: 'neutral' };

function SlackSettings({ integration, canManage }: { integration: IntegrationConnectionJson; canManage: boolean }) {
  const toast = useToast();
  const { session } = useSession();
  const routes = useApi<{ items: SlackRouteJson[] }>(`/api/connectors/slack/routes?integration_id=${integration.id}`);
  const del = useApi<{ items: SlackDeliveryJson[] }>(`/api/connectors/slack/deliveries?integration_id=${integration.id}`, { poll: 15_000 });
  const links = useApi<{ items: Array<{ id: string; slack_user_id: string; name: string | null; email: string; linked_at: string; is_me: boolean }> }>(`/api/connectors/slack/links?integration_id=${integration.id}`);
  const res = useApi<{ items: IntegrationResourceJson[] }>(`/api/connectors/${integration.id}/resources`);
  const channels = (res.data?.items ?? []).filter((r) => r.selected && r.resource_type === 'channel');
  const [edit, setEdit] = useState<(Omit<SlackRouteJson, 'id' | 'integration_id' | 'channel_name' | 'channel_private'> & { id?: string }) | null>(null);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return (
    <div className="flex flex-col gap-6">
      <Card aria-labelledby="h-routes">
        <CardHeader id="h-routes" title="Channel alerts" actions={canManage ? <Button size="sm" variant="secondary" icon={<Plus aria-hidden className="size-4" />} disabledReason={!channels.length ? 'Select channels under Resources first' : null}
          onClick={() => setEdit({ resource_id: channels[0]?.id ?? '', categories: ['approvals'], brand_ids: null, quiet_start: null, quiet_end: null, timezone: tz, max_per_hour: 20, summary_time: null, enabled: true })}>Add</Button> : undefined} />
        {routes.error ? <ErrorState error={routes.error} onRetry={routes.refetch} /> : !routes.data ? <SkeletonRows rows={2} className="p-4" /> : !routes.data.items.length ? <EmptyState compact title="No channel alerts yet" /> : (
          <ul className="divide-y divide-border" data-testid="slack-routes">
            {routes.data.items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium">{r.channel_name}<Badge tone="neutral">{r.channel_private ? 'Private' : 'Public'}</Badge>{!r.enabled ? <Badge tone="neutral">Off</Badge> : null}</p>
                  <p className="text-xs text-muted">{r.categories.map((c) => CAT_LABEL[c]).join(' · ')}{r.quiet_start ? ` · quiet ${r.quiet_start}–${r.quiet_end} ${r.timezone}` : ''} · max {r.max_per_hour}/h</p>
                </div>
                {canManage ? <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEdit({ ...r })}>Edit</Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${r.channel_name}`} icon={<Trash2 aria-hidden className="size-4" />} onClick={async () => { try { await api.del(`/api/connectors/slack/routes/${r.id}`); await routes.refetch(); } catch (e) { toast.error(e); } }}>{''}</Button>
                </div> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card aria-labelledby="h-del">
        <CardHeader id="h-del" title="Delivery history" />
        {!del.data ? <SkeletonRows rows={3} className="p-4" /> : !del.data.items.length ? <EmptyState compact title="Nothing sent yet" /> : (
          <ul className="divide-y divide-border" data-testid="slack-deliveries">
            {del.data.items.slice(0, 30).map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px]">
                <Badge tone={DSTATE[d.state] ?? 'neutral'}>{d.state === 'unknown' ? 'Not confirmed' : d.state[0]!.toUpperCase() + d.state.slice(1)}</Badge>
                <span className="min-w-0 flex-1 truncate">{d.text}</span>
                <span className="text-xs text-muted">{d.channel_name} · {fmtRelative(d.sent_at ?? d.created_at)}{d.state_detail ? ` · ${d.state_detail}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card aria-labelledby="h-people">
        <CardHeader id="h-people" title="Linked people" />
        {!links.data?.items.length ? <p className="px-4 pb-4 text-[13px] text-muted">People link their Slack account the first time they press a Slack button.</p> : (
          <ul className="divide-y divide-border">
            {links.data.items.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{l.name ?? l.email}</span><code className="text-xs text-muted">{l.slack_user_id}</code>
                {canManage || l.is_me ? <Button size="sm" variant="ghost" onClick={async () => { try { await api.del(`/api/connectors/slack/links/${l.id}`); await links.refetch(); } catch (e) { toast.error(e); } }}>Unlink</Button> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {edit ? (
        <Dialog open onOpenChange={(o) => !o && setEdit(null)} title="Channel alerts" size="lg" footer={<>
          <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
          <Button variant="primary" disabledReason={!edit.categories.length ? 'Choose at least one alert' : null} onClick={async () => {
            try { const rest = { ...edit }; delete rest.id; await api.post('/api/connectors/slack/routes', { integration_id: integration.id, ...rest }); toast.success('Saved'); setEdit(null); await routes.refetch(); } catch (e) { toast.error(e); }
          }}>Save</Button>
        </>}>
          <div className="flex flex-col gap-4">
            <Field label="Channel"><Select value={edit.resource_id} onChange={(e) => setEdit({ ...edit, resource_id: e.target.value })}>{channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <legend className="mb-1 text-[13px] font-medium">Alerts</legend>
              {SLACK_CATEGORIES.map((c) => (
                <Checkbox key={c} label={CAT_LABEL[c]} description={SLACK_PRIVATE_ONLY.includes(c) ? 'Private channels only' : undefined} checked={edit.categories.includes(c)}
                  onChange={(e) => setEdit({ ...edit, categories: e.target.checked ? [...edit.categories, c] : edit.categories.filter((x) => x !== c) })} />
              ))}
            </fieldset>
            <Field label="Brands"><Select value={edit.brand_ids?.[0] ?? ''} onChange={(e) => setEdit({ ...edit, brand_ids: e.target.value ? [e.target.value] : null })}>
              <option value="">All brands</option>{session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Quiet from"><Input type="time" value={edit.quiet_start ?? ''} onChange={(e) => setEdit({ ...edit, quiet_start: e.target.value || null })} /></Field>
              <Field label="Quiet until"><Input type="time" value={edit.quiet_end ?? ''} onChange={(e) => setEdit({ ...edit, quiet_end: e.target.value || null })} /></Field>
              <Field label="Max per hour"><Input type="number" min={1} max={200} value={edit.max_per_hour} onChange={(e) => setEdit({ ...edit, max_per_hour: Number(e.target.value) || 1 })} /></Field>
              <Field label="Summary at"><Input type="time" value={edit.summary_time ?? ''} disabled={!edit.categories.includes('summaries')} onChange={(e) => setEdit({ ...edit, summary_time: e.target.value || null })} /></Field>
            </div>
            <Field label="Time zone"><Input value={edit.timezone} onChange={(e) => setEdit({ ...edit, timezone: e.target.value })} /></Field>
            <Switch checked={edit.enabled} onCheckedChange={(v) => setEdit({ ...edit, enabled: v })} label="On" />
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ Translation
export function TranslationSettings() {
  const toast = useToast();
  const s = useApi<TranslationSettingsJson>('/api/connectors/translate/settings');
  const [form, setForm] = useState<{ enabled: boolean; allow_customer_content: boolean; monthly_char_cap: number; glossary_id: string | null; ack: boolean } | null>(null);
  if (s.error) return <ErrorState error={s.error} onRetry={s.refetch} />;
  if (!s.data) return <SkeletonRows rows={4} />;
  const d = s.data;
  const f = form ?? { enabled: d.enabled, allow_customer_content: d.allow_customer_content, monthly_char_cap: d.monthly_char_cap, glossary_id: d.glossary_id, ack: !!d.billing_acknowledged_at };
  const set = (p: Partial<typeof f>) => setForm({ ...f, ...p });
  const pct = Math.min(100, Math.round((d.usage.month_characters / d.monthly_char_cap) * 100));
  return (
    <div className="flex flex-col gap-6" data-testid="translation-settings">
      <Card aria-labelledby="h-tr">
        <CardHeader id="h-tr" title="Workspace control" actions={<Badge tone={d.enabled ? 'success' : 'neutral'}>{d.enabled ? 'On' : 'Off'}</Badge>} />
        <div className="flex flex-col gap-4 px-4 pb-4">
          {!d.connected ? <Banner tone="info" title="Connect Cloud Translation first" /> : null}
          <Switch checked={f.enabled} disabled={!d.can_manage || !d.connected} onCheckedChange={(v) => set({ enabled: v })} label="Allow translation in this workspace" />
          <Switch checked={f.allow_customer_content} disabled={!d.can_manage} onCheckedChange={(v) => set({ allow_customer_content: v })} label="Include customer messages and reply drafts" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Monthly limit (characters)"><Input type="number" min={1000} value={f.monthly_char_cap} disabled={!d.can_manage} onChange={(e) => set({ monthly_char_cap: Number(e.target.value) || 1000 })} /></Field>
            <Field label="Glossary"><Input value={f.glossary_id ?? ''} placeholder="None" disabled={!d.can_manage} onChange={(e) => set({ glossary_id: e.target.value.trim() || null })} /></Field>
          </div>
          {!d.billing_acknowledged_at ? (
            <Checkbox label={`I understand translation is billed per character by Google (about $${d.price_per_million_usd} per million at list price).`} checked={f.ack} disabled={!d.can_manage} onChange={(e) => set({ ack: e.target.checked })} />
          ) : null}
          {d.can_manage ? <div><Button variant="primary" disabledReason={f.enabled && !f.ack ? 'Confirm the billing note' : null} onClick={async () => {
            try { await api.put('/api/connectors/translate/settings', { enabled: f.enabled, allow_customer_content: f.allow_customer_content, monthly_char_cap: f.monthly_char_cap, glossary_id: f.glossary_id, ...(f.ack && !d.billing_acknowledged_at ? { acknowledge_billing: true } : {}) }); toast.success('Saved'); setForm(null); await s.refetch(); } catch (e) { toast.error(e); }
          }}>Save</Button></div> : null}
        </div>
      </Card>
      <Card aria-labelledby="h-usage">
        <CardHeader id="h-usage" title="This month" />
        <div className="flex flex-col gap-3 px-4 pb-4">
          <div aria-hidden className="h-2 overflow-hidden rounded-full bg-raised"><div className="h-full bg-accent" style={{ width: `${pct}%` }} /></div>
          <Facts items={[
            ['Characters', `${fmtNumber(d.usage.month_characters)} of ${fmtNumber(d.monthly_char_cap)}`],
            ['Estimated cost', `$${d.usage.month_cost_estimate_usd.toFixed(2)} (list price $${d.price_per_million_usd}/million, checked ${d.price_checked_on}; free tier not subtracted)`],
            ['Requests', fmtNumber(d.usage.month_requests)], ['Failures (30 days)', fmtNumber(d.usage.failures_30d)],
          ]} />
          <p className="text-xs text-muted">Machine translation can be wrong. Translations are labelled and never replace the original or send anything.</p>
        </div>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Google Business Profile
function GbpSettings({ integration }: { integration: IntegrationConnectionJson }) {
  const toast = useToast();
  const m = useApi<{ items: Array<{ resource_id: string; name: string; metrics: Record<string, number> | null; fetched_at: string | null; days: number }> }>(`/api/connectors/gbp/metrics/${integration.id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const LABEL: Record<string, string> = { BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'Search views (desktop)', BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'Search views (mobile)', CALL_CLICKS: 'Calls', WEBSITE_CLICKS: 'Website clicks', BUSINESS_DIRECTION_REQUESTS: 'Directions' };
  return (
    <Card aria-labelledby="h-gbp">
      <CardHeader id="h-gbp" title="Location metrics (28 days)" />
      {!m.data ? <SkeletonRows rows={3} className="p-4" /> : !m.data.items.length ? <EmptyState compact title="Select locations under Resources" /> : (
        <ul className="divide-y divide-border">
          {m.data.items.map((l) => (
            <li key={l.resource_id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[14px] font-medium">{l.name}</span>
                <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden className="size-4" />} loading={busy === l.resource_id} onClick={async () => { setBusy(l.resource_id); try { await api.post(`/api/connectors/gbp/locations/${l.resource_id}/metrics`); await m.refetch(); } catch (e) { toast.error(e); } finally { setBusy(null); } }}>Refresh</Button></div>
              {l.metrics ? <p className="text-xs text-muted">{Object.entries(l.metrics).map(([k, v]) => `${LABEL[k] ?? k} ${fmtNumber(v)}`).join(' · ')} · {l.fetched_at ? fmtRelative(l.fetched_at) : ''}</p> : <p className="text-xs text-muted">Not loaded yet</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="px-4 pb-4 text-xs text-muted">Reviews arrive in the Inbox. Business Profile chat ended in 2024 and is not offered.</p>
    </Card>
  );
}

// ------------------------------------------------------------------ HubSpot
function HubspotSettings({ integration, canManage }: { integration: IntegrationConnectionJson; canManage: boolean }) {
  const toast = useToast();
  const [pipes, setPipes] = useState<AvailableResourceJson[] | null>(null);
  const [pipe, setPipe] = useState(''); const [stage, setStage] = useState('');
  const stages = (pipes?.find((p) => p.external_id === pipe)?.detail ?? '').split('|').filter(Boolean).map((s) => { const [id, ...l] = s.split(':'); return { id: id!, label: l.join(':') }; });
  return (
    <Card aria-labelledby="h-hs">
      <CardHeader id="h-hs" title="Ticket defaults" />
      <div className="flex flex-wrap items-end gap-3 px-4 pb-4">
        {!pipes ? <Button variant="secondary" disabledReason={!canManage ? 'Integration managers only' : null} onClick={async () => { try { const r = await api.get<{ items: AvailableResourceJson[] }>(`/api/connectors/hub/${integration.id}/discover`, { type: 'pipeline' }); setPipes(r.items); setPipe(r.items[0]?.external_id ?? ''); } catch (e) { toast.error(e); } }}>Choose pipeline</Button> : <>
          <Field label="Pipeline" className="w-full sm:w-56"><Select value={pipe} onChange={(e) => { setPipe(e.target.value); setStage(''); }}>{pipes.map((p) => <option key={p.external_id} value={p.external_id}>{p.name}</option>)}</Select></Field>
          <Field label="New tickets start in" className="w-full sm:w-56"><Select value={stage} onChange={(e) => setStage(e.target.value)}><option value="">Choose…</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></Field>
          <Button variant="primary" disabledReason={!stage ? 'Choose a stage' : null} onClick={async () => { try { await api.put(`/api/connectors/hub/${integration.id}/hubspot-defaults`, { default_pipeline: pipe, default_stage: stage }); toast.success('Saved'); } catch (e) { toast.error(e); } }}>Save</Button>
        </>}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ Mailchimp
function MailchimpSettings({ integration, canManage }: { integration: IntegrationConnectionJson; canManage: boolean }) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  return (
    <Card aria-labelledby="h-mc">
      <CardHeader id="h-mc" title="Webhook" />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="text-[13px] text-muted">Relay never sends campaigns or changes audiences. Drafts are created from approved posts; send them in Mailchimp.</p>
        {url ? (
          <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all rounded bg-raised p-2 text-xs">{url}</code>
            <Button size="sm" variant="ghost" icon={<Copy aria-hidden className="size-4" />} onClick={() => { void navigator.clipboard?.writeText(url); toast.success('Copied'); }}>Copy</Button></div>
        ) : canManage ? <div><Button variant="secondary" onClick={async () => { try { setUrl((await api.post<{ url: string }>(`/api/connectors/hub/${integration.id}/webhook`)).url); } catch (e) { toast.error(e); } }}>Create webhook URL</Button></div> : null}
        {url ? <p className="text-xs text-warn">Shown once. Creating a new URL replaces it.</p> : null}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ Asana / monday.com
function TaskUpdatesSettings({ integration, canManage }: { integration: IntegrationConnectionJson; canManage: boolean }) {
  const toast = useToast();
  const res = useApi<{ items: IntegrationResourceJson[] }>(`/api/connectors/${integration.id}/resources`);
  const list = (res.data?.items ?? []).filter((r) => r.selected && (r.resource_type === 'project' || r.resource_type === 'board'));
  return (
    <Card aria-labelledby="h-upd">
      <CardHeader id="h-upd" title="Updates from the provider" />
      <p className="px-4 text-[13px] text-muted">Relay checks linked tasks every few minutes. Webhooks make updates near-instant.</p>
      {!list.length ? <EmptyState compact title="Select projects or boards under Resources" /> : (
        <Table caption="Webhooks">
          <THead><Tr><Th>Name</Th><Th><span className="sr-only">Action</span></Th></Tr></THead>
          <tbody>{list.map((r) => (
            <Tr key={r.id}><Td>{r.name}</Td><Td>{canManage ? <Button size="sm" variant="ghost" icon={<BellRing aria-hidden className="size-4" />} onClick={async () => {
              try { await api.post(`/api/connectors/hub/${integration.id}/webhook`, { resource_id: r.id }); toast.success('Receiving updates'); } catch (e) { toast.error(e); }
            }}>Receive updates</Button> : null}</Td></Tr>
          ))}</tbody>
        </Table>
      )}
    </Card>
  );
}
