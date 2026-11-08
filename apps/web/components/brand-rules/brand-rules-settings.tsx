'use client';
// V3.1 §12 Settings → Publishing → Brand rules. Brand profile (tone, CTA, colours, approved logos), rules with
// explicit severity (mandatory blocks submit/schedule/publish server-side; advisory only warns), the review list of
// posts affected by a rule change (keep / will edit / cancel schedule), and assets needing attention.
// Rule changes never rewrite content: the server returns an impact summary and opens reviews.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CircleAlert, OctagonX, Pencil, Plus, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABEL, type Provider } from '@social-lite/core';
import {
  BRAND_RULE_DEFAULT_SEVERITY, BRAND_RULE_KINDS, type AssetGovernanceDto, type BrandColour, type BrandFinding, type BrandProfileDto,
  type BrandRuleDto, type BrandRuleKind, type BrandRuleReviewDto, type ReviewDecision, type RuleChangeImpact, type RuleSeverity,
} from '@social-lite/core/contracts/v31-gov';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { fmtDateTime, fmtRelative } from '@/lib/client/format';
import { useSession } from '@/lib/client/session';
import type { Asset, Page } from '@/lib/client/types';
import {
  Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorNotice, ErrorState, Field, IconButton, Input, MetaChip,
  Segmented, Select, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, useToast,
} from '@/components/ui';
import { BrandScoped } from '@/components/settings/sections';

export const RULE_KIND_LABEL: Record<BrandRuleKind, string> = {
  prohibited_phrase: 'Prohibited phrase', discouraged_phrase: 'Discouraged phrase', preferred_term: 'Preferred term',
  required_footer: 'Required footer', required_disclaimer: 'Required disclaimer', approved_link_domain: 'Approved link domain',
};

export function SeverityBadge({ severity }: { severity: RuleSeverity }) {
  return severity === 'mandatory'
    ? <Badge tone="danger" icon={<OctagonX aria-hidden className="size-3.5" />}>Mandatory</Badge>
    : <Badge tone="warn" icon={<TriangleAlert aria-hidden className="size-3.5" />}>Advisory</Badge>;
}

export function impactText(i: RuleChangeImpact): string | undefined {
  const n = i.affected.reviews_opened;
  if (!n) return 'No scheduled or draft posts affected.';
  return `${n} post${n === 1 ? '' : 's'} to review${i.affected.truncated ? ' (first 500)' : ''}. Nothing was changed.`;
}

export function BrandRulesSettings() {
  return <BrandScoped>{(id) => <BrandRules brandId={id} />}</BrandScoped>;
}

function BrandRules({ brandId }: { brandId: string }) {
  const profile = useApi<BrandProfileDto>(`/api/brands/${brandId}/profile`);
  const reviews = useApi<{ items: BrandRuleReviewDto[] }>(`/api/brands/${brandId}/rule-reviews?status=open`);
  const [tab, setTab] = useState('rules');
  if (profile.error && !profile.data) return <ErrorState error={profile.error} onRetry={profile.refetch} />;
  if (!profile.data) return <Skeleton className="h-96 w-full rounded-xl" />;
  const open = reviews.data?.items.length ?? 0;
  const refresh = () => { void profile.refetch(); void reviews.refetch(); };
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList label="Brand rules sections">
        <TabsTrigger value="rules">Rules</TabsTrigger>
        <TabsTrigger value="reviews">Reviews{open ? <span className="ml-1.5 rounded-full bg-accent px-1.5 text-[11px] font-semibold text-on-accent tabular">{open}</span> : null}</TabsTrigger>
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="assets">Assets</TabsTrigger>
      </TabsList>
      <TabsContent value="rules"><RulesCard brandId={brandId} profile={profile.data} onChanged={refresh} /></TabsContent>
      <TabsContent value="reviews"><ReviewsCard brandId={brandId} data={reviews.data?.items} error={reviews.error} onChanged={refresh} /></TabsContent>
      <TabsContent value="profile"><ProfileCard brandId={brandId} profile={profile.data} onChanged={refresh} /></TabsContent>
      <TabsContent value="assets"><AssetAttention brandId={brandId} /></TabsContent>
    </Tabs>
  );
}

// ------------------------------------------------------------------ rules
function RulesCard({ brandId, profile, onChanged }: { brandId: string; profile: BrandProfileDto; onChanged: () => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState<BrandRuleDto | 'new' | null>(null);
  const [archive, setArchive] = useState<BrandRuleDto | null>(null);
  const legacy = profile.voice.prohibited ?? [];
  return (
    <Card>
      <CardHeader
        title={<>Rules <span className="ml-1 font-normal text-muted tabular">{profile.rules.length}</span></>}
        actions={profile.can_edit ? <Button size="sm" variant="primary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setEdit('new')}>Add rule</Button> : <MetaChip>View only</MetaChip>}
      />
      {!profile.rules.length ? (
        <EmptyState compact icon={<ShieldCheck aria-hidden />} title="No rules yet" />
      ) : (
        <ul className="divide-y divide-border px-1 pb-2" aria-label="Brand rules">
          {profile.rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-3 sm:flex-nowrap" data-testid={`rule-${r.id}`}>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted">{RULE_KIND_LABEL[r.kind]}{r.providers.length ? ` · ${r.providers.map((p) => PROVIDER_LABEL[p]).join(', ')}` : ''}</p>
                <p className="truncate text-[14px] font-medium">“{r.value}”{r.replacement ? <span className="font-normal text-muted"> → {r.replacement}</span> : null}</p>
                {r.note ? <p className="truncate text-xs text-muted">{r.note}</p> : null}
              </div>
              <SeverityBadge severity={r.severity} />
              {profile.can_edit ? (
                <span className="flex">
                  <IconButton size="sm" label={`Edit rule ${r.value}`} icon={<Pencil aria-hidden className="size-4" />} onClick={() => setEdit(r)} />
                  <IconButton size="sm" label={`Remove rule ${r.value}`} icon={<Trash2 aria-hidden className="size-4" />} onClick={() => setArchive(r)} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {legacy.length ? (
        <p className="border-t border-border px-4 py-3 text-xs text-muted">
          Brand voice also discourages {legacy.length} term{legacy.length === 1 ? '' : 's'} (advisory). <Link className="underline" href="/settings/automation/voice">Brand voice</Link>
        </p>
      ) : null}
      {edit ? (
        <RuleDialog brandId={brandId} rule={edit === 'new' ? null : edit} onClose={(impact) => { setEdit(null); if (impact) { toast.success(edit === 'new' ? 'Rule added' : 'Rule saved', impactText(impact)); onChanged(); } }} />
      ) : null}
      <ConfirmDialog
        open={!!archive}
        onOpenChange={(o) => !o && setArchive(null)}
        title="Remove this rule?"
        description="Posts aren’t changed."
        confirmLabel="Remove"
        confirmVariant="danger"
        onConfirm={async () => {
          const r = await api.del<{ impact: RuleChangeImpact }>(`/api/brand-rules/${archive!.id}`);
          toast.success('Rule removed', impactText(r.impact));
          onChanged();
        }}
      />
    </Card>
  );
}

function RuleDialog({ brandId, rule, onClose }: { brandId: string; rule: BrandRuleDto | null; onClose: (impact?: RuleChangeImpact) => void }) {
  const [kind, setKind] = useState<BrandRuleKind>(rule?.kind ?? 'prohibited_phrase');
  const [value, setValue] = useState(rule?.value ?? '');
  const [replacement, setReplacement] = useState(rule?.replacement ?? '');
  const [severity, setSeverity] = useState<RuleSeverity>(rule?.severity ?? BRAND_RULE_DEFAULT_SEVERITY.prohibited_phrase);
  const [providers, setProviders] = useState<Provider[]>(rule?.providers ?? []);
  const [note, setNote] = useState(rule?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const valueLabel = kind === 'approved_link_domain' ? 'Domain' : kind === 'required_footer' ? 'Footer text' : kind === 'required_disclaimer' ? 'Disclaimer text' : kind === 'preferred_term' ? 'Avoid' : 'Phrase';
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = { value: value.trim(), replacement: kind === 'preferred_term' ? replacement.trim() || null : null, severity, providers, note: note.trim() || null };
      const r = rule
        ? await api.patch<{ impact: RuleChangeImpact }>(`/api/brand-rules/${rule.id}`, body)
        : await api.post<{ impact: RuleChangeImpact }>(`/api/brands/${brandId}/rules`, { kind, ...body });
      onClose(r.impact);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      busy={busy}
      title={rule ? 'Edit rule' : 'Add rule'}
      footer={<>
        <Button variant="ghost" onClick={() => onClose()} disabled={busy}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => void save()} disabledReason={!value.trim() ? 'Add a value.' : null}>Save</Button>
      </>}
    >
      <div className="flex flex-col gap-4">
        {!rule ? (
          <Field label="Type">
            <Select value={kind} onChange={(e) => { const k = e.target.value as BrandRuleKind; setKind(k); setSeverity(BRAND_RULE_DEFAULT_SEVERITY[k]); }}>
              {BRAND_RULE_KINDS.map((k) => <option key={k} value={k}>{RULE_KIND_LABEL[k]}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field label={valueLabel}>
          {kind === 'required_footer' || kind === 'required_disclaimer'
            ? <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} maxLength={500} />
            : <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} placeholder={kind === 'approved_link_domain' ? 'example.com' : undefined} />}
        </Field>
        {kind === 'preferred_term' ? <Field label="Use instead"><Input value={replacement} onChange={(e) => setReplacement(e.target.value)} maxLength={200} /></Field> : null}
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium">Severity</span>
          <Segmented label="Severity" value={severity} onChange={setSeverity} options={[{ value: 'mandatory', label: 'Mandatory · blocks' }, { value: 'advisory', label: 'Advisory · warns' }]} />
        </div>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Destinations <span className="font-normal text-subtle">{providers.length ? '' : 'All'}</span></legend>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {PROVIDERS.map((p) => (
              <Checkbox key={p} label={PROVIDER_LABEL[p]} checked={providers.includes(p)} onChange={(on) => setProviders(on ? [...providers, p] : providers.filter((x) => x !== p))} />
            ))}
          </div>
        </fieldset>
        <Field label="Note" optional><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        {err ? <ErrorNotice error={err} /> : null}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ reviews
const DECISION_LABEL: Record<ReviewDecision, string> = { keep: 'Keep', will_edit: 'Will edit', cancel_schedule: 'Cancel schedule' };

function ReviewsCard({ data, error, onChanged }: { brandId: string; data: BrandRuleReviewDto[] | undefined; error: unknown; onChanged: () => void }) {
  const { session } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (error && !data) return <ErrorNotice error={error} />;
  if (!data) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (!data.length) return <Card><EmptyState compact icon={<ShieldCheck aria-hidden />} title="Nothing to review" /></Card>;
  const tz = session.workspace?.timezone ?? 'UTC';
  const decide = async (r: BrandRuleReviewDto, d: ReviewDecision) => {
    setBusy(`${r.id}:${d}`);
    setErr(null);
    try {
      await api.post(`/api/rule-reviews/${r.id}/decision`, { decision: d });
      toast.success(DECISION_LABEL[d]);
      onChanged();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {err ? <ErrorNotice error={err} /> : null}
      {data.map((r) => (
        <Card key={r.id} className="p-4" data-testid={`review-${r.id}`}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <Link href={`/posts/${r.post_id}`} className="block truncate text-[14px] font-medium hover:underline">{r.post_title?.trim() || 'Untitled post'}</Link>
              <p className="text-xs text-muted">{r.kind === 'schedule' && r.due_at ? `Scheduled ${fmtDateTime(r.due_at, tz)}` : 'Draft'} · Opened {fmtRelative(r.created_at)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" loading={busy === `${r.id}:keep`} onClick={() => void decide(r, 'keep')}>Keep</Button>
              <Button size="sm" variant="secondary" loading={busy === `${r.id}:will_edit`} onClick={() => void decide(r, 'will_edit')}>Will edit</Button>
              {r.kind === 'schedule' ? <Button size="sm" variant="danger" loading={busy === `${r.id}:cancel_schedule`} onClick={() => void decide(r, 'cancel_schedule')}>Cancel schedule</Button> : null}
            </div>
          </div>
          <FindingList findings={r.findings} className="mt-3" />
        </Card>
      ))}
    </div>
  );
}

/** Findings exactly as the server words them (TipSignal fact errors included), severity first. */
export function FindingList({ findings, className }: { findings: BrandFinding[]; className?: string }) {
  const sorted = [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'mandatory' ? -1 : 1));
  return (
    <ul className={className ? `flex flex-col gap-1.5 ${className}` : 'flex flex-col gap-1.5'}>
      {sorted.map((f, i) => (
        <li key={`${f.code}-${i}`} className="flex items-start gap-2 text-[13px]" data-severity={f.severity}>
          {f.severity === 'mandatory' ? <OctagonX aria-label="Mandatory" className="mt-0.5 size-4 shrink-0 text-danger" /> : <TriangleAlert aria-label="Advisory" className="mt-0.5 size-4 shrink-0 text-warn" />}
          <span className="min-w-0">{f.message}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ profile
function ProfileCard({ brandId, profile, onChanged }: { brandId: string; profile: BrandProfileDto; onChanged: () => void }) {
  const toast = useToast();
  const assets = useApi<Page<Asset>>(`/api/brands/${brandId}/assets?status=ready`);
  const [tone, setTone] = useState(profile.tone ?? '');
  const [cta, setCta] = useState(profile.cta_default ?? '');
  const [colours, setColours] = useState<BrandColour[]>(profile.colours);
  const [logos, setLogos] = useState<string[]>(profile.logo_asset_ids);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { setTone(profile.tone ?? ''); setCta(profile.cta_default ?? ''); setColours(profile.colours); setLogos(profile.logo_asset_ids); }, [profile]);
  const ro = !profile.can_edit;
  const badHex = colours.some((c) => !/^#[0-9a-fA-F]{6}$/.test(c.hex) || !c.name.trim());
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.patch<{ impact: RuleChangeImpact }>(`/api/brands/${brandId}/profile`, { tone: tone.trim() || null, cta_default: cta.trim() || null, colours, logo_asset_ids: logos });
      toast.success('Profile saved', impactText(r.impact));
      onChanged();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Brand profile" actions={ro ? <MetaChip>View only</MetaChip> : null} />
      <div className="flex flex-col gap-5 p-4 pt-0">
        <Field label="Tone"><Textarea value={tone} onChange={(e) => setTone(e.target.value)} rows={2} maxLength={1000} readOnly={ro} /></Field>
        <Field label="Default call to action"><Input value={cta} onChange={(e) => setCta(e.target.value)} maxLength={300} readOnly={ro} /></Field>
        <div>
          <p className="mb-2 text-[13px] font-medium">Colours</p>
          <ul className="flex flex-col gap-2">
            {colours.map((c, i) => (
              <li key={i} className="flex items-center gap-2">
                <span aria-hidden className="size-8 shrink-0 rounded-md border border-border" style={{ background: /^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : 'transparent' }} />
                <Input aria-label={`Colour ${i + 1} name`} value={c.name} readOnly={ro} onChange={(e) => setColours(colours.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className="max-w-[200px]" />
                <Input aria-label={`Colour ${i + 1} hex`} value={c.hex} readOnly={ro} onChange={(e) => setColours(colours.map((x, j) => (j === i ? { ...x, hex: e.target.value.trim() } : x)))} className="max-w-[120px] font-mono" />
                {!ro ? <IconButton size="sm" label={`Remove colour ${c.name}`} icon={<Trash2 aria-hidden className="size-4" />} onClick={() => setColours(colours.filter((_, j) => j !== i))} /> : null}
              </li>
            ))}
          </ul>
          {!ro && colours.length < 20 ? <Button size="sm" variant="ghost" className="mt-2" icon={<Plus aria-hidden className="size-4" />} onClick={() => setColours([...colours, { name: '', hex: '#' }])}>Colour</Button> : null}
        </div>
        <div>
          <p className="mb-2 text-[13px] font-medium">Approved logos</p>
          {!assets.data ? <Skeleton className="h-20 w-full rounded-lg" /> : !assets.data.items.length ? <p className="text-[13px] text-muted">No files in the library</p> : (
            <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {assets.data.items.slice(0, 24).map((a) => {
                const on = logos.includes(a.id);
                return (
                  <li key={a.id}>
                    <button type="button" disabled={ro} aria-pressed={on} aria-label={a.original_filename} onClick={() => setLogos(on ? logos.filter((x) => x !== a.id) : [...logos, a.id])}
                      className={`block aspect-square w-full overflow-hidden rounded-lg border bg-sunken ${on ? 'border-[var(--text)] ring-2 ring-[var(--text)]' : 'border-border'}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {a.thumb_url ? <img src={a.thumb_url} alt="" className="size-full object-cover" loading="lazy" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {err ? <ErrorNotice error={err} /> : null}
        {!ro ? <div><Button variant="primary" loading={busy} onClick={() => void save()} disabledReason={badHex ? 'Each colour needs a name and #RRGGBB.' : null}>Save</Button></div> : null}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ assets needing attention
interface AttentionItem { asset_id: string; name: string | null; lifecycle: AssetGovernanceDto['lifecycle']; expires_at: string | null; expiry_state: 'expired' | 'expiring' | 'none'; licence: string | null }

function AssetAttention({ brandId }: { brandId: string }) {
  const { session } = useSession();
  const { data, error } = useApi<{ items: AttentionItem[] }>(`/api/brands/${brandId}/asset-governance`);
  if (error && !data) return <ErrorNotice error={error} />;
  if (!data) return <Skeleton className="h-32 w-full rounded-xl" />;
  if (!data.items.length) return <Card><EmptyState compact icon={<ShieldCheck aria-hidden />} title="No assets need attention" /></Card>;
  const tz = session.workspace?.timezone ?? 'UTC';
  return (
    <Card>
      <ul className="divide-y divide-border" aria-label="Assets needing attention">
        {data.items.map((a) => (
          <li key={a.asset_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <CircleAlert aria-hidden className="size-4 shrink-0 text-warn" />
            <div className="min-w-0 flex-1">
              <Link href={`/library?asset=${a.asset_id}`} className="block truncate text-[13px] font-medium hover:underline">{a.name ?? 'Untitled file'}</Link>
              {a.licence ? <p className="truncate text-xs text-muted">{a.licence}</p> : null}
            </div>
            {a.lifecycle !== 'active' ? <Badge tone="warn">{a.lifecycle === 'superseded' ? 'Superseded' : 'Archived'}</Badge> : null}
            {a.expires_at ? <Badge tone={a.expiry_state === 'expired' ? 'danger' : 'warn'}>{a.expiry_state === 'expired' ? 'Expired' : 'Expires'} {fmtDateTime(a.expires_at, tz)}</Badge> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
