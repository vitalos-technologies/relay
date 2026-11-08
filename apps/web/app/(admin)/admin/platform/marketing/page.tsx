'use client';
// Platform → Marketing (V5 §16): the public page's small configuration — support widget switches read by the widget service
// (stream WID), legal link targets and a public support address. No secrets. Operators change it with a reason (fresh
// sign-in); every change is in the platform audit.
import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { MarketingConfig } from '@social-lite/core/contracts/v5-marketing';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { Badge, Button, Card, ErrorState, Field, Input, PageHeader, SkeletonRows, Switch, useToast } from '@/components/ui';
import { Ago, ReasonDialog } from '@/components/admin/ui';

type Draft = Pick<MarketingConfig, 'widget_enabled' | 'widget_staffed' | 'widget_in_app'> & { privacy_url: string; terms_url: string; support_email: string };
const toDraft = (c: MarketingConfig): Draft => ({
  widget_enabled: c.widget_enabled, widget_staffed: c.widget_staffed, widget_in_app: c.widget_in_app,
  privacy_url: c.privacy_url ?? '', terms_url: c.terms_url ?? '', support_email: c.support_email ?? '',
});

export default function PlatformMarketingPage() {
  const { data, error, loading, refetch, setData } = useApi<MarketingConfig>('/api/platform/marketing');
  return (
    <>
      <PageHeader title="Marketing" meta={<span className="text-[13px] text-muted">Public page settings. No secrets are stored here.</span>}
        actions={<a href="/" target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent-text hover:underline">Open page<ExternalLink aria-hidden className="size-3.5" /></a>} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={4} /> : <MarketingForm key={data.updated_at ?? 'defaults'} data={data} onSaved={setData} />}
    </>
  );
}

function MarketingForm({ data, onSaved }: { data: MarketingConfig; onSaved: (c: MarketingConfig) => void }) {
  const { session } = useSession();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => toDraft(data));
  const [confirm, setConfirm] = useState(false);
  const operator = session.platform_role === 'operator';
  const dirty = JSON.stringify(toDraft(data)) !== JSON.stringify(draft);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <>
      {(
        <form className="flex max-w-2xl flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (dirty) setConfirm(true); }}>
          <Card className="flex flex-col gap-4 p-5">
            <div>
              <h2 className="text-[15px] font-semibold">Support widget</h2>
              <p className="mt-0.5 text-[13px] text-muted">Messages go to Platform → Support.</p>
            </div>
            <Switch checked={draft.widget_enabled} onCheckedChange={(v) => setDraft((d) => ({ ...d, widget_enabled: v, widget_staffed: v ? d.widget_staffed : false }))} label="Show the widget on the marketing page" disabled={!operator} />
            <Switch checked={draft.widget_in_app} onCheckedChange={(v) => set('widget_in_app', v)} label="Also show it inside the app" disabled={!operator} />
            <div className="flex flex-col gap-1">
              <Switch checked={draft.widget_staffed} onCheckedChange={(v) => set('widget_staffed', v)} label="Staffed live chat" disabled={!operator || !draft.widget_enabled} />
              <p className="text-xs text-muted">Turn on only when someone is watching the support inbox. Off: the widget says “Send us a message” and shows no online status.</p>
            </div>
            <p className="text-xs text-muted" data-testid="mkt-widget-state">Visitors see: <Badge tone={draft.widget_enabled ? (draft.widget_staffed ? 'success' : 'info') : 'neutral'}>{draft.widget_enabled ? (draft.widget_staffed ? 'Chat with us' : 'Send us a message') : 'No widget'}</Badge></p>
          </Card>
          <Card className="flex flex-col gap-4 p-5">
            <div>
              <h2 className="text-[15px] font-semibold">Footer links</h2>
              <p className="mt-0.5 text-[13px] text-muted">A path on this site (/…) or an https:// address. Empty = shown as “not published yet”.</p>
            </div>
            <Field label="Privacy notice"><Input value={draft.privacy_url} onChange={(e) => set('privacy_url', e.target.value)} placeholder="https://…" maxLength={500} disabled={!operator} /></Field>
            <Field label="Terms of service"><Input value={draft.terms_url} onChange={(e) => set('terms_url', e.target.value)} placeholder="https://…" maxLength={500} disabled={!operator} /></Field>
            <Field label="Public support email" hint="Optional. Shown next to the widget link."><Input type="email" value={draft.support_email} onChange={(e) => set('support_email', e.target.value)} placeholder="support@…" maxLength={254} disabled={!operator} /></Field>
          </Card>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabledReason={!operator ? 'Operators only' : !dirty ? 'No changes' : null}>Save changes</Button>
            {dirty ? <Button type="button" variant="ghost" onClick={() => setDraft(toDraft(data))}>Discard</Button> : null}
            {data.updated_at ? <span className="text-xs text-muted">Changed <Ago at={data.updated_at} /></span> : <span className="text-xs text-muted">Defaults (never changed)</span>}
          </div>
        </form>
      )}
      <ReasonDialog open={confirm} onOpenChange={setConfirm} title="Save marketing settings" confirmLabel="Save" description="Applies to the public page on its next load."
        onConfirm={async (reason) => {
          const r = await api.put<MarketingConfig>('/api/platform/marketing', {
            widget_enabled: draft.widget_enabled, widget_staffed: draft.widget_staffed, widget_in_app: draft.widget_in_app,
            privacy_url: draft.privacy_url.trim() || null, terms_url: draft.terms_url.trim() || null, support_email: draft.support_email.trim() || null, reason,
          });
          onSaved(r); toast.success('Saved');
        }} />
    </>
  );
}
