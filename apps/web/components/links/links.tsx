'use client';
// V3.1 §14 campaign links (flag v31.tracked_links).
//  - UTM defaults per brand, optionally per campaign (campaign wins).
//  - Link builder: preview the final URL (existing params kept, never duplicated; destination validated server-side),
//    override any parameter, optionally create a Relay short link (no open redirect: code → stored destination).
//  - Campaign measurement: the four families stay separate and are never summed; unimplemented ones say so.
import { useEffect, useState } from 'react';
import { ChartNoAxesColumn, Link2, MousePointerClick, Plug, ShieldQuestion } from 'lucide-react';
import { PROVIDER_LABEL } from '@social-lite/core';
import { UTM_KEYS, type CampaignMeasurement, type LinkPreview, type TrackedLinkDto, type UtmDefaultsDto, type UtmKey, type UtmParams } from '@social-lite/core/contracts/v31-gov';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { useBrandFilter } from '@/lib/client/hooks';
import {
  Badge, Button, Card, CardHeader, Dialog, Drawer, DrawerSection, ErrorNotice, InfoTip, ErrorState, Field, Input, MetaChip, Select, Skeleton, useToast,
} from '@/components/ui';

const UTM_LABEL: Record<UtmKey, string> = { utm_source: 'Source', utm_medium: 'Medium', utm_campaign: 'Campaign', utm_term: 'Term', utm_content: 'Content' };
const ORIGIN_LABEL: Record<LinkPreview['params'][number]['origin'], string> = { existing: 'kept', default: 'default', override: 'yours', derived: 'auto' };

// ------------------------------------------------------------------ settings
export function UtmDefaultsSettings() {
  const { session, canOn } = useSession();
  const [brandFilter] = useBrandFilter();
  const [brandId, setBrandId] = useState(brandFilter || session.brands[0]?.id || '');
  const [campaignId, setCampaignId] = useState('');
  const camps = useApi<{ items: Array<{ id: string; name: string; archived: boolean }> }>(brandId ? `/api/brands/${brandId}/campaigns` : null);
  const { data, error, refetch, setData } = useApi<UtmDefaultsDto>(brandId ? `/api/brands/${brandId}/utm-defaults${campaignId ? `?campaign_id=${campaignId}` : ''}` : null);
  const [params, setParams] = useState<UtmParams>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const toast = useToast();
  useEffect(() => { if (data) setParams(data.params); }, [data]);
  const editable = !!brandId && canOn(brandId, 'brands.manage');
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, v!.trim()]));
      setData(await api.put<UtmDefaultsDto>(`/api/brands/${brandId}/utm-defaults`, { campaign_id: campaignId || null, params: clean }));
      toast.success('Link defaults saved');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        <Field label="Brand" labelHidden className="min-w-[200px] flex-1">
          <Select value={brandId} onChange={(e) => { setBrandId(e.target.value); setCampaignId(''); }}>{session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
        </Field>
        <Field label="Campaign" labelHidden className="min-w-[200px] flex-1">
          <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">All campaigns (brand default)</option>
            {(camps.data?.items ?? []).filter((c) => !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      </div>
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : !data ? <Skeleton className="h-64 w-full rounded-xl" /> : (
        <Card>
          <CardHeader title={campaignId ? 'Campaign parameters' : 'Brand parameters'} actions={editable ? null : <MetaChip>View only</MetaChip>} />
          <div className="grid gap-4 p-4 pt-0 sm:grid-cols-2">
            {UTM_KEYS.map((k) => (
              <Field key={k} label={UTM_LABEL[k]} hint={!params[k] && data.effective[k] ? `Uses ${data.effective[k]}` : <code className="font-mono">{k}</code>}>
                <Input value={params[k] ?? ''} readOnly={!editable} maxLength={150} onChange={(e) => setParams({ ...params, [k]: e.target.value })} />
              </Field>
            ))}
            {err ? <ErrorNotice error={err} className="sm:col-span-2" /> : null}
            {editable ? <div className="sm:col-span-2"><Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button></div> : null}
          </div>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ composer link builder
export function LinkBuilderDialog({
  open, onOpenChange, brandId, postId, campaignId, initialUrl, onUse,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; brandId: string; postId: string; campaignId: string | null; initialUrl: string;
  onUse: (url: string) => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [overrides, setOverrides] = useState<Partial<Record<UtmKey, string | null>>>({});
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setUrl(initialUrl); setOverrides({}); setPreview(null); } }, [open, initialUrl]);
  const key = JSON.stringify({ url, overrides });
  useEffect(() => {
    if (!open || !url.trim()) { setPreview(null); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api.post<LinkPreview>('/api/links/preview', { brand_id: brandId, campaign_id: campaignId, url: url.trim(), overrides }, { signal: ctl.signal })
        .then((p) => { setPreview(p); setErr(null); })
        .catch((e) => { if (!ctl.signal.aborted) setErr(e); });
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open, brandId, campaignId]);
  const short = async () => {
    if (!preview?.url) return;
    setBusy(true); setErr(null);
    try {
      const l = await api.post<TrackedLinkDto>('/api/links', { brand_id: brandId, campaign_id: campaignId, post_id: postId, url: preview.url });
      onUse(l.short_url);
      onOpenChange(false);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      busy={busy}
      title="Campaign link"
      footer={<>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="secondary" loading={busy} disabledReason={!preview?.ok ? 'Fix the link first.' : null} onClick={() => void short()}>Use short link</Button>
        <Button variant="primary" disabledReason={!preview?.ok ? 'Fix the link first.' : null} onClick={() => { onUse(preview!.url!); onOpenChange(false); }}>Use link</Button>
      </>}
    >
      <div className="flex flex-col gap-4" data-testid="link-builder">
        <Field label="Destination"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" inputMode="url" /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          {UTM_KEYS.map((k) => {
            const p = preview?.params.find((x) => x.key === k);
            return (
              <Field key={k} label={UTM_LABEL[k]} hint={p && overrides[k] === undefined ? `${p.value} · ${ORIGIN_LABEL[p.origin]}` : undefined}>
                <Input value={overrides[k] ?? ''} placeholder={p?.value ?? ''} maxLength={150}
                  onChange={(e) => setOverrides({ ...overrides, [k]: e.target.value === '' ? undefined : e.target.value })} />
              </Field>
            );
          })}
        </div>
        <div className="rounded-lg bg-sunken px-3 py-2.5" aria-live="polite">
          <p className="mb-1 text-xs text-muted">Final link</p>
          {preview?.url ? <p className="break-all font-mono text-[12px]" data-testid="link-preview-url">{preview.url}</p> : <p className="text-[13px] text-muted">—</p>}
          {preview?.preserved.length ? <p className="mt-1 text-xs text-muted">Kept: {preview.preserved.join(', ')}</p> : null}
        </div>
        {preview?.errors.map((e) => <p key={e} role="alert" className="text-[13px] text-danger">{e}</p>)}
        {preview?.warnings.map((w) => <p key={w} className="text-[13px] text-warn">{w}</p>)}
        {err ? <ErrorNotice error={err} /> : null}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ campaign measurement
export function CampaignMeasurementDrawer({ campaignId, name, open, onOpenChange }: { campaignId: string; name: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data, error, refetch } = useApi<CampaignMeasurement>(open ? `/api/campaigns/${campaignId}/measurement` : null);
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={name} description="Measurement">
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : !data ? <Skeleton className="h-64 w-full rounded-lg" /> : (
        <div className="flex flex-col gap-6" data-testid="campaign-measurement">
          <DrawerSection title={<span className="flex items-center gap-2"><ChartNoAxesColumn aria-hidden className="size-4" />Native social metrics<InfoTip label="About native metrics">Reported by each network. Never added across networks.{data.native_social.freshness ? ` ${data.native_social.freshness}` : ''}</InfoTip></span>}>
            {!data.native_social.by_provider.length ? <p className="text-[13px] text-muted">No posts measured yet</p> : (
              <ul className="flex flex-col gap-3">
                {data.native_social.by_provider.map((p) => (
                  <li key={p.provider}>
                    <p className="mb-1 text-[13px] font-medium">{PROVIDER_LABEL[p.provider]} <span className="font-normal text-muted">· {p.posts} post{p.posts === 1 ? '' : 's'}</span></p>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-3">
                      {Object.entries(p.metrics).map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-2"><dt className="text-muted">{k.replace(/_/g, ' ')}</dt><dd className="tabular">{v.toLocaleString('en-GB')}</dd></div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </DrawerSection>
          <DrawerSection title={<span className="flex items-center gap-2"><MousePointerClick aria-hidden className="size-4" />Relay link clicks<InfoTip label="About link clicks">{data.app_clicks.caveat}</InfoTip></span>}>
            {data.app_clicks.status === 'no_links' ? <p className="text-[13px] text-muted">No short links yet</p> : (
              <p className="text-[24px] font-semibold tabular">{data.app_clicks.total.toLocaleString('en-GB')}</p>
            )}
          </DrawerSection>
          <DrawerSection title={<span className="flex items-center gap-2"><Plug aria-hidden className="size-4" />Website events<InfoTip label="About website events">{data.website_events.reason}</InfoTip></span>}>
            <Badge tone="neutral">Not connected</Badge>
          </DrawerSection>
          <DrawerSection title={<span className="flex items-center gap-2"><ShieldQuestion aria-hidden className="size-4" />Attributed conversions<InfoTip label="About conversions">{data.conversions.reason}</InfoTip></span>}>
            <Badge tone="neutral">Unavailable</Badge>
          </DrawerSection>
        </div>
      )}
    </Drawer>
  );
}

/** Small entry in the composer's Link field. */
export function LinkBuilderButton({ onClick }: { onClick: () => void }) {
  return <Button size="sm" variant="quiet" icon={<Link2 aria-hidden className="size-4" />} onClick={onClick}>Campaign link</Button>;
}

