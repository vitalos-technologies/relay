'use client';
import { useEffect, useMemo, useState } from 'react';
import { Building, Gauge, OctagonPause, Play, Plus, Tag, Users } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { useBrandFilter, useQueryState } from '@/lib/client/hooks';
import { useApi } from '@/lib/client/use-api';
import { api, isApiError } from '@/lib/client/api';
import { allTimeZones } from '@/lib/client/format';
import type { Brand, Workspace } from '@/lib/client/types';
import {
  Banner, Button, Card, CardHeader, ConfirmDialog, Dialog, EmptyState, ErrorNotice, ErrorState, Facts, Field, Input, MetaChip, PageHeader,
  Select, Skeleton, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, TimeWithZone, useToast,
} from '@/components/ui';
import { TeamTab } from '@/components/settings/team-tab';

export default function SettingsPage() {
  const [params, setParams] = useQueryState();
  const tab = params.get('tab') ?? 'workspace';
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v === 'workspace' ? null : v })}>
        <TabsList label="Settings sections">
          <TabsTrigger value="workspace"><Building aria-hidden className="size-4" /> Workspace</TabsTrigger>
          <TabsTrigger value="brand"><Tag aria-hidden className="size-4" /> Brand</TabsTrigger>
          <TabsTrigger value="team"><Users aria-hidden className="size-4" /> Team</TabsTrigger>
          <TabsTrigger value="budgets"><Gauge aria-hidden className="size-4" /> Budgets</TabsTrigger>
        </TabsList>
        <TabsContent value="workspace"><WorkspaceTab /></TabsContent>
        <TabsContent value="brand"><BrandTab /></TabsContent>
        <TabsContent value="team"><TeamTab /></TabsContent>
        <TabsContent value="budgets"><BudgetsTab /></TabsContent>
      </Tabs>
    </>
  );
}

function useZones() {
  return useMemo(() => allTimeZones(), []);
}

// ------------------------------------------------------------------ workspace
function WorkspaceTab() {
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
      <CardHeader title="Workspace" actions={editable ? null : <MetaChip>View only</MetaChip>} />
      <div className="flex flex-col gap-6 p-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} readOnly={!editable} maxLength={120} /></Field>
        <Field label="Default time zone" info="For new brands and display. Never moves an existing scheduled post.">
          <Select value={tz} onChange={(e) => setTz(e.target.value)} disabled={!editable}>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </Select>
        </Field>
        {tz !== data.timezone ? <Banner tone="info" title="Scheduled posts keep their times" /> : null}
        <Facts items={[['Created', <TimeWithZone key="c" instant={data.created_at} tz={data.timezone} format="date" />], ['Type', data.is_demo ? 'Demo (simulated)' : 'Standard']]} />
        {saveErr ? <ErrorNotice error={saveErr} /> : null}
        {editable ? <div><Button variant="primary" onClick={save} loading={busy} disabled={!changed} disabledReason={changed && !name.trim() ? 'Name can’t be empty.' : null}>Save</Button></div> : null}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ brand
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function BrandTab() {
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
          <Field label="Brand" labelHidden className="min-w-[200px] flex-1">
            <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {session.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
        ) : null}
        {can('brands.manage') ? <Button variant="ghost" icon={<Plus aria-hidden className="size-4" />} onClick={() => setCreateOpen(true)}>New<span className="sr-only"> brand</span></Button> : null}
      </div>
      {!session.brands.length ? (
        <EmptyState icon={<Building aria-hidden />} title="No brands yet" action={can('brands.manage') ? <Button variant="primary" onClick={() => setCreateOpen(true)}>Create brand</Button> : null} />
      ) : selected ? <BrandForm key={selected} brandId={selected} /> : null}
      <CreateBrandDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={async (b) => { await refresh(); setSelected(b.id); }} />
    </div>
  );
}

function BrandForm({ brandId }: { brandId: string }) {
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
        name: f.name.trim(), timezone: f.timezone, approval_required: f.approval_required, editors_can_publish: f.editors_can_publish,
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
      {data.publishing_paused ? (
        <Banner tone="warn" title="Brand paused" actions={can('pause.emergency') ? <Button size="sm" icon={<Play aria-hidden className="size-4" />} onClick={() => setPauseOpen(true)}>Resume</Button> : null}>
          {data.paused_reason ? `“${data.paused_reason}”` : null}
          {data.paused_at ? <span className="block text-xs text-muted">Since <TimeWithZone instant={data.paused_at} tz={data.timezone} /></span> : null}
        </Banner>
      ) : null}
      <Card>
        <CardHeader title="Details" actions={editable ? null : <MetaChip>View only</MetaChip>} />
        <div className="grid grid-cols-1 gap-6 p-4 sm:grid-cols-2">
          <Field label="Name" error={fe?.name}><Input value={f.name} onChange={(e) => set({ name: e.target.value })} readOnly={!editable} /></Field>
          <Field label="Time zone" info="Default for new schedules. Existing ones keep their time.">
            <Select value={f.timezone} onChange={(e) => set({ timezone: e.target.value })} disabled={!editable}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </Select>
          </Field>
          <div className="sm:col-span-2 flex flex-col gap-4">
            <Switch checked={f.approval_required} onCheckedChange={(v) => set({ approval_required: v })} disabled={!editable} label="Require approval" description="Any change needs re-approval." />
            <Switch checked={f.editors_can_publish} onCheckedChange={(v) => set({ editors_can_publish: v })} disabled={!editable} label="Editors can publish" description="Off: editors submit for review." />
          </div>
          <Field label="Deadline (minutes)" info="If a post can’t send within this window it expires instead of posting late." error={dlBad ? 'Whole number, 1–10080.' : fe?.default_deadline_minutes}>
            <Input type="number" inputMode="numeric" min={1} max={10080} value={f.deadline} onChange={(e) => set({ deadline: e.target.value })} readOnly={!editable} />
          </Field>
        </div>
      </Card>
      <Card>
        <CardHeader title="Voice" />
        <div className="grid grid-cols-1 gap-6 p-4 sm:grid-cols-2">
          <Field label="Tone" className="sm:col-span-2"><Textarea value={f.tone} onChange={(e) => set({ tone: e.target.value })} rows={2} readOnly={!editable} className="min-h-16" placeholder="Warm, plain-spoken" /></Field>
          <Field label="Preferred terms"><Input value={f.terminology} onChange={(e) => set({ terminology: e.target.value })} readOnly={!editable} placeholder="Comma-separated" /></Field>
          <Field label="Avoid terms" hint="Composer warns on these."><Input value={f.prohibited} onChange={(e) => set({ prohibited: e.target.value })} readOnly={!editable} placeholder="Comma-separated" /></Field>
          <Field label="Call to action"><Input value={f.cta} onChange={(e) => set({ cta: e.target.value })} readOnly={!editable} /></Field>
          <Field label="Hashtags"><Input value={f.hashtags} onChange={(e) => set({ hashtags: e.target.value })} readOnly={!editable} placeholder="Comma-separated" /></Field>
          <Field label="Footer" className="sm:col-span-2"><Textarea value={f.footer} onChange={(e) => set({ footer: e.target.value })} rows={2} readOnly={!editable} className="min-h-16" /></Field>
        </div>
      </Card>
      {saveErr && !fe ? <ErrorNotice error={saveErr} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {editable ? <Button variant="primary" onClick={save} loading={busy} disabledReason={!f.name.trim() ? 'Name can’t be empty.' : dlBad ? 'Fix the deadline.' : null}>Save</Button> : null}
        {can('pause.emergency') && !data.publishing_paused ? (
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
      {session.workspace?.publishing_paused ? <Banner tone="info" title="Workspace also paused" /> : null}
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

// ------------------------------------------------------------------ budgets
function BudgetsTab() {
  const { data, error, loading, refetch } = useApi<Workspace>('/api/workspace');
  if (error && !data) return <ErrorState error={error} onRetry={refetch} />;
  if (loading || !data) return <Skeleton className="h-40 w-full max-w-2xl rounded-xl" />;
  const entries = Object.entries(data.limits ?? {});
  return (
    <Card className="max-w-2xl">
      <CardHeader title="Usage limits" actions={<MetaChip>Read only</MetaChip>} />
      <div className="px-4 pb-4">
        {!entries.length ? (
          <p className="text-[13px] text-muted">No limits set</p>
        ) : (
          <Facts items={entries.map(([k, v]) => [humanKey(k), <span key={k} className="font-mono text-[12px]">{formatValue(v)}</span>])} />
        )}
      </div>
    </Card>
  );
}

function humanKey(k: string) {
  return k.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function formatValue(v: unknown): string {
  if (typeof v === 'number') return v.toLocaleString('en-GB');
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '—';
  return JSON.stringify(v);
}
