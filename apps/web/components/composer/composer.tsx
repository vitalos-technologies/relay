'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, CalendarClock, CircleCheck, Copy, Ellipsis, History, ListPlus, MessageSquare, MessageSquarePlus, Save, Send, SendHorizontal, Trash2,
} from 'lucide-react';
import type { AutosaveResponse, DraftRecoveryStatus, RecoverResponse } from '@social-lite/core/contracts/v31-data';
import { AUTOSAVE_DEBOUNCE_MS } from '@social-lite/core/contracts/v31-data';
import { PROVIDER_LABEL, applyFields, resolveVariants, type DraftContent, type DraftField, type ValidationIssue, type VariantDraft } from '@social-lite/core';
import { api, isApiError } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { useSession } from '@/lib/client/session';
import { useOnline } from '@/lib/client/hooks';
import { fmtTime, zoneAbbr } from '@/lib/client/format';
import { constraintsOf, localChecks } from '@/lib/client/variants';
import type { Asset, Connection, PostDetail, ValidateResponse } from '@/lib/client/types';
import {
  Banner, Button, Card, CardHeader, cn, ConfirmDialog, Drawer, EmptyState, ErrorState, IconButton, InfoTip, LinkButton, Menu, MenuContent, MenuItem,
  MenuLabel, MenuTrigger, PlatformIcon, PostStatusBadge, Segmented, Select, Skeleton, ToneIcon, useToast,
} from '@/components/ui';
import { BaseEditor, VariantEditor } from './editors';
import { ContentSwitcher, DestinationSelector } from './destination-rail';
import { ProviderOptions } from './provider-options';
import { VariantPreview } from './preview';
import { PublishNowDialog, ScheduleDialog, SubmitDialog } from './action-dialogs';
import { DraftConflictDialog, RecoveryBanner, SaveStatus, type ComposerSaveState, type ConflictCurrent } from './draft-resilience';
import {
  clearLocalDraft, editorClientId, nextClientRevision, readLocalDraft, sameContent, writeLocalDraft, type LocalDraft,
} from '@/lib/client/draft-recovery';
import dynamic from 'next/dynamic';
const HistoryPanel = dynamic(() => import('@/components/collab/history-panel').then((m) => m.HistoryPanel));
import { TrashConfirmDialog, useTrashActions } from '@/components/trash/trash-actions';
import { runSingleBulk } from '@/components/bulk/bulk';
import { FindingList } from '@/components/brand-rules/brand-rules-settings';
import { ProvenanceLink, ReuseCard, SimilarList, useSimilar } from './reuse-panel';
import { LinkBuilderButton, LinkBuilderDialog } from '@/components/links/links';
import { useFlag } from '@/lib/client/flags';
import type { ReuseResult } from '@social-lite/core/contracts/v31-gov';
import { DeliveriesPanel } from './deliveries-panel';
import { AiAssist } from '@/components/ai/assist';
import { VariantCrops } from '@/components/crops/variant-crops';
import { QueueButton, useQueueAction } from '@/components/slots/queue-button';
import { COLLAB_TABS, CollabPanel, type CollabTab } from '@/components/collab/collab-panel';
import { PresenceBar } from '@/components/collab/presence';
import type { ThreadAnchor } from '@/components/collab/types';
import { useCollabSync, usePresence, type CollabEvent } from '@/lib/client/collab';
import { conflictCopyFor, rememberConflictCopy } from '@/components/collab/conflict-copy';

type SaveState = ComposerSaveState;
type ConflictDetails = ConflictCurrent;

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
  // Published posts open read-only; editing them is an explicit choice (Duplicate is the default path).
  const [editPublished, setEditPublished] = useState(false);
  const isPublished = post.status === 'published';
  const readOnly = !post.can.edit || (isPublished && !editPublished);

  // ---------------------------------------------------------------- local working state
  const [draft, setDraft] = useState<DraftContent>(() => normaliseDraft(post.draft));
  const [title, setTitle] = useState(post.title ?? '');
  const latest = useRef({ draft, title });
  // Last content this tab knows the server has (loaded or acknowledged) — the base for 3-way conflict choices.
  const serverSnap = useRef<{ title: string; draft: DraftContent }>({ title: post.title ?? '', draft: normaliseDraft(post.draft) });
  const versionRef = useRef(post.version);
  const [version, setVersion] = useState(post.version);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [savedAt, setSavedAt] = useState<string>(post.updated_at);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<ConflictDetails | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  // V2: a rejected concurrent save is kept server-side as a conflict copy (History tab) — both versions recoverable.
  const [conflictCopy, setConflictCopy] = useState<string | null>(() => conflictCopyFor(post.id));
  // Collaboration panel: deep links ?thread=<id> / ?panel=<tab>; desktop side panel (collapsible), sheet below xl.
  const search = useSearchParams();
  const focusThread = search.get('thread');
  const panelParam = search.get('panel') as CollabTab | null;
  const [collabTab, setCollabTab] = useState<CollabTab>(() => (focusThread ? 'discussion' : panelParam && COLLAB_TABS.includes(panelParam) ? panelParam : conflictCopyFor(post.id) ? 'history' : 'discussion'));
  const [sheetOpen, setSheetOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem('relay:collab-collapsed') === '1'); } catch { /* storage unavailable */ }
    // Below xl the panel lives in a sheet: open it straight away for a deep link.
    if ((focusThread || panelParam) && typeof window !== 'undefined') {
      if (!window.matchMedia('(min-width: 1280px)').matches) setSheetOpen(true);
      else {
        setCollapsed(false);
        setTimeout(() => scrollToPanel(), 400);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setCollapsedPersist = (c: boolean) => { setCollapsed(c); try { localStorage.setItem('relay:collab-collapsed', c ? '1' : '0'); } catch { /* ignore */ } };
  const [refresh, setRefresh] = useState({ discussion: 0, tasks: 0, review: 0, activity: 0 });
  const [counts, setCounts] = useState({ unread: 0, open: 0, tasks: 0 });
  const [selection, setSelection] = useState<ThreadAnchor | null>(null);
  const [pendingSelection, setPendingSelection] = useState<ThreadAnchor | null>(null);
  const [remote, setRemote] = useState<{ version: number; by: string | null } | null>(null);
  const [startCursor, setStartCursor] = useState<number | null>(null);
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
  const [step, setStep] = useState<'setup' | 'write' | 'preview'>('write');
  const [previewId, setPreviewId] = useState<string>('');
  const [dialog, setDialog] = useState<null | 'schedule' | 'submit' | 'publish'>(null);
  const [pendingRemove, setPendingRemove] = useState<Connection | null>(null);
  const [server, setServer] = useState<{ version: number; result: ValidateResponse } | null>(null);
  const [validating, setValidating] = useState(false);

  // ---------------------------------------------------------------- autosave (V3.1 §9)
  // PUT /api/posts/:id/autosave with base_version + this tab's client id/revision. Only status 'saved' means saved.
  // Between edits and the server ack, the content is also kept in this browser per the workspace policy
  // (session.draft_recovery): that is "Saved locally", never "Saved".
  const policy = session.draft_recovery ?? null;
  const lastFailed = useRef<{ snap: { draft: DraftContent; title: string }; rev: number } | null>(null);
  const localTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localSaved, setLocalSaved] = useState(false);
  const recoveryPending = useRef(false);
  const retries = useRef(0);

  const writeLocal = useCallback((): boolean => {
    if (localTimer.current) { clearTimeout(localTimer.current); localTimer.current = null; }
    // While a recovered copy awaits a decision, don't overwrite it.
    if (recoveryPending.current || !dirty.current) return false;
    const ok = writeLocalDraft(policy, post.id, { base_version: versionRef.current, draft: latest.current.draft, title: latest.current.title.trim() || null });
    setLocalSaved(ok);
    return ok;
  }, [policy, post.id]);

  const save = useCallback(async (): Promise<boolean> => {
    if (inflight.current) {
      await inflight.current;
      return dirty.current && saveStateRef.current !== 'conflict' ? save() : !dirty.current;
    }
    if (!dirty.current) return true;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      writeLocal();
      setSaveState('offline');
      return false;
    }
    const snapshot = latest.current;
    // A retry of the same content reuses its revision so the server can recognise it.
    const rev = lastFailed.current && lastFailed.current.snap === snapshot ? lastFailed.current.rev : nextClientRevision();
    dirty.current = false;
    setSaveState('saving');
    const p = (async () => {
      try {
        const r = await api.put<AutosaveResponse>(`/api/posts/${post.id}/autosave`, {
          base_version: versionRef.current, client_id: editorClientId(), client_revision: rev,
          draft: snapshot.draft, title: snapshot.title.trim() || null,
        });
        lastFailed.current = null;
        retries.current = 0;
        versionRef.current = r.status === 'saved' ? r.version : Math.max(versionRef.current, r.version);
        setVersion(versionRef.current);
        if (r.status === 'saved') { setSavedAt(r.saved_at); serverSnap.current = { title: snapshot.title, draft: snapshot.draft }; }
        setSaveError(null);
        if (dirty.current) setSaveState('dirty');
        else {
          if (!recoveryPending.current) clearLocalDraft(policy, post.id);
          setLocalSaved(false);
          setSaveState('saved');
        }
        return true;
      } catch (e) {
        dirty.current = true;
        if (isApiError(e) && e.code === 'version_conflict') {
          const cur = (e.details?.current ?? {}) as ConflictDetails;
          const copyId = typeof e.details?.conflict_copy_id === 'string' ? e.details.conflict_copy_id : null;
          if (copyId) { rememberConflictCopy(post.id, copyId); setConflictCopy(copyId); }
          writeLocal();
          setConflict(cur);
          setConflictOpen(true);
          setSaveState('conflict');
        } else {
          lastFailed.current = { snap: snapshot, rev };
          const local = writeLocal();
          setSaveError(e);
          setSaveState(isApiError(e) && e.isNetwork ? 'offline' : local ? 'saved_locally' : 'save_failed');
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
  }, [post.id, policy, writeLocal]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (saveStateRef.current !== 'conflict') void save();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [save]);
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  const edit = (next: { draft?: DraftContent; title?: string }) => {
    if (readOnly) return;
    if (next.draft) setDraft(next.draft);
    if (next.title !== undefined) setTitle(next.title);
    latest.current = { draft: next.draft ?? latest.current.draft, title: next.title ?? latest.current.title };
    dirty.current = true;
    if (saveStateRef.current !== 'conflict' && saveStateRef.current !== 'offline') setSaveState('dirty');
    // Keep a browser copy shortly after typing pauses (cheap, off the keystroke path).
    if (localTimer.current) clearTimeout(localTimer.current);
    localTimer.current = setTimeout(() => { localTimer.current = null; writeLocal(); }, 250);
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

  // Back online: save straight away. Other failures retry with backoff (5 s → 60 s).
  useEffect(() => {
    if (online && saveState === 'offline') { void save(); return; }
    if (saveState !== 'save_failed' && saveState !== 'saved_locally') return;
    const t = setTimeout(() => { retries.current += 1; void save(); }, Math.min(60_000, 5_000 * 2 ** retries.current));
    return () => clearTimeout(t);
  }, [online, saveState, save]);

  // Leaving with unsaved edits: keep the browser copy now and warn.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty.current || inflight.current) {
        writeLocal();
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const hide = () => { if (dirty.current) writeLocal(); };
    window.addEventListener('beforeunload', h);
    window.addEventListener('pagehide', hide);
    return () => {
      window.removeEventListener('beforeunload', h);
      window.removeEventListener('pagehide', hide);
    };
  }, [writeLocal]);

  // ---------------------------------------------------------------- recovery after refresh / restart
  // A copy in this browser that differs from the server is offered, never synced on its own. The server re-checks
  // permission and revision (recovery-status, then recover): a newer server version is never overwritten.
  const [recovery, setRecovery] = useState<null | { local: LocalDraft; status: DraftRecoveryStatus | null }>(null);
  useEffect(() => {
    if (!post.can.edit) return;
    const local = readLocalDraft(policy, post.id);
    if (!local) return;
    if (sameContent(local, { draft: normaliseDraft(post.draft), title: post.title })) { clearLocalDraft(policy, post.id); return; }
    recoveryPending.current = true;
    let live = true;
    api.get<DraftRecoveryStatus>(`/api/posts/${post.id}/recovery-status`, { base_version: local.base_version })
      .then((status) => { if (live) setRecovery({ local, status }); })
      .catch(() => { if (live) setRecovery({ local, status: null }); });
    return () => { live = false; };
    // Runs once per loaded post version (the composer remounts after a reload).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const endRecovery = () => {
    recoveryPending.current = false;
    clearLocalDraft(policy, post.id);
    setRecovery(null);
    if (dirty.current) writeLocal();
  };
  const restoreLocal = async () => {
    if (!recovery) return;
    const r = await api.post<RecoverResponse>(`/api/posts/${post.id}/recover`, {
      base_version: recovery.local.base_version, client_id: editorClientId(), draft: recovery.local.draft,
      title: recovery.local.title, local_saved_at: recovery.local.saved_at,
    });
    recoveryPending.current = false;
    clearLocalDraft(policy, post.id);
    if (r.status === 'kept_as_copy') {
      rememberConflictCopy(post.id, r.conflict_copy_id);
      toast.info('Kept as a copy in History', 'The server had a newer version.');
    } else {
      toast.success('Restored');
    }
    dirty.current = false;
    await reload();
  };
  const keepLocalAsCopy = async () => {
    if (!recovery) return;
    const r = await api.post<RecoverResponse>(`/api/posts/${post.id}/recover`, {
      base_version: recovery.local.base_version, client_id: editorClientId(), draft: recovery.local.draft,
      title: recovery.local.title, local_saved_at: recovery.local.saved_at,
    });
    if (r.status === 'kept_as_copy') { rememberConflictCopy(post.id, r.conflict_copy_id); setConflictCopy(r.conflict_copy_id); }
    toast.success(r.status === 'kept_as_copy' ? 'Kept as a copy in History' : 'Restored');
    if (r.status === 'applied') { recoveryPending.current = false; clearLocalDraft(policy, post.id); dirty.current = false; await reload(); return; }
    setCollabTab('history');
    endRecovery();
  };
  const [historyOpen, setHistoryOpen] = useState(false);

  // ---------------------------------------------------------------- collaboration sync (events) + presence
  useEffect(() => {
    let live = true;
    api.get<{ cursor: number }>(`/api/collab/events`, { post: post.id, after: 'now' }).then((r) => { if (live) setStartCursor(r.cursor); }).catch(() => { if (live) setStartCursor(0); });
    return () => { live = false; };
  }, [post.id]);
  const onCollabEvents = useCallback((events: CollabEvent[], meta: { reset: boolean }) => {
    const bump = { discussion: 0, tasks: 0, review: 0, activity: 0 };
    if (meta.reset) { bump.discussion = bump.tasks = bump.review = bump.activity = 1; }
    for (const e of events) {
      if (e.kind.startsWith('comment.') || e.kind.startsWith('thread.')) bump.discussion = 1;
      if (e.kind.startsWith('task.')) bump.tasks = 1;
      if (e.kind === 'review.updated') bump.review = 1;
      if (e.kind !== 'notification') bump.activity = 1;
      if (e.kind === 'post.saved' && !e.mine) {
        const v = Number(e.ref_id);
        if (Number.isFinite(v) && v > versionRef.current) setRemote({ version: v, by: null });
      }
    }
    if (bump.review) void refetch();
    setRefresh((r) => ({ discussion: r.discussion + bump.discussion, tasks: r.tasks + bump.tasks, review: r.review + bump.review, activity: r.activity + bump.activity }));
    // After a reconnect gap: re-check the server version (never trust that nothing changed while offline).
    if (meta.reset) {
      void api.get<DraftRecoveryStatus>(`/api/posts/${post.id}/recovery-status`, { base_version: versionRef.current })
        .then((st) => { if (st.server_newer) setRemote({ version: st.current_version, by: st.updated_by }); }).catch(() => undefined);
    }
  }, [post.id, refetch]);
  const syncStatus = useCollabSync(post.id, startCursor, onCollabEvents);
  const presence = usePresence(post.id, !readOnly && (saveState === 'dirty' || saveState === 'saving'));
  // Selected text in an editor → "Comment on selection" (the thread keeps the quote against this version).
  useEffect(() => {
    const capture = () => {
      const el = document.activeElement as HTMLTextAreaElement | null;
      if (!el || el.tagName !== 'TEXTAREA' || !el.dataset.anchorField) { setPendingSelection(null); return; }
      const [a, b] = [el.selectionStart ?? 0, el.selectionEnd ?? 0];
      if (b - a < 2) { setPendingSelection(null); return; }
      const field = el.dataset.anchorField as 'base' | 'variant';
      setPendingSelection({ kind: 'text', field, connection_id: field === 'variant' ? el.dataset.connectionId ?? null : null,
        quote: el.value.slice(a, b).slice(0, 500), prefix: el.value.slice(Math.max(0, a - 40), a), suffix: el.value.slice(b, b + 40) });
    };
    document.addEventListener('selectionchange', capture);
    return () => document.removeEventListener('selectionchange', capture);
  }, []);
  const openCollab = (tab: CollabTab) => {
    setCollabTab(tab);
    if (window.matchMedia('(min-width: 1280px)').matches) {
      setCollapsedPersist(false);
      requestAnimationFrame(() => scrollToPanel());
    } else setSheetOpen(true);
  };
  const reviewRemote = async () => {
    try {
      const fresh = await api.get<PostDetail>(`/api/posts/${post.id}`);
      setConflict({ version: fresh.version, updated_by: fresh.updated_by_email ?? null, updated_at: fresh.updated_at, title: fresh.title, draft: fresh.draft });
      setConflictOpen(true);
    } catch (e) { toast.error(e, 'Couldn’t load the latest version'); }
  };
  const linksOn = useFlag('v31.tracked_links');
  const [linkOpen, setLinkOpen] = useState(false);
  const planning = useApi<{ campaign: { id: string } | null }>(linksOn ? `/api/posts/${post.id}/planning` : null);

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
  // Brand findings come only from the server; the last result stays until the next check (mandatory ones block).
  const brand = server?.result.brand_rules ?? null;
  const brandFindings = brand ? [...brand.mandatory, ...brand.advisory].filter((f) => !f.connection_id || connectionIds.includes(f.connection_id)) : [];
  const brandMandatory = brandFindings.filter((f) => f.severity === 'mandatory');
  const similar = useSimilar(post.id, version, !readOnly && connectionIds.length > 0);
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
  // AI suggestion accepted by the user: apply locally, then save via PATCH with expected_version.
  const acceptSuggestion = (scope: string, text: string) => {
    const d = latest.current.draft;
    edit({ draft: scope === 'base' ? { ...d, baseText: text } : { ...d, variants: d.variants.map((x) => (x.connectionId === scope ? { ...x, inheritText: false, text } : x)) } });
    void flush();
  };

  // ---------------------------------------------------------------- other actions
  const duplicate = async () => {
    try {
      await flush();
      // V3.1 §13: a new draft with provenance (never a re-publication of the original).
      const r = await api.post<ReuseResult>(`/api/posts/${post.id}/reuse`, { mode: 'duplicate' }, { idempotent: true });
      toast.success('Duplicated as a new draft', r.similar.length ? `${r.similar.length} similar recent post${r.similar.length === 1 ? '' : 's'} on these destinations` : undefined);
      router.push(`/posts/${r.post_id}`);
    } catch (e) {
      toast.error(e, 'Could not duplicate');
    }
  };
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const trashActions = useTrashActions();
  const queue = useQueueAction(post.id, flush, (t, b) => void afterAction(t, b));
  const keepCopy = async () => {
    const mine = latest.current;
    const p = await api.post<PostDetail>(`/api/brands/${post.brand_id}/posts`, {
      title: `${mine.title.trim() || 'Untitled post'} (my copy)`, draft: mine.draft, connection_ids: connectionIds,
    }, { idempotent: true });
    dirty.current = false;
    clearLocalDraft(policy, post.id);
    router.push(`/posts/${p.id}`);
  };
  const takeTheirs = async () => { dirty.current = false; clearLocalDraft(policy, post.id); setRemote(null); await reload(); };
  const applySelected = async (fields: DraftField[]) => {
    // Apply the chosen parts of mine on top of the latest server version (a normal optimistic save). Theirs stays in
    // history, and the server re-checks the version: if it moved again, this dialog comes back.
    if (!conflict?.version || !conflict.draft) return;
    const merged = applyFields({ title: conflict.title ?? '', draft: normaliseDraft(conflict.draft) }, { title: latest.current.title, draft: latest.current.draft }, fields);
    setDraft(merged.draft);
    setTitle(merged.title ?? '');
    latest.current = { draft: merged.draft, title: merged.title ?? '' };
    versionRef.current = conflict.version;
    lastFailed.current = null;
    dirty.current = true;
    saveStateRef.current = 'dirty';
    setSaveState('dirty');
    setRemote(null);
    const ok = await save();
    if (!ok) throw new Error((saveStateRef.current as SaveState) === 'conflict' ? 'It changed again. Compare and choose.' : 'Couldn’t save yours. Try again.');
  };
  const afterAction = async (msg: string, body?: string) => {
    toast.success(msg, body);
    await refetch();
    requestAnimationFrame(() => document.getElementById('deliveries')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  // ---------------------------------------------------------------- render helpers
  const blockReason =
    !online ? 'You’re offline. Drafting only.'
    : saveState === 'conflict' ? 'Resolve the conflict first.'
      : !connectionIds.length ? 'Pick a destination.'
        : issues.length ? `Fix ${issues.length} issue${issues.length === 1 ? '' : 's'} first.`
          : brandMandatory.length ? `Brand rule: ${brandMandatory[0]!.message}`
            : null;
  const tz = post.brand.timezone;
  const workspaceTz = session.workspace?.timezone;
  const paused = session.workspace?.publishing_paused || post.brand.publishing_paused;
  const allMock = post.destinations.length > 0 && post.destinations.every((d) => d.is_mock);
  const previewConn = selectedConns.find((c) => c.id === (tab !== 'base' ? tab : previewId)) ?? selectedConns[0];
  const previewVariant = previewConn ? resolved.find((r) => r.connectionId === previewConn.id) : undefined;
  const primaryIsSubmit = post.can.submit && !post.can.schedule;
  const showQueue = !readOnly && can('drafts.edit') && (post.can.schedule || post.can.submit);
  const activeConn = tab !== 'base' ? selectedConns.find((c) => c.id === tab) : undefined;
  const activeVariant = activeConn ? draft.variants.find((x) => x.connectionId === activeConn.id) : undefined;

  const collabProps = {
    postId: post.id, brandId: post.brand_id, tz: post.brand.timezone, version, canEdit: !readOnly, approvalId: post.approval?.id ?? null,
    approvalRequired: post.brand.approval_required, tab: collabTab, onTab: setCollabTab, highlightVersion: conflictCopy, focusThread,
    refresh, counts, onCounts: (c: Partial<typeof counts>) => setCounts((x) => ({ ...x, ...c })), selection, onClearSelection: () => setSelection(null),
    onRestored: async () => { rememberConflictCopy(post.id, null); dirty.current = false; await reload(); },
  };

  return (
    <div className="pb-24">
      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="mb-1 flex items-center gap-1 truncate text-xs text-subtle">{post.brand.name}<InfoTip label="About the title">Internal title — never published.</InfoTip><span className="ml-2"><ProvenanceLink postId={post.id} /></span></p>
          <h1 className="sr-only">Edit post{title.trim() ? `: ${title.trim()}` : ''}</h1>
          <label htmlFor="post-title" className="sr-only">Post title (internal)</label>
          <textarea
            id="post-title"
            rows={1}
            value={title}
            readOnly={readOnly}
            onChange={(e) => edit({ title: e.target.value.replace(/[\r\n]+/g, ' ') })}
            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
            placeholder="Untitled post"
            maxLength={200}
            className="block max-h-[2.5em] w-full resize-none overflow-hidden rounded-md bg-transparent text-[22px] font-semibold leading-[1.25] tracking-[-0.01em] [field-sizing:content] placeholder:text-subtle focus:max-h-none sm:text-[28px]"
          />
        </div>
        <div className="flex items-center gap-2">
          <PresenceBar people={presence.people} />
          <Button size="sm" variant="secondary" icon={<MessageSquare aria-hidden className="size-4" />} onClick={() => openCollab(collabTab)}
            aria-label={counts.unread ? `Collaborate, ${counts.unread} unread` : 'Collaborate'}>
            <span className="max-sm:sr-only">Collaborate</span>{counts.unread ? <span className="ml-1 rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold text-[var(--on-accent)] tabular">{counts.unread}</span> : null}
          </Button>
          <PostStatusBadge status={post.status} simulated={allMock} />
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="More post actions" icon={<Ellipsis aria-hidden className="size-4" />} />
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={<History aria-hidden />} onSelect={() => setHistoryOpen(true)}>Version history</MenuItem>
              {can('drafts.edit') ? <MenuItem icon={<Copy aria-hidden />} onSelect={() => void duplicate()}>Duplicate</MenuItem> : null}
              {post.can.edit ? <MenuItem icon={<Archive aria-hidden />} onSelect={() => setArchiveOpen(true)}>Archive</MenuItem> : null}
              {post.can.edit && !isPublished ? <MenuItem icon={<Trash2 aria-hidden />} danger onSelect={() => setTrashOpen(true)}>Move to Trash</MenuItem> : null}
            </MenuContent>
          </Menu>
        </div>
      </div>

      {readOnly ? (
        <Banner
          tone="info"
          className="mb-6"
          title={isPublished ? (allMock ? 'Delivered to simulated destinations · read only' : 'Published · read only') : 'View only'}
          actions={<>
            {can('drafts.edit') ? <Button size="sm" variant="secondary" icon={<Copy aria-hidden className="size-4" />} onClick={() => void duplicate()}>Duplicate</Button> : null}
            {isPublished && post.can.edit ? <Button size="sm" variant="ghost" onClick={() => setEditPublished(true)}>Edit</Button> : null}
          </>}
        />
      ) : null}
      {paused ? <Banner tone="warn" className="mb-6" title={`${session.workspace?.publishing_paused ? 'Workspace' : post.brand.name} paused — nothing will send`} /> : null}
      {remote && remote.version > version && !readOnly ? (
        <Banner tone="info" className="mb-6" role="status" title={`A newer version was saved (v${remote.version})${remote.by ? ` by ${remote.by}` : ''}`}
          actions={dirty.current || saveState !== 'saved'
            ? <Button size="sm" variant="primary" onClick={() => void reviewRemote()}>Review changes</Button>
            : <Button size="sm" variant="primary" onClick={() => void takeTheirs()}>Load latest</Button>}>
          <p className="text-muted">{dirty.current || saveState !== 'saved' ? 'You have unsaved edits. Nothing will be overwritten: compare first.' : 'You haven’t changed anything since.'}</p>
        </Banner>
      ) : null}
      {syncStatus === 'revoked' ? <Banner tone="warn" className="mb-6" title="Your access to this post changed">Reload to see what you can do now.</Banner> : null}
      {recovery && !readOnly ? (
        <RecoveryBanner local={recovery.local} status={recovery.status} onRestore={restoreLocal} onKeepCopy={keepLocalAsCopy} onDiscard={endRecovery} />
      ) : null}

      {/* Mobile: three steps; ≥1024 the regions sit side by side */}
      <div className="mb-4 lg:hidden">
        <Segmented
          label="Composer step"
          value={step}
          onChange={setStep}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          options={[
            { value: 'setup', label: <>Destinations <span className="tabular text-muted">{connectionIds.length}</span></> },
            { value: 'write', label: 'Write' },
            { value: 'preview', label: <>Preview{issues.length ? <span className="ml-1 rounded-full bg-danger-soft px-1.5 text-[11px] text-danger tabular">{issues.length}</span> : null}</> },
          ]}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_364px]">
        {/* Region 1: content switcher + destinations */}
        <aside className={cn('flex min-w-0 flex-col gap-4 lg:row-span-2 xl:row-span-1', step !== 'setup' && 'max-lg:hidden')} aria-label="Destinations">
          <Card className="p-2">
            <ContentSwitcher selected={selectedConns} variants={draft.variants} active={tab} onActive={(id) => { setTab(id); setStep('write'); }} issueCount={(id) => issuesFor(id).length} />
          </Card>
          <Card aria-labelledby="h-dest">
            <CardHeader id="h-dest" className="min-h-12 pt-3" title={<>Destinations <span className="ml-1 font-normal text-muted tabular">{connectionIds.length}<span className="sr-only"> selected</span></span></>} />
            <div className="px-2 pb-3">
              {post.connections.length === 0 ? (
                <EmptyState compact title="No accounts" action={can('connections.manage') ? <LinkButton href={`/accounts?brand=${post.brand_id}`} size="sm" variant="secondary">Connect</LinkButton> : null} />
              ) : (
                <DestinationSelector connections={post.connections} selected={connectionIds} onToggle={toggleDestination} readOnly={readOnly} />
              )}
            </div>
          </Card>
        </aside>

        {/* Region 2: editor */}
        <div className={cn('flex min-w-0 flex-col gap-6', step !== 'write' && 'max-lg:hidden')}>
          <Card aria-label="Content" className="p-4 sm:p-5">
            {tab === 'base' || !activeConn || !activeVariant ? (
              <>
                <div className="mb-4 flex items-center justify-between gap-2">
                  <h2 className="text-[15px] font-semibold">Base content</h2>
                  {pendingSelection ? (
                    <Button size="sm" variant="secondary" icon={<MessageSquarePlus aria-hidden className="size-4" />}
                      onMouseDown={(e) => e.preventDefault()} onClick={() => { setSelection(pendingSelection); openCollab('discussion'); }}>Comment on selection</Button>
                  ) : selectedConns.length ? <span className="text-xs text-muted">Shared by {selectedConns.length === 1 ? '1 destination' : `${selectedConns.length} destinations`}</span> : null}
                </div>
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
                  linkTools={linksOn ? <LinkBuilderButton onClick={() => setLinkOpen(true)} /> : undefined}
                />
              </>
            ) : (
              <div className="flex flex-col gap-6">
                <VariantEditor
                  draft={draft}
                  variant={activeVariant}
                  connection={activeConn}
                  onChange={updateVariant}
                  readOnly={readOnly}
                  brandId={post.brand_id}
                  assets={assets}
                  onAssetsSeen={addAssets}
                  check={local.get(activeConn.id)}
                  canUpload={can('assets.upload')}
                  issueCount={issuesFor(activeConn.id).length}
                />
                <ProviderOptions
                  connection={activeConn}
                  variant={activeVariant}
                  onChange={updateVariant}
                  readOnly={readOnly}
                  issues={issuesFor(activeConn.id).filter((i) => i.field === 'options').map((i) => i.message)}
                />
                <VariantCrops draft={draft} variant={activeVariant} assets={assets} onChange={updateVariant} readOnly={readOnly} />
              </div>
            )}
          </Card>

          <DeliveriesPanel post={post} onChanged={() => void refetch()} />
        </div>

        {/* Region 3: readiness + live preview + collaboration */}
        <aside id="composer-side" className={cn('flex min-w-0 flex-col gap-6 lg:col-start-2 xl:col-start-3 xl:row-start-1 xl:sticky xl:top-[72px] xl:max-h-[calc(100dvh-148px)] xl:self-start xl:overflow-y-auto xl:overscroll-contain xl:pb-2', step !== 'preview' && 'max-lg:hidden')} aria-label="Checks, preview and collaboration">
          <Card aria-labelledby="h-checks">
            <CardHeader
              id="h-checks"
              className="min-h-12 pt-3"
              title="Readiness"
              actions={<span className="text-xs text-subtle">{validating ? 'Checking…' : serverFresh ? 'Verified' : 'Live'}</span>}
            />
            <div className="px-4 pb-4" aria-live="polite">
              {brandFindings.length ? (
                <div className="mb-3" data-testid="brand-findings">
                  <p className="mb-1.5 text-xs font-medium text-muted">Brand rules</p>
                  <FindingList findings={brandFindings} />
                </div>
              ) : null}
              {similar.length ? <div className="mb-3"><SimilarList items={similar} connections={post.connections} /></div> : null}
              {!connectionIds.length ? <p className="text-[13px] text-muted">No destinations</p> : issues.length === 0 ? (brandMandatory.length ? null : (
                <p className="flex items-center gap-2 text-[13px] text-muted"><CircleCheck aria-hidden className="size-4 text-success" /> Ready</p>
              )) : (
                <ul className="flex flex-col gap-3">
                  {generalIssues.map((i, n) => <IssueRow key={`g${n}`} issue={i} />)}
                  {groupIssues(selectedConns, issuesFor).map((g) => (
                    <li key={g.key} className="flex items-start gap-2 text-[13px]">
                      <ToneIcon tone="danger" className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p>{g.message}</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {g.conns.map((c) => (
                            <button key={c.id} type="button" onClick={() => { setTab(c.id); setStep('write'); }} className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs hover:bg-raised" aria-label={`Edit ${PROVIDER_LABEL[c.provider]} ${c.display_name}`}>
                              <PlatformIcon provider={c.provider} size="xs" decorative className="size-4 rounded-[4px] [&>svg]:size-2.5" />{g.conns.length > 1 ? PROVIDER_LABEL[c.provider] : c.display_name}
                            </button>
                          ))}
                        </div>
                      </div>
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
                className="min-h-12 pt-3"
                title="Preview"
                actions={tab === 'base' && selectedConns.length > 1 ? (
                  <div className="w-[170px]">
                    <label className="sr-only" htmlFor="preview-as">Preview destination</label>
                    <Select id="preview-as" value={previewConn.id} onChange={(e) => setPreviewId(e.target.value)}>
                      {selectedConns.map((c) => <option key={c.id} value={c.id}>{PROVIDER_LABEL[c.provider]} · {c.display_name}</option>)}
                    </Select>
                  </div>
                ) : null}
              />
              <div className="px-4 pb-4"><VariantPreview variant={previewVariant} connection={previewConn} assets={assets} /></div>
            </Card>
          ) : null}
          {!isPublished ? <ReuseCard postId={post.id} brandId={post.brand_id} canEdit={post.can.edit} /> : null}
          <div className="max-xl:hidden">
            {!sheetOpen ? <CollabPanel {...collabProps} collapsed={collapsed} onCollapse={setCollapsedPersist} /> : null}
          </div>
        </aside>
      </div>

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-16 z-20 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:bottom-0 md:left-[var(--rail-w)] xl:left-[var(--nav-w)]">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-2 px-4 py-2 sm:px-6 md:px-8">
          <SaveStatus state={saveState} savedAt={savedAt} tz={tz} error={saveError} localSaved={localSaved} onRetry={() => { retries.current = 0; void save(); }} onConflict={() => setConflictOpen(true)} onHistory={() => setHistoryOpen(true)} readOnly={readOnly} />
          <span className="flex-1" />
          <AiAssist postId={post.id} draft={draft} connections={selectedConns} tab={tab} readOnly={readOnly} flush={flush} onAccept={acceptSuggestion} />
          {!readOnly ? (
            <div className="hidden sm:block">
              <Button variant="ghost" size="md" icon={<Save aria-hidden className="size-4" />} onClick={() => void flush()} disabled={saveState === 'saved' || saveState === 'saving' || saveState === 'conflict'}>
                Save draft<span className="sr-only"> now</span>
              </Button>
            </div>
          ) : null}
          {readOnly && can('drafts.edit') ? (
            <Button variant="secondary" icon={<Copy aria-hidden className="size-4" />} onClick={() => void duplicate()}>Duplicate</Button>
          ) : null}
          {post.can.submit && !readOnly ? (
            <div className={primaryIsSubmit ? 'max-sm:min-w-0 max-sm:flex-1 max-sm:[&_button]:w-full' : 'hidden sm:block'}>
              <Button variant={post.can.schedule ? 'secondary' : 'primary'} icon={<Send aria-hidden className="size-4" />} onClick={() => setDialog('submit')} disabledReason={blockReason}>
                Submit for review
              </Button>
            </div>
          ) : null}
          {!readOnly && (can('drafts.edit') || post.can.schedule) ? (
            <div className={primaryIsSubmit ? 'hidden sm:block' : 'max-sm:min-w-0 max-sm:flex-1 max-sm:[&_button]:w-full'}>
              <Button
                variant={post.can.submit && !post.can.schedule ? 'secondary' : 'primary'}
                icon={<CalendarClock aria-hidden className="size-4" />}
                onClick={() => setDialog('schedule')}
                disabledReason={!post.can.schedule ? (post.can.schedule_reason ?? 'You can’t schedule this post.') : blockReason}
              >
                {post.current_schedule && (post.current_schedule.status === 'active' || post.current_schedule.status === 'pending_approval') ? 'Reschedule' : 'Schedule'}
              </Button>
            </div>
          ) : null}
          {showQueue ? (
            <div className="hidden sm:block"><QueueButton postId={post.id} flush={flush} disabledReason={blockReason} onDone={(t, b) => void afterAction(t, b)} /></div>
          ) : null}
          {post.can.publish_now && !readOnly ? (
            <div className="hidden sm:block">
              <Button variant="secondary" icon={<SendHorizontal aria-hidden className="size-4" />} onClick={() => setDialog('publish')} disabledReason={blockReason}>
                Publish now
              </Button>
            </div>
          ) : null}
          {/* Phones: one full-width primary action; the rest live in ⋯ */}
          {!readOnly ? (
            <div className="sm:hidden">
              <Menu>
                <MenuTrigger asChild>
                  <IconButton label="More actions" variant="secondary" icon={<Ellipsis aria-hidden className="size-4" />} />
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem icon={<Save aria-hidden />} disabled={saveState === 'saved' || saveState === 'saving' || saveState === 'conflict'} onSelect={() => void flush()}>Save draft</MenuItem>
                  {post.can.submit && !primaryIsSubmit ? <MenuItem icon={<Send aria-hidden />} disabled={!!blockReason} onSelect={() => setDialog('submit')}>Submit for review</MenuItem> : null}
                  {showQueue ? <MenuItem icon={<ListPlus aria-hidden />} disabled={!!blockReason || queue.busy} onSelect={() => void queue.run()}>Add to queue</MenuItem> : null}
                  {post.can.publish_now ? <MenuItem icon={<SendHorizontal aria-hidden />} disabled={!!blockReason} onSelect={() => setDialog('publish')}>Publish now</MenuItem> : null}
                  {blockReason ? <MenuLabel>{blockReason}</MenuLabel> : null}
                </MenuContent>
              </Menu>
            </div>
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
      <DraftConflictDialog
        open={conflictOpen}
        onOpenChange={setConflictOpen}
        current={conflict}
        mine={{ title, draft }}
        base={serverSnap.current}
        onTakeTheirs={takeTheirs}
        onKeepBoth={keepCopy}
        onApplySelected={applySelected}
        keptInHistory={!!conflictCopy}
      />
      {linksOn ? (
        <LinkBuilderDialog open={linkOpen} onOpenChange={setLinkOpen} brandId={post.brand_id} postId={post.id} campaignId={planning.data?.campaign?.id ?? null}
          initialUrl={draft.baseLink ?? ''} onUse={(url) => edit({ draft: { ...latest.current.draft, baseLink: url } })} />
      ) : null}
      <Drawer open={sheetOpen} onOpenChange={setSheetOpen} title="Collaborate">
        <CollabPanel {...collabProps} sheet />
      </Drawer>
      <Drawer open={historyOpen} onOpenChange={setHistoryOpen} title="Version history">
        <HistoryPanel postId={post.id} currentText={draft.baseText} version={version} canEdit={!readOnly} tall
          highlight={conflictCopy}
          onRestored={async () => { rememberConflictCopy(post.id, null); dirty.current = false; clearLocalDraft(policy, post.id); setHistoryOpen(false); await reload(); }} />
      </Drawer>
      <ConfirmDialog
        open={!!pendingRemove}
        onOpenChange={(o) => !o && setPendingRemove(null)}
        title={`Remove ${pendingRemove?.display_name ?? 'destination'}?`}
        description="Its custom content will be discarded."
        confirmLabel="Remove"
        confirmVariant="danger"
        onConfirm={() => { if (pendingRemove) removeDestination(pendingRemove.id); }}
      />
      <TrashConfirmDialog
        kind="post"
        id={post.id}
        open={trashOpen}
        onOpenChange={setTrashOpen}
        onConfirm={async () => {
          await flush();
          await trashActions.trash('post', post.id, { expectedVersion: versionRef.current });
          dirty.current = false;
          clearLocalDraft(policy, post.id);
          router.push('/planner');
        }}
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
          clearLocalDraft(policy, post.id);
          toast.show({
            tone: 'success', title: 'Post archived',
            action: { label: 'Undo', onClick: async () => {
              try { await runSingleBulk('post', 'unarchive', post.id); toast.success('Unarchiving'); } catch (e) { toast.error(e, 'Couldn’t undo'); }
            } },
          });
          router.push('/planner');
        }}
      />
    </div>
  );
}

/** Desktop: the side column scrolls on its own (the editor stays in view); bring the collaboration panel to its top. */
function scrollToPanel() {
  const side = document.getElementById('composer-side');
  const panel = document.querySelector<HTMLElement>('[data-testid="collab-panel"]');
  if (!side || !panel) return;
  side.scrollTo({ top: side.scrollTop + panel.getBoundingClientRect().top - side.getBoundingClientRect().top - 4, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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

/** Same issue type on several destinations is listed once with the affected destinations. */
function groupIssues(conns: Connection[], issuesFor: (id: string) => ValidationIssue[]) {
  const groups = new Map<string, { key: string; message: string; conns: Connection[] }>();
  for (const c of conns) for (const i of issuesFor(c.id)) {
    const key = `${i.field}:${i.code}`;
    const g = groups.get(key);
    if (g) { if (!g.conns.includes(c)) g.conns.push(c); }
    else groups.set(key, { key, message: i.message, conns: [c] });
  }
  return [...groups.values()].map((g) => ({
    ...g,
    // Drop the "<Network>: " prefix and capitalise when the message covers several networks.
    message: g.conns.length > 1 ? g.message.replace(/^[A-Za-z /]+:\s*/, '').replace(/^./, (x) => x.toUpperCase()) : g.message,
  }));
}

function IssueRow({ issue }: { issue: ValidationIssue }) {
  return (
    <li className="flex items-start gap-2 text-[13px]">
      <ToneIcon tone="danger" className="mt-0.5" />
      <span>{issue.message}</span>
    </li>
  );
}
