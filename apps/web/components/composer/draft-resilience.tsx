'use client';
// V3.1 §9 composer pieces: save status (Saving / Saved / Saved locally / Offline / Save failed / Edited elsewhere),
// the recovery prompt for a copy kept in this browser, and the conflict dialog (yours vs server).
// "Saved locally" means only this browser has it: it is never presented as saved.
import { useEffect, useState } from 'react';
import { Check, CircleCheck, CloudAlert, Copy, HardDrive, LoaderCircle, WifiOff } from 'lucide-react';
import { changedFields, type DraftContent, type DraftField } from '@social-lite/core';
import { diffWords } from '@/lib/client/diff';
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

const FIELD_LABEL: Record<DraftField, string> = {
  title: 'Title', text: 'Text', link: 'Link', media: 'Media', destinations: 'Destinations', variants: 'Network versions', options: 'Publishing options',
};

/**
 * Someone saved a newer version while you were editing. Nothing was overwritten. Choices:
 *  - review the differences (field by field, theirs → yours);
 *  - apply the selected parts of yours on top of the latest version (a normal optimistic save — re-checked by the server);
 *  - keep yours as a new draft, or copy your text;
 *  - discard yours (explicit, confirmed). Your version also stays in History as an unsaved copy.
 */
export function DraftConflictDialog({
  open, onOpenChange, current, mine, base, onTakeTheirs, onKeepBoth, onApplySelected, keptInHistory,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; current: ConflictCurrent | null;
  mine: { title: string; draft: DraftContent };
  /** The last version this tab saved or loaded: tells "you changed" from "they changed" (3-way). */
  base?: { title: string; draft: DraftContent } | null;
  onTakeTheirs: () => Promise<void>; onKeepBoth: () => Promise<void>; onApplySelected: (fields: DraftField[]) => Promise<void>;
  keptInHistory: boolean;
}) {
  const [busy, setBusy] = useState<'theirs' | 'both' | 'apply' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [copied, setCopied] = useState(false);
  const theirs = current?.draft;
  const fields = theirs ? changedFields({ title: current?.title ?? '', draft: theirs }, { title: mine.title, draft: mine.draft }) : [];
  const mineChanged = base ? changedFields(base, { title: mine.title, draft: mine.draft }) : fields;
  const theirsChanged = base && theirs ? changedFields(base, { title: current?.title ?? '', draft: theirs }) : [];
  const [chosen, setChosen] = useState<DraftField[]>([]);
  // Default: keep only what YOU changed; their changes to other parts stay.
  useEffect(() => { if (open) { setChosen(fields.filter((f) => mineChanged.includes(f))); setConfirmDiscard(false); setError(null); setCopied(false); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, current?.version]);
  const run = async (k: 'theirs' | 'both' | 'apply') => {
    setBusy(k);
    setError(null);
    try {
      await (k === 'theirs' ? onTakeTheirs() : k === 'both' ? onKeepBoth() : onApplySelected(chosen));
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const copyMine = async () => {
    try { await navigator.clipboard.writeText([mine.title, mine.draft.baseText].filter(Boolean).join('\n\n')); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={!!busy}
      size="lg"
      title="Someone else saved a newer version"
      description={`Nothing was overwritten.${keptInHistory ? ' Your version is also kept in History.' : ''}`}
      footer={
        // Phones: full-width actions in priority order. Wider: one row, primary on the right.
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
          {current?.version ? (
            <Button variant="primary" className="max-sm:w-full sm:order-4" onClick={() => void run('apply')} loading={busy === 'apply'} disabled={!!busy && busy !== 'apply'}
              disabledReason={!chosen.length ? 'Choose what to keep from your version.' : null}>Apply selected to latest</Button>
          ) : null}
          <Button variant="secondary" className="max-sm:w-full sm:order-3" onClick={() => void run('both')} loading={busy === 'both'} disabled={!!busy && busy !== 'both'}>Keep mine as new draft</Button>
          <Button variant="ghost" className="max-sm:w-full sm:order-1" onClick={() => onOpenChange(false)} disabled={!!busy}>Later</Button>
          {confirmDiscard ? (
            <Button variant="danger" className="max-sm:w-full sm:order-2" onClick={() => void run('theirs')} loading={busy === 'theirs'} disabled={!!busy && busy !== 'theirs'}>Discard my changes</Button>
          ) : (
            <Button variant="quiet" className="max-sm:w-full sm:order-2" onClick={() => setConfirmDiscard(true)} disabled={!!busy}>Discard mine…</Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3" data-testid="conflict-compare">
        <p className="text-xs text-muted">
          Latest: {[current?.version ? `v${current.version}` : null, current?.updated_by ?? null, current?.updated_at ? fmtRelative(current.updated_at) : null].filter(Boolean).join(' · ')}
        </p>
        {confirmDiscard ? <Banner tone="warn" title="Your unsaved changes will be dropped from this tab">They stay in History as an unsaved copy if the server kept one.</Banner> : null}
        {!fields.length ? <p className="text-[13px] text-muted">Your version matches the latest. Nothing to merge.</p> : (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-[13px] font-medium">Keep from your version</legend>
            {fields.map((f) => (
              <div key={f} className="rounded-lg border border-border p-2.5">
                <label className="flex items-center gap-2 text-[13px] font-medium">
                  <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={chosen.includes(f)}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, f] : c.filter((x) => x !== f)))} />
                  {FIELD_LABEL[f]}
                  <span className="ml-auto text-xs font-normal text-muted">
                    {mineChanged.includes(f) && theirsChanged.includes(f) ? 'Both changed' : mineChanged.includes(f) ? 'You changed' : theirsChanged.includes(f) ? 'They changed' : ''}
                  </span>
                </label>
                <div className="mt-2">
                  {f === 'title' ? <ConflictDiff before={current?.title ?? ''} after={mine.title} />
                    : f === 'text' ? <ConflictDiff before={theirs?.baseText ?? ''} after={mine.draft.baseText} />
                      : f === 'link' ? <p className="break-all text-xs text-muted">{theirs?.baseLink ?? 'none'} → {mine.draft.baseLink ?? 'none'}</p>
                        : f === 'destinations' ? <p className="text-xs text-muted">{theirs?.variants.length ?? 0} → {mine.draft.variants.length} destinations</p>
                          : <p className="text-xs text-muted">Different in your version</p>}
                </div>
              </div>
            ))}
          </fieldset>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon={copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />} onClick={() => void copyMine()}>{copied ? 'Copied' : 'Copy my text'}</Button>
          <span className="text-xs text-muted">Unselected parts keep the latest version.</span>
        </div>
      </div>
      {error ? <ErrorNotice error={error} className="mt-3" /> : null}
    </Dialog>
  );
}

function ConflictDiff({ before, after }: { before: string; after: string }) {
  return (
    <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-sunken px-2.5 py-2 text-[13px] leading-relaxed">
      {diffWords(before, after).map((p, i, all) =>
        p.kind === 'same' ? <span key={i}>{p.text}</span>
          : p.kind === 'add' && all[i - 1]?.kind === 'del' ? <span key={i}><span aria-hidden> </span><ins className="rounded bg-success-soft text-success no-underline"><span className="sr-only">[yours: </span>{p.text}<span className="sr-only">]</span></ins></span>
          : p.kind === 'add' ? <ins key={i} className="rounded bg-success-soft text-success no-underline"><span className="sr-only">[yours: </span>{p.text}<span className="sr-only">]</span></ins>
            : <del key={i} className="rounded bg-danger-soft text-danger"><span className="sr-only">[latest: </span>{p.text}<span className="sr-only">]</span></del>)}
    </p>
  );
}
