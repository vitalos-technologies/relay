'use client';
import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { PROVIDER_LABEL, toLocalInput, type ResolvedVariant, type ValidationIssue } from '@social-lite/core';
import { api, isApiError } from '@/lib/client/api';
import { fmtDateTime } from '@/lib/client/format';
import { outgoingText } from '@/lib/client/variants';
import type { Approval, Asset, Connection, Delivery, PostDetail, Schedule } from '@/lib/client/types';
import { Banner, Button, Dialog, ErrorNotice, Field, Input, PlatformIcon, RadioGroup, SimulatedBadge } from '@/components/ui';

import { ScheduleTimeField, ambiguityFromError, wallTimeReady, type WallTimeValue } from '@/components/schedule/schedule-time-field';
import { useReadinessGate } from '@/components/product/readiness-panel';

type Flush = () => Promise<number | null>;

function issuesFromError(e: unknown): ValidationIssue[] {
  if (!isApiError(e)) return [];
  const raw = (e.details?.issues ?? []) as unknown;
  return Array.isArray(raw) ? (raw as ValidationIssue[]) : [];
}

function IssueList({ issues, connections }: { issues: ValidationIssue[]; connections: Connection[] }) {
  if (!issues.length) return null;
  return (
    <Banner tone="danger" role="alert" title="Fix first">
      <ul className="mt-1 list-disc pl-4">
        {issues.map((i, n) => {
          const c = connections.find((x) => x.id === i.connectionId);
          return <li key={n}>{c ? <strong className="font-medium">{c.display_name}: </strong> : null}{i.message}</li>;
        })}
      </ul>
    </Banner>
  );
}

function defaultWallTime(post: PostDetail): WallTimeValue {
  const s = post.current_schedule;
  if (s && !s.is_immediate && (s.status === 'active' || s.status === 'pending_approval')) {
    return { local: (s.input_local_time ?? toLocalInput(new Date(s.due_at), s.input_timezone)).slice(0, 16), tz: s.input_timezone, offset: s.input_offset ?? null };
  }
  const tz = post.brand.timezone;
  const next = new Date(Date.now() + 60 * 60_000);
  next.setUTCMinutes(0, 0, 0);
  return { local: toLocalInput(next, tz), tz, offset: null };
}

function zonesFor(post: PostDetail, workspaceTz: string | undefined) {
  return [
    { tz: post.brand.timezone, label: `${post.brand.timezone} (brand)` },
    ...(workspaceTz ? [{ tz: workspaceTz, label: `${workspaceTz} (workspace)` }] : []),
  ];
}

// ------------------------------------------------------------------ Schedule
export function ScheduleDialog({
  open, onOpenChange, post, connectionIds, flush, onConflict, onDone, workspaceTz,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; post: PostDetail; connectionIds: string[]; flush: Flush;
  onConflict: (e: unknown) => void; onDone: (r: { schedule: Schedule; deliveries: Delivery[] }) => void; workspaceTz?: string;
}) {
  const [value, setValue] = useState<WallTimeValue>(() => defaultWallTime(post));
  const [deadline, setDeadline] = useState(String(post.brand.default_deadline_minutes ?? 15));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [serverAmb, setServerAmb] = useState<string[] | null>(null);
  useEffect(() => {
    if (open) {
      setValue(defaultWallTime(post));
      setDeadline(String(post.brand.default_deadline_minutes ?? 15));
      setError(null);
      setServerAmb(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dl = Number(deadline);
  const deadlineBad = !Number.isInteger(dl) || dl < 1 || dl > 10_080;
  const issues = issuesFromError(error);
  const destinations = post.connections.filter((c) => connectionIds.includes(c.id));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const version = await flush();
      if (version === null) throw new Error('Changes not saved — nothing was scheduled.');
      const res = await api.post<{ schedule: Schedule; deliveries: Delivery[] }>(`/api/posts/${post.id}/schedule`, {
        expected_version: version, connection_ids: connectionIds, input_local_time: value.local, timezone: value.tz,
        offset: value.offset ?? undefined, deadline_minutes: dl,
      }, { idempotent: true });
      onDone(res);
      onOpenChange(false);
    } catch (e) {
      if (isApiError(e) && e.code === 'version_conflict') {
        onOpenChange(false);
        onConflict(e);
        return;
      }
      const amb = ambiguityFromError(e, value);
      if (amb) setServerAmb(amb);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  // V2 readiness preflight (stream D): failures and unacknowledged duplicates block the action.
  const gate = useReadinessGate({ open, postId: post.id, prepare: flush,
    body: { mode: 'schedule', connection_ids: connectionIds, input_local_time: value.local, timezone: value.tz, offset: value.offset ?? null, deadline_minutes: deadlineBad ? null : dl } });
  const reason = !connectionIds.length ? 'Pick a destination.' : !wallTimeReady(value) ? 'Pick a future time.' : deadlineBad ? 'Deadline: 1–10080 min.' : gate.blockReason;
  const hasExisting = post.current_schedule && (post.current_schedule.status === 'active' || post.current_schedule.status === 'pending_approval');

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      size="lg"
      title={hasExisting ? 'Reschedule' : 'Schedule'}
      description={`${destinations.length} destination${destinations.length === 1 ? '' : 's'} · ${post.brand.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={reason}>{hasExisting ? 'Reschedule' : 'Schedule'}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ScheduleTimeField value={value} onChange={(v) => { setValue(v); setError(null); }} preferredZones={zonesFor(post, workspaceTz)} serverAmbiguity={serverAmb} />
        <Field label="Deadline (minutes)" info="If it can’t send within this window (outage, pause), it expires instead of posting late." error={deadlineBad ? 'Whole number, 1–10080.' : null}>
          <Input type="number" inputMode="numeric" min={1} max={10080} value={deadline} onChange={(e) => setDeadline(e.target.value)} className="max-w-[160px]" />
        </Field>
        <DestinationSummary connections={destinations} />
        {gate.panel}
        {post.brand.approval_required ? <Banner tone="info" title="Needs approval before sending" /> : null}
        {hasExisting ? <Banner tone="info" title="Replaces current schedule; re-approval needed" /> : null}
        <IssueList issues={issues} connections={post.connections} />
        {error && !issues.length && !serverAmb ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Submit for review
export function SubmitDialog({
  open, onOpenChange, post, connectionIds, flush, onConflict, onDone, workspaceTz,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; post: PostDetail; connectionIds: string[]; flush: Flush;
  onConflict: (e: unknown) => void; onDone: (r: { schedule: Schedule; approval: Approval }) => void; workspaceTz?: string;
}) {
  const [mode, setMode] = useState<'time' | 'on_approval'>('time');
  const [value, setValue] = useState<WallTimeValue>(() => defaultWallTime(post));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [serverAmb, setServerAmb] = useState<string[] | null>(null);
  useEffect(() => {
    if (open) {
      setValue(defaultWallTime(post));
      setError(null);
      setServerAmb(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const issues = issuesFromError(error);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const version = await flush();
      if (version === null) throw new Error('Changes not saved — nothing was submitted.');
      const body = mode === 'time'
        ? { expected_version: version, connection_ids: connectionIds, input_local_time: value.local, timezone: value.tz, offset: value.offset ?? undefined }
        : { expected_version: version, connection_ids: connectionIds };
      const res = await api.post<{ schedule: Schedule; approval: Approval }>(`/api/posts/${post.id}/submit`, body, { idempotent: true });
      onDone(res);
      onOpenChange(false);
    } catch (e) {
      if (isApiError(e) && e.code === 'version_conflict') {
        onOpenChange(false);
        onConflict(e);
        return;
      }
      const amb = ambiguityFromError(e, value);
      if (amb) setServerAmb(amb);
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const gate = useReadinessGate({ open, postId: post.id, prepare: flush,
    body: mode === 'time' ? { mode: 'submit', connection_ids: connectionIds, input_local_time: value.local, timezone: value.tz, offset: value.offset ?? null } : { mode: 'submit', connection_ids: connectionIds } });
  const reason = !connectionIds.length ? 'Pick a destination.' : mode === 'time' && !wallTimeReady(value) ? 'Pick a future time.' : gate.blockReason;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      size="lg"
      title="Submit for review"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={reason}>Submit</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <RadioGroup
          name="when"
          legend="Publish when approved"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'time', label: 'At a set time' },
            { value: 'on_approval', label: 'Immediately' },
          ]}
        />
        {mode === 'time' ? <ScheduleTimeField value={value} onChange={(v) => { setValue(v); setError(null); }} preferredZones={zonesFor(post, workspaceTz)} serverAmbiguity={serverAmb} /> : null}
        <DestinationSummary connections={post.connections.filter((c) => connectionIds.includes(c.id))} />
        {gate.panel}
        <p className="text-xs text-muted">Editing later withdraws it from review.</p>
        <IssueList issues={issues} connections={post.connections} />
        {error && !issues.length && !serverAmb ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Publish now (CO-08)
export function PublishNowDialog({
  open, onOpenChange, post, variants, assets, flush, onConflict, onDone,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; post: PostDetail; variants: ResolvedVariant[]; assets: Map<string, Asset>;
  flush: Flush; onConflict: (e: unknown) => void; onDone: (r: { schedule: Schedule; deliveries: Delivery[] }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const issues = issuesFromError(error);
  const conns = variants.map((v) => post.connections.find((c) => c.id === v.connectionId)).filter(Boolean) as Connection[];
  const mockCount = conns.filter((c) => c.is_mock).length;
  const realCount = conns.length - mockCount;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const version = await flush();
      if (version === null) throw new Error('Changes not saved — nothing was published.');
      const res = await api.post<{ schedule: Schedule; deliveries: Delivery[] }>(`/api/posts/${post.id}/publish`, {
        expected_version: version, connection_ids: variants.map((v) => v.connectionId),
      }, { idempotent: true });
      onDone(res);
      onOpenChange(false);
    } catch (e) {
      if (isApiError(e) && e.code === 'version_conflict') {
        onOpenChange(false);
        onConflict(e);
        return;
      }
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const label = realCount === 0 ? `Simulate (${mockCount})` : mockCount ? `Publish ${realCount} + simulate ${mockCount}` : `Publish to ${realCount}`;
  const gate = useReadinessGate({ open, postId: post.id, prepare: flush, body: { mode: 'publish', connection_ids: variants.map((v) => v.connectionId) } });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      size="xl"
      title="Publish now?"
      description={`Exactly what each of ${conns.length} destination${conns.length === 1 ? '' : 's'} will receive.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabledReason={!variants.length ? 'Pick a destination.' : gate.blockReason}>{label}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {post.brand.approval_required ? <Banner tone="info" title="Unapproved versions wait for approval" /> : null}
        {gate.panel}
        <ol className="flex flex-col divide-y divide-border">
          {variants.map((v) => {
            const c = post.connections.find((x) => x.id === v.connectionId);
            if (!c) return null;
            const text = outgoingText(v, c);
            const imgs = v.assetIds.map((id) => assets.get(id));
            return (
              <li key={v.connectionId} className="py-4 first:pt-0 last:pb-0">
                <div className="flex items-center gap-3">
                  <PlatformIcon provider={c.provider} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-2 text-sm font-medium"><span className="truncate">{c.display_name}</span>{c.is_mock ? <SimulatedBadge className="shrink-0" /> : null}</p>
                    <p className="truncate text-xs text-muted" title={c.provider_account_id}>
                      {PROVIDER_LABEL[c.provider]}{c.username ? ` · @${c.username.replace(/^@/, '')}` : ''} · ID <code className="font-mono text-[11px]">{c.provider_account_id}</code>
                    </p>
                  </div>
                  <span className="hidden text-xs text-subtle sm:inline">{v.inheritText ? 'Inherited' : 'Custom'}</span>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <p className="whitespace-pre-wrap break-words rounded-lg bg-sunken px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">{text || <span className="italic text-subtle">(no text)</span>}</p>
                    {v.link && c.provider === 'facebook' && !v.assetIds.length ? <p className="mt-2 flex items-center gap-1.5 text-xs text-muted"><ExternalLink aria-hidden className="size-3.5" /> Link card: <span className="break-all text-fg">{v.link}</span></p> : null}
                    {v.buttons.length ? (
                      <p className="mt-2 text-xs text-muted">Buttons: {v.buttons.map((b) => `${b.text} → ${b.url}`).join(' · ')}</p>
                    ) : null}
                  </div>
                  {imgs.length ? (
                    <div className="flex gap-2">
                      {imgs.map((a, i) => a?.thumb_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={i} src={a.thumb_url} alt={a.alt_text || a.original_filename} className="size-20 rounded-lg object-cover" />
                      ) : <span key={i} className="flex size-20 items-center justify-center rounded-lg bg-sunken p-1 text-center text-[10px] text-muted">{a?.original_filename ?? 'Missing image'}</span>)}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        <IssueList issues={issues} connections={post.connections} />
        {error && !issues.length ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Version conflict
export function ConflictDialog({
  open, onOpenChange, details, onReload, onKeepCopy, keptInHistory,
}: {
  open: boolean; onOpenChange: (o: boolean) => void;
  details: { version?: number; updated_by?: string; updated_at?: string } | null;
  onReload: () => Promise<void> | void; onKeepCopy: () => Promise<void>;
  /** V2: the server kept the rejected edit as a conflict copy (History) — nothing is lost either way. */
  keptInHistory?: boolean;
}) {
  const [busy, setBusy] = useState<'reload' | 'copy' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async (k: 'reload' | 'copy') => {
    setBusy(k);
    setError(null);
    try {
      if (k === 'reload') await onReload();
      else await onKeepCopy();
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={!!busy}
      title="Edited elsewhere"
      description={keptInHistory ? 'Nothing was overwritten. Your version is kept in History.' : 'Your edits weren’t saved. Nothing was overwritten.'}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={!!busy}>Later</Button>
          {keptInHistory ? null : <Button variant="secondary" onClick={() => run('copy')} loading={busy === 'copy'} disabled={!!busy && busy !== 'copy'}>Save mine as copy</Button>}
          <Button variant="primary" onClick={() => run('reload')} loading={busy === 'reload'} disabled={!!busy && busy !== 'reload'}>Load theirs</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <p>
          Version {details?.version ?? 'newer'} was saved
          {details?.updated_by ? <> by <strong className="font-medium">{details.updated_by}</strong></> : null}
          {details?.updated_at ? <> on {fmtDateTime(details.updated_at, 'UTC')} UTC</> : null}.
        </p>
        <p className="text-muted">{keptInHistory ? 'Load theirs, then compare or restore yours from History.' : 'Loading theirs discards your unsaved edits.'}</p>
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </Dialog>
  );
}

function DestinationSummary({ connections }: { connections: Connection[] }) {
  if (!connections.length) return null;
  return (
    <div>
      <p className="mb-2 text-[13px] font-medium">Destinations</p>
      <ul className="flex flex-wrap gap-2">
        {connections.map((c) => (
          <li key={c.id} className="flex max-w-full items-center gap-2 rounded-full bg-raised py-1 pl-1 pr-3 text-[13px]">
            <PlatformIcon provider={c.provider} size="xs" />
            {c.display_name}
            {c.is_mock ? <SimulatedBadge /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
