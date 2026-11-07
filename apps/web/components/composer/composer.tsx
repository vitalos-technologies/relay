'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, CalendarClock, CircleCheck, CloudAlert, Copy, Ellipsis, LoaderCircle, Save, Send, SendHorizontal,
} from 'lucide-react';
import { PROVIDER_LABEL, resolveVariants, type DraftContent, type ValidationIssue, type VariantDraft } from '@social-lite/core';
import { api, isApiError } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { useOnline } from '@/lib/client/hooks';
import { fmtTime, zoneAbbr } from '@/lib/client/format';
import { constraintsOf, localChecks } from '@/lib/client/variants';
import type { Asset, Connection, PostDetail, ValidateResponse } from '@/lib/client/types';
import {
  Banner, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, IconButton, InfoTip, LinkButton, Menu, MenuContent, MenuItem,
  MenuTrigger, PlatformIcon, PostStatusBadge, Select, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, ToneIcon, useToast,
} from '@/components/ui';
import { BaseEditor, DestinationPicker, VariantEditor } from './editors';
import { VariantPreview } from './preview';
import { ConflictDialog, PublishNowDialog, ScheduleDialog, SubmitDialog } from './action-dialogs';
import { DeliveriesPanel } from './deliveries-panel';

type SaveState = 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict';
interface ConflictDetails { version?: number; updated_by?: string; updated_at?: string }

export function Composer({ postId }: { postId: string }) {
  const { data, error, loading, refetch } = useApi<PostDetail>(`/api/posts/${postId}`);
  const [instance, setInstance] = useState(0);
  if (error && !data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <ErrorState error={error} onRetry={refetch} title="Couldn’t open post" />
        <LinkButton href="/planner" className="mt-4" variant="ghost">Planner</LinkButton>
      </div>
    );
  }
  if (loading || !data) return <ComposerSkeleton />;
  return (
    <ComposerLoaded
      key={`${data.id}-${instance}`}
      post={data}
      refetch={refetch}
      reload={async () => {
        await refetch();
        setInstance((i) => i + 1);
      }}
    />
  );
}

function ComposerSkeleton() {
  return (
    <div role="status" aria-label="Loading post">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-3 h-9 w-2/3" />
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Skeleton className="h-[420px] w-full rounded-xl" />
        <div className="flex flex-col gap-4"><Skeleton className="h-40 w-full rounded-xl" /><Skeleton className="h-56 w-full rounded-xl" /></div>
      </div>
    </div>
  );
}

function ComposerLoaded({ post, refetch, reload }: { post: PostDetail; refetch: () => Promise<PostDetail | undefined>; reload: () => Promise<void> }) {
  const router = useRouter();
  const toast = useToast();
  const online = useOnline();
  const { session, can } = useSession();
  const readOnly = !post.can.edit;

  // ---------------------------------------------------------------- local working state
  const [draft, setDraft] = useState<DraftContent>(() => normaliseDraft(post.draft));
  const [title, setTitle] = useState(post.title ?? '');
  const latest = useRef({ draft, title });
  const versionRef = useRef(post.version);
  const [version, setVersion] = useState(post.version);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [savedAt, setSavedAt] = useState<string>(post.updated_at);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<ConflictDetails | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<boolean> | null>(null);

  const [assets, setAssets] = useState<Map<string, Asset>>(() => new Map(post.assets.map((a) => [a.id, a])));
  const addAssets = useCallback((list: Asset[]) => {
    setAssets((m) => {
      let changed = false;
      const n = new Map(m);
      for (const a of list) {
        const prev = n.get(a.id);
        if (!prev || prev.status !== a.status || prev.thumb_url !== a.thumb_url) {
          n.set(a.id, a);
          changed = true;
        }
      }
      return changed ? n : m;
    });
  }, []);

  const [tab, setTab] = useState<string>('base');
  const [previewId, setPreviewId] = useState<string>('');
  const [dialog, setDialog] = useState<null | 'schedule' | 'submit' | 'publish'>(null);
  const [pendingRemove, setPendingRemove] = useState<Connection | null>(null);
  const [server, setServer] = useState<{ version: number; result: ValidateResponse } | null>(null);
  const [validating, setValidating] = useState(false);

  // ---------------------------------------------------------------- autosave (CO-02)
  const save = useCallback(async (): Promise<boolean> => {
    if (inflight.current) {
      await inflight.current;
      return dirty.current ? save() : true;
    }
    if (!dirty.current) return true;
    const snapshot = latest.current;
    dirty.current = false;
    setSaveState('saving');
    const p = (async () => {
      try {
        const r = await api.patch<{ version: number; updated_at: string }>(`/api/posts/${post.id}`, {
          expected_version: versionRef.current, draft: snapshot.draft, title: snapshot.title.trim() || null,
        });
        versionRef.current = r.version;
        setVersion(r.version);
        setSavedAt(r.updated_at);
        setSaveError(null);
        setSaveState(dirty.current ? 'dirty' : 'saved');
        return true;
      } catch (e) {
        dirty.current = true;
        if (isApiError(e) && e.code === 'version_conflict') {
          const cur = (e.details?.current ?? {}) as ConflictDetails;
          setConflict(cur);
          setConflictOpen(true);
          setSaveState('conflict');
        } else {
          setSaveError(e);
          setSaveState('failed');
        }
        return false;
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = p;
    const ok = await p;
    if (ok && dirty.current) return save();
    return ok;
  }, [post.id]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (saveStateRef.current !== 'conflict') void save();
    }, 1000);
  }, [save]);
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  const edit = (next: { draft?: DraftContent; title?: string }) => {
    if (readOnly) return;
    if (next.draft) setDraft(next.draft);
    if (next.title !== undefined) setTitle(next.title);
    latest.current = { draft: next.draft ?? latest.current.draft, title: next.title ?? latest.current.title };
    dirty.current = true;
    if (saveStateRef.current !== 'conflict') setSaveState('dirty');
    schedule();
  };

  /** Save now; resolves to the saved version or null if it couldn't be saved. */
  const flush = useCallback(async (): Promise<number | null> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (saveStateRef.current === 'conflict') return null;
    const ok = await save();
    return ok ? versionRef.current : null;
  }, [save]);

  // Retry a failed save when the connection returns.
  useEffect(() => {
    if (online && saveState === 'failed') void save();
  }, [online, saveState, save]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty.current || inflight.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  // ---------------------------------------------------------------- validation (CO-04)
  const connectionIds = draft.variants.map((v) => v.connectionId).filter((id) => post.connections.some((c) => c.id === id));
  const local = useMemo(() => localChecks(draft, post.connections, assets), [draft, post.connections, assets]);
  const idsKey = connectionIds.join(',');
  useEffect(() => {
    if (saveState !== 'saved' || !idsKey) return;
    const v = version;
    const t = setTimeout(async () => {
      setValidating(true);
      try {
        const result = await api.post<ValidateResponse>(`/api/posts/${post.id}/validate`, { connection_ids: idsKey.split(',') });
        setServer({ version: v, result });
      } catch {
        /* local checks still shown; server re-validates when scheduling */
      } finally {
        setValidating(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [saveState, version, idsKey, post.id]);

  const serverFresh = server && server.version === version && saveState === 'saved';
  const issues: ValidationIssue[] = serverFresh
    ? server.result.issues.filter((i) => !i.connectionId || connectionIds.includes(i.connectionId))
    : [...local.values()].flatMap((c) => c.issues);
  const issuesFor = (id: string) => issues.filter((i) => i.connectionId === id);
  const generalIssues = issues.filter((i) => !i.connectionId);

  const resolved = useMemo(() => resolveVariants(draft, post.connections), [draft, post.connections]);
  const selectedConns = connectionIds.map((id) => post.connections.find((c) => c.id === id)!).filter(Boolean);
  const baseMax = Math.max(1, Math.min(...selectedConns.map((c) => constraintsOf(c)?.maxImages ?? 1), 10));

  // ---------------------------------------------------------------- destinations
  const toggleDestination = (c: Connection, on: boolean) => {
    if (on) {
      if (draft.variants.some((v) => v.connectionId === c.id)) return;
      edit({ draft: { ...draft, variants: [...draft.variants, { connectionId: c.id, inheritText: true, inheritMedia: true }] } });
    } else {
      const v = draft.variants.find((x) => x.connectionId === c.id);
      const custom = v && (!v.inheritText || !v.inheritMedia || (v.buttons?.length ?? 0) > 0 || v.link !== undefined);
      if (custom) setPendingRemove(c);
      else removeDestination(c.id);
    }
  };
  const removeDestination = (id: string) => {
    edit({ draft: { ...latest.current.draft, variants: latest.current.draft.variants.filter((v) => v.connectionId !== id) } });
    if (tab === id) setTab('base');
  };
  const updateVariant = (v: VariantDraft) => {
    edit({ draft: { ...latest.current.draft, variants: latest.current.draft.variants.map((x) => (x.connectionId === v.connectionId ? v : x)) } });
  };

  // ---------------------------------------------------------------- other actions
  const duplicate = async () => {
    try {
      await flush();
      const p = await api.post<PostDetail>(`/api/posts/${post.id}/duplicate`, {}, { idempotent: true });
      toast.success('Duplicated');
      router.push(`/posts/${p.id}`);
    } catch (e) {
      toast.error(e, 'Could not duplicate');
    }
  };
  const [archiveOpen, setArchiveOpen] = useState(false);
  const keepCopy = async () => {
    const mine = latest.current;
    const p = await api.post<PostDetail>(`/api/brands/${post.brand_id}/posts`, {
      title: `${mine.title.trim() || 'Untitled post'} (my copy)`, draft: mine.draft, connection_ids: connectionIds,
    }, { idempotent: true });
    dirty.current = false;
    router.push(`/posts/${p.id}`);
  };
  const afterAction = async (msg: string, body?: string) => {
    toast.success(msg, body);
    await refetch();
    requestAnimationFrame(() => document.getElementById('deliveries')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  // ---------------------------------------------------------------- render helpers
  const blockReason =
    saveState === 'conflict' ? 'Resolve the conflict first.'
      : !connectionIds.length ? 'Pick a destination.'
        : issues.length ? `Fix ${issues.length} issue${issues.length === 1 ? '' : 's'} first.`
          : null;
  const tz = post.brand.timezone;
  const workspaceTz = session.workspace?.timezone;
  const paused = session.workspace?.publishing_paused || post.brand.publishing_paused;
  const allMock = post.destinations.length > 0 && post.destinations.every((d) => d.is_mock);
  const previewConn = selectedConns.find((c) => c.id === (tab !== 'base' ? tab : previewId)) ?? selectedConns[0];
  const previewVariant = previewConn ? resolved.find((r) => r.connectionId === previewConn.id) : undefined;

  return (
    <div className="pb-24">
      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="mb-1 flex items-center gap-1 truncate text-xs text-subtle">{post.brand.name}<InfoTip label="About the title">Internal title — never published.</InfoTip></p>
          <h1 className="sr-only">Edit post{title.trim() ? `: ${title.trim()}` : ''}</h1>
          <label htmlFor="post-title" className="sr-only">Post title (internal)</label>
          <input
            id="post-title"
            value={title}
            readOnly={readOnly}
            onChange={(e) => edit({ title: e.target.value })}
            placeholder="Untitled post"
            maxLength={200}
            className="w-full rounded-md bg-transparent text-[22px] font-semibold tracking-[-0.01em] placeholder:text-subtle sm:text-[24px]"
          />
        </div>
        <div className="flex items-center gap-2">
          <PostStatusBadge status={post.status} simulated={allMock} />
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="More post actions" icon={<Ellipsis aria-hidden className="size-4" />} />
            </MenuTrigger>
            <MenuContent>
              {can('drafts.edit') ? <MenuItem icon={<Copy aria-hidden />} onSelect={() => void duplicate()}>Duplicate</MenuItem> : null}
              {post.can.edit ? <MenuItem icon={<Archive aria-hidden />} danger onSelect={() => setArchiveOpen(true)}>Archive</MenuItem> : null}
            </MenuContent>
          </Menu>
        </div>
      </div>

      {readOnly ? <Banner tone="info" className="mb-6" title="View only" /> : null}
      {paused ? <Banner tone="warn" className="mb-6" title={`${session.workspace?.publishing_paused ? 'Workspace' : post.brand.name} paused — nothing will send`} /> : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card aria-label="Content">
            <Tabs value={tab} onValueChange={setTab}>
              <div className="px-4 pt-2"> 
                <TabsList label="Content per destination">
                  <TabsTrigger value="base">Base</TabsTrigger>
                  {selectedConns.map((c) => {
                    const v = draft.variants.find((x) => x.connectionId === c.id);
                    const n = issuesFor(c.id).length;
                    return (
                      <TabsTrigger key={c.id} value={c.id}>
                        <PlatformIcon provider={c.provider} size="xs" decorative />
                        <span className="max-w-[140px] truncate">{c.display_name}</span>
                        <span className="sr-only">({PROVIDER_LABEL[c.provider]}{v && !v.inheritText ? ', custom text' : ', inherited text'})</span>
                        {v && !v.inheritText ? <span aria-hidden className="rounded bg-raised px-1 text-[10px] text-muted">Custom</span> : null}
                        {n ? <span className="inline-flex items-center gap-0.5 text-[11px] text-danger"><ToneIcon tone="danger" className="size-3" />{n}<span className="sr-only"> issues</span></span> : null}
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </div>
              <div className="px-4 pb-6">
                <TabsContent value="base">
                  <BaseEditor
                    draft={draft}
                    onChange={(d) => edit({ draft: d })}
                    readOnly={readOnly}
                    brand={post.brand}
                    assets={assets}
                    onAssetsSeen={addAssets}
                    maxImages={baseMax}
                    canUpload={can('assets.upload')}
                    checksFor={selectedConns.map((c) => ({ connection: c, check: local.get(c.id)! })).filter((x) => x.check)}
                  />
                </TabsContent>
                {selectedConns.map((c) => {
                  const v = draft.variants.find((x) => x.connectionId === c.id);
                  if (!v) return null;
                  return (
                    <TabsContent key={c.id} value={c.id}>
                      <VariantEditor
                        draft={draft}
                        variant={v}
                        connection={c}
                        onChange={updateVariant}
                        readOnly={readOnly}
                        brandId={post.brand_id}
                        assets={assets}
                        onAssetsSeen={addAssets}
                        check={local.get(c.id)}
                        canUpload={can('assets.upload')}
                      />
                    </TabsContent>
                  );
                })}
              </div>
            </Tabs>
          </Card>

          <DeliveriesPanel post={post} onChanged={() => void refetch()} />
        </div>

        <aside className="flex min-w-0 flex-col gap-6" aria-label="Destinations, checks and preview">
          <Card aria-labelledby="h-dest">
            <CardHeader id="h-dest" title={<>Destinations <span className="ml-1 font-normal text-muted tabular">{connectionIds.length}<span className="sr-only"> selected</span></span></>} />
            <div className="px-2 pb-2">
              {post.connections.length === 0 ? (
                <EmptyState compact title="No accounts" action={can('connections.manage') ? <LinkButton href={`/accounts?brand=${post.brand_id}`} size="sm" variant="secondary">Connect</LinkButton> : null} />
              ) : (
                <DestinationPicker connections={post.connections} selected={connectionIds} onToggle={toggleDestination} readOnly={readOnly} />
              )}
            </div>
          </Card>

          <Card aria-labelledby="h-checks">
            <CardHeader
              id="h-checks"
              title="Checks"
              actions={<span className="text-xs text-subtle">{validating ? 'Checking…' : serverFresh ? 'Verified' : 'Live'}</span>}
            />
            <div className="px-4 pb-4" aria-live="polite">
              {!connectionIds.length ? <p className="text-[13px] text-muted">No destinations</p> : issues.length === 0 ? (
                <p className="flex items-center gap-2 text-[13px] text-muted"><CircleCheck aria-hidden className="size-4 text-success" /> Ready</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {generalIssues.map((i, n) => <IssueRow key={`g${n}`} issue={i} />)}
                  {selectedConns.filter((c) => issuesFor(c.id).length).map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => setTab(c.id)} className="mb-1.5 flex items-center gap-2 rounded text-[13px] font-medium hover:underline">
                        <PlatformIcon provider={c.provider} size="xs" decorative /> {c.display_name}
                      </button>
                      <ul className="flex flex-col gap-1.5">{issuesFor(c.id).map((i, n) => <IssueRow key={n} issue={i} />)}</ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          {previewConn && previewVariant ? (
            <Card aria-labelledby="h-preview">
              <CardHeader
                id="h-preview"
                title="Preview"
                actions={<>
                  {tab === 'base' && selectedConns.length > 1 ? (
                  <div className="w-[170px]">
                    <label className="sr-only" htmlFor="preview-as">Preview destination</label>
                    <Select id="preview-as" value={previewConn.id} onChange={(e) => setPreviewId(e.target.value)}>
                      {selectedConns.map((c) => <option key={c.id} value={c.id}>{PROVIDER_LABEL[c.provider]} · {c.display_name}</option>)}
                    </Select>
                  </div>
                  ) : null}
                </>}
              />
              <div className="px-4 pb-4"><VariantPreview variant={previewVariant} connection={previewConn} assets={assets} /></div>
            </Card>
          ) : null}
        </aside>
      </div>

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-16 z-20 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:bottom-0 md:left-[224px]">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-2 px-4 py-2 sm:px-6 md:px-8">
          <SaveStatus state={saveState} savedAt={savedAt} tz={tz} error={saveError} onRetry={() => void save()} onConflict={() => setConflictOpen(true)} readOnly={readOnly} />
          <span className="flex-1" />
          {!readOnly ? (
            <Button variant="ghost" size="md" icon={<Save aria-hidden className="size-4" />} onClick={() => void flush()} disabled={saveState === 'saved' || saveState === 'saving' || saveState === 'conflict'}>
              <span className="sr-only sm:not-sr-only">Save</span><span className="sr-only"> draft now</span>
            </Button>
          ) : null}
          {post.can.submit ? (
            <Button variant={post.can.schedule ? 'secondary' : 'primary'} icon={<Send aria-hidden className="size-4" />} onClick={() => setDialog('submit')} disabledReason={blockReason}>
              Submit<span className="sr-only"> for review</span>
            </Button>
          ) : null}
          {can('drafts.edit') || post.can.schedule ? (
            <Button
              variant={post.can.submit && !post.can.schedule ? 'secondary' : 'primary'}
              icon={<CalendarClock aria-hidden className="size-4" />}
              onClick={() => setDialog('schedule')}
              disabledReason={!post.can.schedule ? (post.can.schedule_reason ?? 'You can’t schedule this post.') : blockReason}
            >
              {post.current_schedule && (post.current_schedule.status === 'active' || post.current_schedule.status === 'pending_approval') ? 'Reschedule' : 'Schedule'}
            </Button>
          ) : null}
          {post.can.publish_now ? (
            <Button variant="secondary" icon={<SendHorizontal aria-hidden className="size-4" />} onClick={() => setDialog('publish')} disabledReason={blockReason}>
              Publish<span className="sr-only"> now</span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Dialogs */}
      <ScheduleDialog
        open={dialog === 'schedule'}
        onOpenChange={(o) => setDialog(o ? 'schedule' : null)}
        post={post}
        connectionIds={connectionIds}
        flush={flush}
        workspaceTz={workspaceTz}
        onConflict={(e) => { setConflict(((isApiError(e) ? e.details?.current : null) ?? {}) as ConflictDetails); setSaveState('conflict'); setConflictOpen(true); }}
        onDone={(r) => void afterAction('Scheduled', `${fmtTime(r.schedule.due_at, r.schedule.input_timezone)} ${zoneAbbr(r.schedule.due_at, r.schedule.input_timezone)} · ${r.deliveries.length} destination${r.deliveries.length === 1 ? '' : 's'}`)}
      />
      <SubmitDialog
        open={dialog === 'submit'}
        onOpenChange={(o) => setDialog(o ? 'submit' : null)}
        post={post}
        connectionIds={connectionIds}
        flush={flush}
        workspaceTz={workspaceTz}
        onConflict={(e) => { setConflict(((isApiError(e) ? e.details?.current : null) ?? {}) as ConflictDetails); setSaveState('conflict'); setConflictOpen(true); }}
        onDone={() => void afterAction('Submitted for review')}
      />
      <PublishNowDialog
        open={dialog === 'publish'}
        onOpenChange={(o) => setDialog(o ? 'publish' : null)}
        post={post}
        variants={resolved}
        assets={assets}
        flush={flush}
        onConflict={(e) => { setConflict(((isApiError(e) ? e.details?.current : null) ?? {}) as ConflictDetails); setSaveState('conflict'); setConflictOpen(true); }}
        onDone={(r) => void afterAction(allMockOf(r.deliveries) ? 'Simulated publish started' : 'Publishing started')}
      />
      <ConflictDialog
        open={conflictOpen}
        onOpenChange={setConflictOpen}
        details={conflict}
        onReload={async () => { dirty.current = false; await reload(); }}
        onKeepCopy={keepCopy}
      />
      <ConfirmDialog
        open={!!pendingRemove}
        onOpenChange={(o) => !o && setPendingRemove(null)}
        title={`Remove ${pendingRemove?.display_name ?? 'destination'}?`}
        description="Its custom content will be discarded."
        confirmLabel="Remove"
        confirmVariant="danger"
        onConfirm={() => { if (pendingRemove) removeDestination(pendingRemove.id); }}
      />
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive this post?"
        description="Hidden from the planner. Cancel any active schedule first."
        confirmLabel="Archive"
        confirmVariant="danger"
        onConfirm={async () => {
          await api.post(`/api/posts/${post.id}/archive`, {});
          dirty.current = false;
          toast.success('Post archived');
          router.push('/planner');
        }}
      />
    </div>
  );
}

function allMockOf(ds: Array<{ is_mock: boolean }>) {
  return ds.length > 0 && ds.every((d) => d.is_mock);
}

function normaliseDraft(d: DraftContent | null | undefined): DraftContent {
  return {
    baseText: d?.baseText ?? '',
    baseLink: d?.baseLink ?? null,
    baseAssetIds: d?.baseAssetIds ?? [],
    variants: d?.variants ?? [],
  };
}

function IssueRow({ issue }: { issue: ValidationIssue }) {
  return (
    <li className="flex items-start gap-2 text-[13px]">
      <ToneIcon tone="danger" className="mt-0.5" />
      <span>{issue.message}</span>
    </li>
  );
}

function SaveStatus({
  state, savedAt, tz, error, onRetry, onConflict, readOnly,
}: { state: SaveState; savedAt: string; tz: string; error: unknown; onRetry: () => void; onConflict: () => void; readOnly: boolean }) {
  if (readOnly) return <span className="text-xs text-muted">Read only</span>;
  return (
    <div role="status" aria-live="polite" className="flex min-w-0 items-center gap-2 text-[13px]">
      {state === 'saving' ? (
        <><LoaderCircle aria-hidden className="size-4 anim-spin text-info" /><span className="text-muted">Saving…</span></>
      ) : state === 'dirty' ? (
        <><span aria-hidden className="size-2 rounded-full bg-[var(--warn)]" /><span className="text-muted">Unsaved</span></>
      ) : state === 'failed' ? (
        <>
          <CloudAlert aria-hidden className="size-4 text-danger" />
          <span className="truncate text-danger">Couldn’t save{isApiError(error) && error.isNetwork ? ' — offline' : ''}</span>
          <Button size="sm" variant="quiet" onClick={onRetry}>Retry</Button>
        </>
      ) : state === 'conflict' ? (
        <>
          <ToneIcon tone="warn" />
          <span className="text-warn">Edited elsewhere</span>
          <Button size="sm" variant="quiet" onClick={onConflict}>Resolve</Button>
        </>
      ) : (
        <><CircleCheck aria-hidden className="size-4 text-success" /><span className="sr-only text-muted sm:not-sr-only">Saved {fmtTime(savedAt, tz)} {zoneAbbr(savedAt, tz)}</span></>
      )}
    </div>
  );
}
