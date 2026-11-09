'use client';
// Post → business integrations (shown in the composer when any is installed for the brand):
//  - Google Business Profile local posts for chosen locations, following this post's schedule + approval;
//  - Mailchimp draft campaign from the approved text (never sent, nobody subscribed);
//  - external tasks (Asana / monday.com).
import { useMemo, useState } from 'react';
import { ExternalLink, Mail, RefreshCw, Store } from 'lucide-react';
import { GBP_MAX_LOCATIONS_PER_REQUEST, type GbpLocalPostJson, type GbpLocationJson, type HubOverviewJson, type MailchimpExportJson, type OutboundPreviewJson } from '@social-lite/core/contracts/v35-integrations';
import type { IntegrationResourceJson } from '@social-lite/core/contracts/v35-connectors';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import { Badge, Button, Card, CardHeader, Checkbox, Dialog, Field, Input, Select, SimulatedBadge, useToast } from '@/components/ui';
import { ExternalWork } from './external-work';

const GBP_STATE: Record<string, { label: string; tone: 'success' | 'warn' | 'neutral' | 'danger' | 'info' }> = {
  waiting_approval: { label: 'Waiting for approval', tone: 'warn' }, scheduled: { label: 'Scheduled', tone: 'info' }, publishing: { label: 'Sending', tone: 'info' }, live: { label: 'Live', tone: 'success' },
  processing: { label: 'Processing at Google', tone: 'info' }, rejected: { label: 'Rejected by Google', tone: 'danger' }, failed: { label: 'Failed', tone: 'danger' }, needs_review: { label: 'Needs review', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'neutral' }, unknown: { label: 'Not confirmed', tone: 'warn' },
};

export function PostIntegrations({ postId, brandId }: { postId: string; brandId: string }) {
  const hub = useApi<HubOverviewJson>('/api/connectors/hub');
  const installs = useMemo(() => (hub.data?.connectors ?? []).flatMap((c) => c.installations.filter((i) => !i.disconnected_at && i.status !== 'reconnect_required' && (!i.brand_id || i.brand_id === brandId))), [hub.data, brandId]);
  const gbp = installs.some((i) => i.connector === 'google_business_profile');
  const mc = installs.find((i) => i.connector === 'mailchimp');
  const tasks = installs.some((i) => i.connector === 'asana' || i.connector === 'monday');
  if (!gbp && !mc && !tasks) return null;
  return (
    <Card aria-labelledby="h-post-int" data-testid="post-integrations">
      <CardHeader id="h-post-int" title="Integrations" />
      <div className="flex flex-col gap-5 px-4 pb-4">
        {gbp ? <GbpPosts postId={postId} brandId={brandId} /> : null}
        {mc ? <MailchimpExport postId={postId} integrationId={mc.id} /> : null}
        {tasks ? <ExternalWork relayType="post" relayId={postId} brandId={brandId} title="Tasks" /> : null}
      </div>
    </Card>
  );
}

function GbpPosts({ postId, brandId }: { postId: string; brandId: string }) {
  const toast = useToast();
  const posts = useApi<{ items: GbpLocalPostJson[] }>(`/api/connectors/gbp/posts?post_id=${postId}`, { poll: 20_000 });
  const locs = useApi<{ items: GbpLocationJson[] }>(`/api/connectors/gbp/locations?brand_id=${brandId}`);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirm, setConfirm] = useState('');
  return (
    <section aria-labelledby="h-gbp-posts">
      <h3 id="h-gbp-posts" className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle"><Store aria-hidden className="size-3.5" />Google Business Profile</h3>
      <ul className="flex flex-col gap-1.5">
        {(posts.data?.items ?? []).map((p) => {
          const s = GBP_STATE[p.state] ?? { label: p.state, tone: 'neutral' as const };
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="min-w-0 flex-1 truncate">{p.location_name}</span><Badge tone={s.tone}>{s.label}</Badge>{p.is_simulated ? <SimulatedBadge /> : null}
              {p.external_url ? <a href={p.external_url} target="_blank" rel="noreferrer noopener" aria-label="Open on Google" className="text-muted hover:text-fg"><ExternalLink aria-hidden className="size-4" /></a> : null}
              {p.state_detail ? <span className="w-full text-xs text-muted">{p.state_detail}</span> : null}
            </li>
          );
        })}
      </ul>
      <Button size="sm" variant="secondary" className="mt-2" onClick={() => { setPicked([]); setConfirm(''); setOpen(true); }}>Post to locations</Button>
      {open ? (
        <Dialog open onOpenChange={setOpen} title="Post to Google locations" footer={<>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" disabledReason={!picked.length ? 'Choose locations' : Number(confirm) !== picked.length ? `Type ${picked.length} to confirm` : null} onClick={async () => {
            try { await api.post('/api/connectors/gbp/posts', { post_id: postId, location_resource_ids: picked, confirm_location_count: Number(confirm) }); toast.success('Google posts follow this post’s schedule'); setOpen(false); await posts.refetch(); } catch (e) { toast.error(e); }
          }}>Add</Button>
        </>}>
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-muted">Uses the scheduled text, at the scheduled time, after approval. Up to {GBP_MAX_LOCATIONS_PER_REQUEST} locations.</p>
            <ul className="flex flex-col gap-2">
              {(locs.data?.items ?? []).map((l) => (
                <li key={l.resource_id}><Checkbox label={l.title} checked={picked.includes(l.resource_id)} disabled={!picked.includes(l.resource_id) && picked.length >= GBP_MAX_LOCATIONS_PER_REQUEST}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, l.resource_id] : picked.filter((x) => x !== l.resource_id))} /></li>
              ))}
            </ul>
            <Field label={`Number of locations (type ${picked.length || 'the count'})`}><Input inputMode="numeric" value={confirm} onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

function MailchimpExport({ postId, integrationId }: { postId: string; integrationId: string }) {
  const toast = useToast();
  const ex = useApi<{ items: MailchimpExportJson[] }>(`/api/connectors/mailchimp/exports?post_id=${postId}`, { poll: 20_000 });
  const res = useApi<{ items: IntegrationResourceJson[] }>(`/api/connectors/${integrationId}/resources`);
  const auds = (res.data?.items ?? []).filter((r) => r.selected && r.resource_type === 'audience');
  const [open, setOpen] = useState(false);
  const [aud, setAud] = useState('');
  const [subject, setSubject] = useState('');
  const [preview, setPreview] = useState<OutboundPreviewJson | null>(null);
  const [busy, setBusy] = useState(false);
  const body = { integration_id: integrationId, post_id: postId, audience_resource_id: aud || auds[0]?.id || '', subject: subject.trim() };
  const latest = ex.data?.items[0];
  return (
    <section aria-labelledby="h-mc-exp">
      <h3 id="h-mc-exp" className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.06em] text-subtle"><Mail aria-hidden className="size-3.5" />Mailchimp</h3>
      {latest ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="mailchimp-export">
          <span className="min-w-0 flex-1 truncate">{latest.audience_name ?? 'Audience'}</span>
          <Badge tone={latest.campaign_id ? 'info' : latest.state === 'failed' ? 'danger' : 'warn'}>{latest.campaign_id ? (latest.status === 'save' ? 'Draft in Mailchimp' : latest.status ?? 'Draft') : latest.state === 'unknown' ? 'Not confirmed' : latest.state === 'failed' ? 'Failed' : 'Creating draft'}</Badge>
          {latest.is_simulated ? <SimulatedBadge /> : null}
          {latest.campaign_url ? <a href={latest.campaign_url} target="_blank" rel="noreferrer noopener" aria-label="Open in Mailchimp" className="text-muted hover:text-fg"><ExternalLink aria-hidden className="size-4" /></a> : null}
          <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden className="size-3.5" />} onClick={async () => { try { await api.post('/api/connectors/mailchimp/exports/refresh', { post_id: postId }); await ex.refetch(); } catch (e) { toast.error(e); } }}>Refresh</Button>
          {latest.report ? <span className="w-full text-xs text-muted">{latest.report.emails_sent ?? 0} sent · {latest.report.opens ?? 0} opens · {latest.report.clicks ?? 0} clicks{latest.fetched_at ? ` · ${fmtRelative(latest.fetched_at)}` : ''}</span> : null}
        </div>
      ) : <Button size="sm" variant="secondary" onClick={() => { setPreview(null); setOpen(true); }}>Create email draft</Button>}
      {open ? (
        <Dialog open onOpenChange={setOpen} title="Create Mailchimp draft" footer={<>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          {!preview ? <Button variant="primary" loading={busy} disabledReason={!body.audience_resource_id ? 'Select an audience in Business apps first' : !subject.trim() ? 'Add a subject' : null}
            onClick={async () => { setBusy(true); try { setPreview(await api.post<OutboundPreviewJson>('/api/connectors/mailchimp/exports/preview', body)); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Review</Button>
            : <Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await api.post('/api/connectors/mailchimp/exports', body); toast.success('Draft requested. Send it from Mailchimp.'); setOpen(false); await ex.refetch(); } catch (e) { toast.error(e); } finally { setBusy(false); } }}>Create draft</Button>}
        </>}>
          <div className="flex flex-col gap-3">
            <Field label="Audience"><Select value={body.audience_resource_id} onChange={(e) => { setAud(e.target.value); setPreview(null); }}>{auds.length ? auds.map((a) => <option key={a.id} value={a.id}>{a.name}</option>) : <option value="">None selected</option>}</Select></Field>
            <Field label="Subject"><Input value={subject} maxLength={150} onChange={(e) => { setSubject(e.target.value); setPreview(null); }} /></Field>
            {preview ? (
              <div className="flex flex-col gap-1 rounded-lg border border-border bg-sunken p-3 text-[13px]" data-testid="outbound-preview">
                {preview.fields.map((f) => <p key={f.label}><span className="text-muted">{f.label}: </span><span className="whitespace-pre-wrap">{f.value}</span></p>)}
                <p className="text-xs text-muted">{preview.excluded.join(' · ')}</p>
              </div>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
