'use client';
// Settings sections rendered by the left-nav Settings shell (components/settings-shell). Ported from the former tabbed
// /settings page and split per sub-setting; every save still goes through the same APIs (server authorizes each one).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Building, Monitor, Moon, OctagonPause, Play, Plus, Sun } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { useBrandFilter } from '@/lib/client/hooks';
import { useApi } from '@/lib/client/use-api';
import { api, isApiError } from '@/lib/client/api';
import { allTimeZones, ROLE_LABEL } from '@/lib/client/format';
import { applyTheme, currentTheme, type Theme } from '@/lib/client/theme';
import type { Brand, Workspace } from '@/lib/client/types';
import {
  Banner, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, ErrorNotice, ErrorState, Facts, Field, Input, MetaChip, RadioGroup,
  Select, Skeleton, Switch, Textarea, TimeWithZone, useToast,
} from '@/components/ui';
import { V2_ROLE_LABEL } from '@/components/team/shared';
import { ApprovalPolicyCard } from '@/components/collab/approval-policy-card';
import { DuplicateWindow, HandoverExport } from '@/components/product/brand-product-settings';

function useZones() {
  return useMemo(() => allTimeZones(), []);
}

// ------------------------------------------------------------------ personal
export function ProfileSection() {
  const { session } = useSession();
  const ws = session.workspace;
  return (
    <Card className="max-w-2xl">
      <CardHeader title="Profile" />
      <div className="p-4 pt-0">
        <Facts items={[
          ['Name', session.user.name || '—'],
          ['Email', session.user.email],
          ['Role', ws ? ((ws.primary_role && V2_ROLE_LABEL[ws.primary_role]) || ROLE_LABEL[ws.role]) : '—'],
          ['Workspace', ws?.name ?? '—'],
        ]} />
        <p className="mt-4 text-xs text-muted">Name and email come from your sign-in account.</p>
      </div>
    </Card>
  );
}

export function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => setTheme(currentTheme()), []);
  return (
    <Card className="max-w-2xl">
      <CardHeader title="Theme" />
      <div className="p-4 pt-0">
        <RadioGroup<Theme>
          name="theme"
          legend="Theme"
          legendHidden
          value={theme}
          onChange={(t) => { setTheme(t); applyTheme(t); }}
          options={[
            { value: 'system', label: <span className="inline-flex items-center gap-2"><Monitor aria-hidden className="size-4" />System</span> },
            { value: 'dark', label: <span className="inline-flex items-center gap-2"><Moon aria-hidden className="size-4" />Dark</span> },
            { value: 'light', label: <span className="inline-flex items-center gap-2"><Sun aria-hidden className="size-4" />Light</span> },
          ]}
        />
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ workspace
export function WorkspaceSection({ part }: { part: 'general' | 'timezone' }) {
  const { can, refresh } = useSession();
  const toast = useToast();
  const zones = useZones();
  const { data, error, loading, refetch, setData } = useApi<Workspace>('/api/workspace');
  const [name, setName] = useState('');
  const [tz, setTz] = useState('Europe/London');
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<unknown>(null);
  useEffect(() => {
    if (data) {
      setName(data.name);
      setTz(data.timezone);
    }
  }, [data]);
  const editable = can('workspace.settings');
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Skeleton className="h-64 w-full max-w-2xl rounded-xl" />;
  const changed = name.trim() !== data.name || tz !== data.timezone;

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      const w = await api.patch<Workspace>('/api/workspace', { name: name.trim(), timezone: tz });
      setData(w);
      await refresh();
      toast.success('Workspace saved');
    } catch (e) {
      setSaveErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="max-w-2xl">
      <CardHeader title={part === 'general' ? 'Workspace' : 'Default time zone'} actions={editable ? null : <MetaChip>View only</MetaChip>} />
      <div className="flex flex-col gap-6 p-4 pt-0">
        {part === 'general' ? (
          <>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} readOnly={!editable} maxLength={120} /></Field>
            <Facts items={[['Created', <TimeWithZone key="c" instant={data.created_at} tz={data.timezone} format="date" />], ['Type', data.is_demo ? 'Demo (simulated)' : 'Standard']]} />
          </>
        ) : (
          <>
            <Field label="Time zone" info="For new brands and display. Never moves an existing scheduled post.">
              <Select value={tz} onChange={(e) => setTz(e.target.value)} disabled={!editable}>
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </Select>
            </Field>
            {tz !== data.timezone ? <Banner tone="info" title="Scheduled posts keep their times" /> : null}
            <Facts items={[['Dates', 'Day month year (en-GB)'], ['Week starts', 'Monday']]} />
          </>
        )}
        {saveErr ? <ErrorNotice error={saveErr} /> : null}
        {editable ? <div><Button variant="primary" onClick={save} loading={busy} disabled={!changed} disabledReason={changed && !name.trim() ? 'Name can’t be empty.' : null}>Save</Button></div> : null}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ brand scoped
/** Brand picker for brand-scoped settings; defaults to the global brand filter. */
export function BrandScoped({ children, allowCreate }: { children: (brandId: string) => ReactNode; allowCreate?: boolean }) {
  const { session, can, refresh } = useSession();
  const [brandFilter] = useBrandFilter();
  const [selected, setSelected] = useState(brandFilter || session.brands[0]?.id || '');
  const [createOpen, setCreateOpen] = useState(false);
  useEffect(() => {
    if (brandFilter) setSelected(brandFilter);
  }, [brandFilter]);
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-end gap-2">
        {session.brands.length ? (
          <Field label="Brand" labelHidden className="min-w-[200px] max-w-sm flex-1">
            <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
        ) : null}
        {allowCreate && can('brands.manage') ? <Button variant="ghost" icon={<Plus aria-hidden className="size-4" />} onClick={() => setCreateOpen(true)}>New<span className="sr-only"> brand</span></Button> : null}
      </div>
      {!session.brands.length ? (
        <EmptyState icon={<Building aria-hidden />} title="No brands yet" action={allowCreate && can('brands.manage') ? <Button variant="primary" onClick={() => setCreateOpen(true)}>Create brand</Button> : null} />
      ) : selected ? <div key={selected} className="flex flex-col gap-6">{children(selected)}</div> : null}
      {allowCreate ? <CreateBrandDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={async (b) => { await refresh(); setSelected(b.id); }} /> : null}
    </div>
  );
}

export function BrandingSection() {
  return <BrandScoped allowCreate>{(id) => <BrandForm brandId={id} section="details" />}</BrandScoped>;
}
export function BrandVoiceSection() {
  return <BrandScoped>{(id) => <BrandForm brandId={id} section="voice" />}</BrandScoped>;
}
export function PublishingDefaultsSection() {
  return <BrandScoped>{(id) => <BrandForm brandId={id} section="publishing" />}</BrandScoped>;
}
export function ApprovalPoliciesSection() {
  return <BrandScoped>{(id) => <ApprovalPolicyCard brandId={id} />}</BrandScoped>;
}
export function SafetyRulesSection() {
  return <BrandScoped>{(id) => <DuplicateWindow brandId={id} />}</BrandScoped>;
}
export function DataExportSection() {
  return <BrandScoped>{(id) => <HandoverExport brandId={id} />}</BrandScoped>;
}

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function BrandForm({ brandId, section }: { brandId: string; section: 'details' | 'publishing' | 'voice' }) {
  const { can, refresh, session } = useSession();
  const toast = useToast();
  const zones = useZones();
  const { data, error, loading, refetch, setData } = useApi<Brand>(`/api/brands/${brandId}`);
  const [f, setF] = useState<null | {
    name: string; timezone: string; approval_required: boolean; editors_can_publish: boolean; deadline: string;
    tone: string; terminology: string; prohibited: string; cta: string; hashtags: string; footer: string;
  }>(null);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseReason, setPauseReason] = useState('');
  useEffect(() => {
    if (!data) return;
    setF({
      name: data.name, timezone: data.timezone, approval_required: data.approval_required, editors_can_publish: data.editors_can_publish,
      deadline: String(data.default_deadline_minutes), tone: data.voice?.tone ?? '', terminology: (data.voice?.terminology ?? []).join(', '),
      prohibited: (data.voice?.prohibited ?? []).join(', '), cta: data.voice?.default_cta ?? '', hashtags: (data.voice?.hashtags ?? []).join(', '),
      footer: data.voice?.footer ?? '',
    });
  }, [data]);
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data || !f) return <Skeleton className="h-96 w-full rounded-xl" />;
  const editable = can('brands.manage');
  const dl = Number(f.deadline);
  const dlBad = !Number.isInteger(dl) || dl < 1 || dl > 10_080;
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const fe = isApiError(saveErr) ? saveErr.fieldErrors : undefined;

  const save = async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      const b = await api.patch<Brand>(`/api/brands/${brandId}`, {
        name: f.name.trim(), timezone: f.timezone, editors_can_publish: f.editors_can_publish,
        default_deadline_minutes: dl,
        voice: {
          tone: f.tone.trim() || undefined, terminology: list(f.terminology), prohibited: list(f.prohibited),
          default_cta: f.cta.trim() || undefined, hashtags: list(f.hashtags), footer: f.footer.trim() || undefined,
        },
      });
      setData(b);
      await refresh();
      toast.success('Brand saved');
    } catch (e) {
      setSaveErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {data.publishing_paused && section !== 'voice' ? (
        <Banner tone="warn" title="Brand paused" actions={can('pause.emergency') ? <Button size="sm" icon={<Play aria-hidden className="size-4" />} onClick={() => setPauseOpen(true)}>Resume</Button> : null}>
          {data.paused_reason ? `“${data.paused_reason}”` : null}
          {data.paused_at ? <span className="block text-xs text-muted">Since <TimeWithZone instant={data.paused_at} tz={data.timezone} /></span> : null}
        </Banner>
      ) : null}
      {section === 'details' ? (
        <Card>
          <CardHeader title="Brand" actions={editable ? null : <MetaChip>View only</MetaChip>} />
          <div className="grid grid-cols-1 gap-6 p-4 pt-0 sm:grid-cols-2">
            <Field label="Name" error={fe?.name}><Input value={f.name} onChange={(e) => set({ name: e.target.value })} readOnly={!editable} /></Field>
            <Field label="Time zone" info="Default for new schedules. Existing ones keep their time.">
              <Select value={f.timezone} onChange={(e) => set({ timezone: e.target.value })} disabled={!editable}>
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
              </Select>
            </Field>
          </div>
        </Card>
      ) : null}
      {section === 'publishing' ? (
        <Card>
          <CardHeader title="Defaults" actions={editable ? null : <MetaChip>View only</MetaChip>} />
          <div className="grid grid-cols-1 gap-6 p-4 pt-0 sm:grid-cols-2">
            <div className="flex flex-col gap-4 sm:col-span-2">
              <Switch checked={f.editors_can_publish} onCheckedChange={(v) => set({ editors_can_publish: v })} disabled={!editable} label="Editors can publish" description="Off: editors submit for review." />
            </div>
            <Field label="Deadline (minutes)" info="If a post can’t send within this window it expires instead of posting late." error={dlBad ? 'Whole number, 1–10080.' : fe?.default_deadline_minutes}>
              <Input type="number" inputMode="numeric" min={1} max={10080} value={f.deadline} onChange={(e) => set({ deadline: e.target.value })} readOnly={!editable} />
            </Field>
          </div>
        </Card>
      ) : null}
      {section === 'voice' ? (
        <Card>
          <CardHeader title="Voice" actions={editable ? null : <MetaChip>View only</MetaChip>} />
          <div className="grid grid-cols-1 gap-6 p-4 pt-0 sm:grid-cols-2">
            <Field label="Tone" className="sm:col-span-2"><Textarea value={f.tone} onChange={(e) => set({ tone: e.target.value })} rows={2} readOnly={!editable} className="min-h-16" placeholder="Warm, plain-spoken" /></Field>
            <Field label="Preferred terms"><Input value={f.terminology} onChange={(e) => set({ terminology: e.target.value })} readOnly={!editable} placeholder="Comma-separated" /></Field>
            <Field label="Avoid terms" hint="Composer warns on these."><Input value={f.prohibited} onChange={(e) => set({ prohibited: e.target.value })} readOnly={!editable} placeholder="Comma-separated" /></Field>
            <Field label="Call to action"><Input value={f.cta} onChange={(e) => set({ cta: e.target.value })} readOnly={!editable} /></Field>
            <Field label="Hashtags"><Input value={f.hashtags} onChange={(e) => set({ hashtags: e.target.value })} readOnly={!editable} placeholder="Comma-separated" /></Field>
            <Field label="Footer" className="sm:col-span-2"><Textarea value={f.footer} onChange={(e) => set({ footer: e.target.value })} rows={2} readOnly={!editable} className="min-h-16" /></Field>
          </div>
        </Card>
      ) : null}
      {saveErr && !fe ? <ErrorNotice error={saveErr} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {editable ? <Button variant="primary" onClick={save} loading={busy} disabledReason={!f.name.trim() ? 'Name can’t be empty.' : dlBad ? 'Fix the deadline.' : null}>Save</Button> : null}
        {section === 'publishing' && can('pause.emergency') && !data.publishing_paused ? (
          <Button variant="quiet" className="text-danger!" icon={<OctagonPause aria-hidden className="size-4" />} onClick={() => setPauseOpen(true)}>Pause brand</Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        title={data.publishing_paused ? `Resume ${data.name}?` : `Pause ${data.name}?`}
        description={data.publishing_paused
          ? 'Posts past their deadline expire — never sent late.'
          : 'Posts already sending may complete. Other brands unaffected.'}
        confirmLabel={data.publishing_paused ? 'Resume' : 'Pause brand'}
        confirmVariant={data.publishing_paused ? 'primary' : 'danger'}
        onConfirm={async () => {
          const b = await api.post<Brand>(`/api/brands/${brandId}/pause`, data.publishing_paused ? { paused: false } : { paused: true, reason: pauseReason.trim() || undefined });
          setData(b);
          setPauseReason('');
          await refresh();
          toast.success(b.publishing_paused ? 'Brand paused' : 'Brand resumed');
        }}
      >
        {!data.publishing_paused ? (
          <Field label="Reason" optional><Textarea value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} rows={2} className="min-h-16" /></Field>
        ) : null}
      </ConfirmDialog>
      {session.workspace?.publishing_paused && section === 'publishing' ? <Banner tone="info" title="Workspace also paused" /> : null}
    </>
  );
}

function CreateBrandDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (b: Brand) => Promise<void> }) {
  const { session } = useSession();
  const zones = useZones();
  const [name, setName] = useState('');
  const [tz, setTz] = useState(session.workspace?.timezone ?? 'Europe/London');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await api.post<Brand>('/api/brands', { name: name.trim(), timezone: tz });
      await onCreated(b);
      setName('');
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      title="New brand"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={!name.trim() ? 'Enter a name.' : null}>Create</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus /></Field>
        <Field label="Time zone">
          <Select value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </Select>
        </Field>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}
