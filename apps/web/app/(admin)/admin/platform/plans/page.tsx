'use client';
// Platform → Billing → Plans (any staff reads; billing staff map provider prices; operators publish versions). The persisted
// catalogue: plans → immutable versions (subscriptions stay on theirs) → provider price ids. Prices come only from the
// catalogue file (core/contracts/v4-plans.ts); "Publish version" persists a changed file as a NEW version.
import { useState } from 'react';
import type { CataloguePlanDto } from '@social-lite/services/billing/catalogue';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { plural } from '@/lib/client/format';
import { useSession } from '@/lib/client/session';
import { Badge, Banner, Button, Card, CardHeader, ErrorState, Field, Input, PageHeader, Select, SkeletonRows, useToast } from '@/components/ui';
import { ReasonDialog } from '@/components/admin/ui';
import { day, money } from '@/components/billing/format';

interface PlansView { plans: CataloguePlanDto[]; provider: { name: string; livemode: boolean } | null; can_edit: boolean }

export default function PlatformPlansPage() {
  const toast = useToast();
  const { session } = useSession();
  const { data, error, refetch } = useApi<PlansView>('/api/platform/billing/plans');
  const [publish, setPublish] = useState<string | null>(null);
  const [map, setMap] = useState<{ version: string } | null>(null);
  const [price, setPrice] = useState('');
  const [product, setProduct] = useState('');
  const [mode, setMode] = useState<'test' | 'live'>('test');
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (!data) return <SkeletonRows rows={6} />;
  const operator = session.platform_role === 'operator';
  return (
    <>
      <PageHeader title="Plans" meta={data.provider ? (data.provider.name === 'test' ? 'Test payment provider' : `Stripe · ${data.provider.livemode ? 'live' : 'test mode'}`) : 'Payments not set up'} />
      <div className="flex flex-col gap-6">
        {data.plans.map((p) => (
          <Card key={p.id} data-testid={`platform-plan-${p.id}`}>
            <CardHeader title={<span className="capitalize">{p.id}</span>} actions={<div className="flex flex-wrap gap-2">
              <Badge tone={p.public ? 'success' : 'neutral'}>{p.public ? 'Public' : 'Not purchasable'}</Badge>
              {p.id === 'free' ? <Badge tone="neutral">No checkout · no provider price</Badge> : null}
              {p.drift ? <Badge tone="warn">Catalogue changed</Badge> : null}
            </div>} />
            {p.drift ? <Banner className="mx-4 mb-3" tone="warn" title="The catalogue file differs from the current version"
              actions={operator ? <Button size="sm" onClick={() => setPublish(p.id)}>Publish version</Button> : null}>Existing subscriptions keep their version.</Banner> : null}
            <ul className="divide-y divide-border">
              {p.versions.map((v) => (
                <li key={v.id} className="flex flex-col gap-2 px-4 py-3 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>v{v.version}</strong>
                    <span className="tabular">{v.unit_amount_minor === 0 ? '£0 (Free)' : v.unit_amount_minor != null ? `${money(v.unit_amount_minor)} per user / ${v.interval}` : 'No price'}</span>
                    {v.trial_days ? <span className="text-muted">{v.trial_days}-day trial</span> : null}
                    <Badge tone={v.retired_at ? 'neutral' : 'success'}>{v.retired_at ? `Retired ${day(v.retired_at)}` : 'Current'}</Badge>
                    <span className="text-muted">{plural(v.subscriptions, 'workspace')}</span>
                    {data.can_edit && v.purchasable && !v.retired_at ? <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setMap({ version: v.id })}>Map Stripe price</Button> : null}
                  </div>
                  <p className="text-muted">{v.features.length} features · created {day(v.created_at)}</p>
                  {v.prices.length ? (
                    <ul className="flex flex-col gap-1">
                      {v.prices.map((x) => <li key={x.id} className="flex flex-wrap items-center gap-2"><code className="break-all text-[12px]">{x.price_ref}</code><Badge tone={x.provider === 'test' ? 'warn' : 'info'}>{x.provider === 'test' ? 'Test provider' : x.livemode ? 'Stripe live' : 'Stripe test'}</Badge>{x.retired_at ? <span className="text-muted">Retired</span> : null}</li>)}
                    </ul>
                  ) : <p className="text-muted">{v.unit_amount_minor === 0 ? 'Free has no provider product or price' : 'No provider price'}</p>}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      <ReasonDialog open={!!publish} onOpenChange={(o) => !o && setPublish(null)} confirmLabel="Publish version" title={`Publish a new ${publish} version?`}
        description="New checkouts use it; existing subscriptions keep their version until migrated. Needs a fresh sign-in."
        onConfirm={async (reason) => { await api.post('/api/platform/billing/plans', { plan_id: publish, reason }); toast.success('Published'); await refetch(); }} />
      <ReasonDialog open={!!map} onOpenChange={(o) => !o && setMap(null)} confirmLabel="Save mapping" title="Map a Stripe price"
        description="Create the price in Stripe first with the same amount, GBP, monthly, per unit. Needs a fresh sign-in."
        onConfirm={async (reason) => { await api.post('/api/platform/billing/prices', { plan_version_id: map!.version, provider: 'stripe', livemode: mode === 'live', price_ref: price.trim(), product_ref: product.trim() || null, reason }); toast.success('Mapped'); setPrice(''); setProduct(''); await refetch(); }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Price id"><Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="price_…" /></Field>
          <Field label="Product id" optional><Input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="prod_…" /></Field>
          <Field label="Mode"><Select value={mode} onChange={(e) => setMode(e.target.value as 'test' | 'live')}><option value="test">Test</option><option value="live">Live</option></Select></Field>
        </div>
      </ReasonDialog>
    </>
  );
}
