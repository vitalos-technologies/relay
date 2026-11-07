'use client';
// V3.1 §9 composer pieces: save status (Saving / Saved / Saved locally / Offline / Save failed / Edited elsewhere),
// the recovery prompt for a copy kept in this browser, and the conflict dialog (yours vs server).
// "Saved locally" means only this browser has it: it is never presented as saved.
import { useState } from 'react';
import { CircleCheck, CloudAlert, HardDrive, LoaderCircle, WifiOff } from 'lucide-react';
import type { DraftContent } from '@social-lite/core';
import type { DraftRecoveryStatus } from '@social-lite/core/contracts/v31-data';
import { isApiError } from '@/lib/client/api';
import { fmtRelative, fmtTime, zoneAbbr } from '@/lib/client/format';
import type { LocalDraft } from '@/lib/client/draft-recovery';
import { Banner, Button, Dialog, ErrorNotice, ToneIcon, Tooltip } from '@/components/ui';

export type ComposerSaveState = 'saved' | 'dirty' | 'saving' | 'saved_locally' | 'offline' | 'save_failed' | 'conflict';

export function SaveStatus({
  state, savedAt, tz, error, localSaved, onRetry, onConflict, onHistory, readOnly,
}: {
  state: ComposerSaveState; savedAt: string; tz: string; error: unknown; localSaved: boolean;
  onRetry: () => void; onConflict: () => void; onHistory: () => void; readOnly: boolean;
}) {
  if (readOnly) return <span className="text-xs text-muted">Read only</span>;
  return (
    <div role="status" aria-live="polite" data-save-state={state} data-testid="save-status" className="flex min-w-0 items-center gap-2 text-[13px]">
      {state === 'saving' ? (
        <><LoaderCircle aria-hidden className="size-4 anim-spin text-info" /><span className="text-muted">Saving…</span></>
      ) : state === 'dirty' ? (
        <><span aria-hidden className="size-2 rounded-full bg-[var(--warn)]" /><span className="text-muted">Unsaved</span></>
      ) : state === 'offline' ? (
        <>
          <WifiOff aria-hidden className="size-4 text-warn" />
          <Tooltip content={localSaved ? 'Kept in this browser only. Saves when you’re back online.' : 'Not stored anywhere yet. Keep this tab open.'}>
            <span tabIndex={0} className="truncate text-warn">Offline · {localSaved ? 'Saved locally' : 'Not saved'}</span>
          </Tooltip>
        </>
      ) : state === 'saved_locally' ? (
        <>
          <HardDrive aria-hidden className="size-4 text-warn" />
          <Tooltip content="Kept in this browser only — not saved to Relay yet.">
            <span tabIndex={0} className="truncate text-warn">Saved locally</span>
          </Tooltip>
          <Button size="sm" variant="quiet" onClick={onRetry}>Retry</Button>
        </>
      ) : state === 'save_failed' ? (
        <>
          <CloudAlert aria-hidden className="size-4 text-danger" />
          <span className="truncate text-danger">Save failed{isApiError(error) && error.correlationId ? <span className="sr-only"> (reference {error.correlationId})</span> : null}</span>
          <Button size="sm" variant="quiet" onClick={onRetry}>Retry</Button>
        </>
      ) : state === 'conflict' ? (
        <>
          <ToneIcon tone="warn" />
          <span className="text-warn">Edited elsewhere</span>
          <Button size="sm" variant="quiet" onClick={onConflict}>Resolve</Button>
        </>
      ) : (
        <button type="button" onClick={onHistory} className="inline-flex items-center gap-2 rounded-md px-1 hover:bg-raised" aria-label={`Saved ${fmtTime(savedAt, tz)}. Version history`}>
          <CircleCheck aria-hidden className="size-4 text-success" />
          <span className="text-muted max-sm:sr-only">Saved {fmtTime(savedAt, tz)} {zoneAbbr(savedAt, tz)}</span>
        </button>
      )}
    </div>
  );
}

const BLOCKED: Record<string, string> = {
  no_permission: 'You no longer have edit access.',
  archived: 'This post is archived.',
  trashed: 'This post is in Trash.',
  not_found: 'This post no longer exists.',
};

/** Prompt shown when this browser holds a copy that differs from the server. Never syncs on its own. */
export function RecoveryBanner({
  local, status, onRestore, onKeepCopy, onDiscard,
}: {
  local: LocalDraft; status: DraftRecoveryStatus | null;
  onRestore: () => Promise<void>; onKeepCopy: () => Promise<void>; onDiscard: () => void;
}) {
  const [busy, setBusy] = useState<'restore' | 'copy' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async (k: 'restore' | 'copy') => {
    setBusy(k);
    setError(null);
    try {
      await (k === 'restore' ? onRestore() : onKeepCopy());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const when = fmtRelative(local.saved_at);
  const discard = <Button size="sm" variant="ghost" onClick={onDiscard} disabled={!!busy}>Discard</Button>;

  if (!status) {
    return (
      <Banner tone="warn" className="mb-6" role="status" title="Unsaved copy in this browser" actions={discard} icon={<HardDrive aria-hidden className="size-4 text-warn" />}>
        <p className="text-muted">From {when}. Couldn’t check the server.</p>
      </Banner>
    );
  }
  if (!status.editable) {
    return (
      <Banner tone="warn" className="mb-6" role="status" title="Unsaved copy can’t be synced" actions={discard} icon={<HardDrive aria-hidden className="size-4 text-warn" />}>
        <p className="text-muted">From {when}. {BLOCKED[status.blocked_reason ?? ''] ?? ''}</p>
      </Banner>
    );
  }
  if (status.server_newer) {
    return (
      <Banner
        tone="warn" className="mb-6" role="status" title="Older unsaved copy in this browser" icon={<HardDrive aria-hidden className="size-4 text-warn" />}
        actions={<>{discard}<Button size="sm" variant="secondary" loading={busy === 'copy'} onClick={() => void run('copy')}>Keep as copy</Button></>}
      >
        <p className="text-muted">From {when}. The server has a newer version{status.updated_by ? ` by ${status.updated_by}` : ''}.</p>
        {error ? <ErrorNotice error={error} className="mt-2" /> : null}
      </Banner>
    );
  }
  return (
    <Banner
      tone="info" className="mb-6" role="status" title="Unsaved changes found" icon={<HardDrive aria-hidden className="size-4 text-info" />}
      actions={<>{discard}<Button size="sm" variant="primary" loading={busy === 'restore'} onClick={() => void run('restore')}>Restore</Button></>}
    >
      <p className="text-muted">Saved in this browser {when}. Not on the server yet.</p>
      {error ? <ErrorNotice error={error} className="mt-2" /> : null}
    </Banner>
  );
}

export interface ConflictCurrent { version?: number; updated_by?: string | null; updated_at?: string; title?: string | null; draft?: DraftContent }

/** Yours vs server. Take theirs (yours stays in History) · Keep both (yours becomes a new draft) · Use mine. */
export function DraftConflictDialog({
  open, onOpenChange, current, mine, onTakeTheirs, onKeepBoth, onUseMine, keptInHistory,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; current: ConflictCurrent | null;
  mine: { title: string; draft: DraftContent };
  onTakeTheirs: () => Promise<void>; onKeepBoth: () => Promise<void>; onUseMine: () => Promise<void>;
  keptInHistory: boolean;
}) {
  const [busy, setBusy] = useState<'theirs' | 'both' | 'mine' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async (k: 'theirs' | 'both' | 'mine') => {
    setBusy(k);
    setError(null);
    try {
      await (k === 'theirs' ? onTakeTheirs() : k === 'both' ? onKeepBoth() : onUseMine());
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const theirs = current?.draft;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={!!busy}
      size="lg"
      title="Edited elsewhere"
      description={keptInHistory ? 'Nothing was overwritten. Your version is also kept in History.' : 'Nothing was overwritten.'}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={!!busy}>Later</Button>
          {current?.version ? <Button variant="quiet" onClick={() => void run('mine')} loading={busy === 'mine'} disabled={!!busy && busy !== 'mine'}>Use mine</Button> : null}
          <Button variant="secondary" onClick={() => void run('both')} loading={busy === 'both'} disabled={!!busy && busy !== 'both'}>Keep both</Button>
          <Button variant="primary" onClick={() => void run('theirs')} loading={busy === 'theirs'} disabled={!!busy && busy !== 'theirs'}>Take theirs</Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" data-testid="conflict-compare">
        <Side label="Yours" meta="Not saved" title={mine.title} text={mine.draft.baseText} destinations={mine.draft.variants.length} />
        <Side
          label="Server"
          meta={[current?.version ? `v${current.version}` : null, current?.updated_by ?? null, current?.updated_at ? fmtRelative(current.updated_at) : null].filter(Boolean).join(' · ')}
          title={current?.title ?? ''}
          text={theirs?.baseText ?? null}
          destinations={theirs ? theirs.variants.length : null}
        />
      </div>
      {error ? <ErrorNotice error={error} className="mt-3" /> : null}
    </Dialog>
  );
}

function Side({ label, meta, title, text, destinations }: { label: string; meta: string; title: string; text: string | null; destinations: number | null }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3" aria-label={label}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold">{label}</h3>
        <span className="truncate text-xs text-muted">{meta}</span>
      </div>
      <p className="truncate text-[13px] font-medium">{title.trim() || 'Untitled post'}</p>
      {text === null ? <p className="text-[13px] text-muted">—</p> : (
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-sunken px-2.5 py-2 text-[13px] leading-relaxed">{text || <span className="text-muted">Empty</span>}</p>
      )}
      {destinations !== null ? <p className="text-xs text-muted">{destinations} destination{destinations === 1 ? '' : 's'}</p> : null}
    </section>
  );
}
