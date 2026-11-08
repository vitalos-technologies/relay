'use client';
// V3.1 §10 trash + undo. Every action goes through the server: consequences are explained by
// GET /api/trash/consequences before deleting; undo replays the server's undo token (expected_deleted_at /
// expected_version), so a changed item fails with a conflict instead of being overwritten.
import { useCallback, useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type { RestoreResult, TrashConsequences, TrashKind, TrashResult, UndoToken } from '@social-lite/core/contracts/v31-data';
import { api } from '@/lib/client/api';
import { ConfirmDialog, ErrorNotice, Skeleton, ToneIcon, useToast } from '@/components/ui';

const NOUN: Record<TrashKind, string> = { post: 'post', asset: 'file' };

/** Replay an undo token (trash.restore or trash.delete). */
export async function replayUndo(undo: UndoToken): Promise<RestoreResult | TrashResult> {
  if (undo.operation === 'trash.restore') {
    return api.post<RestoreResult>('/api/trash/restore', { kind: undo.kind, id: undo.id, expected_deleted_at: undo.expected_deleted_at });
  }
  return api.post<TrashResult>('/api/trash/items', { kind: undo.kind, id: undo.id, expected_version: undo.expected_version ?? undefined });
}

/** Trash / restore with an Undo toast. */
export function useTrashActions() {
  const toast = useToast();
  const undoToast = useCallback((title: string, undo: UndoToken, after?: () => void) => {
    toast.show({
      tone: 'success', title,
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            await replayUndo(undo);
            toast.success(undo.operation === 'trash.restore' ? 'Restored' : 'Moved back to Trash');
            after?.();
          } catch (e) {
            toast.error(e, 'Couldn’t undo');
          }
        },
      },
    });
  }, [toast]);

  const trash = useCallback(async (kind: TrashKind, id: string, opts: { expectedVersion?: number; onUndone?: () => void } = {}) => {
    const r = await api.post<TrashResult>('/api/trash/items', { kind, id, expected_version: opts.expectedVersion });
    undoToast('Moved to Trash', r.undo, opts.onUndone);
    return r;
  }, [undoToast]);

  const restore = useCallback(async (kind: TrashKind, id: string, opts: { expectedDeletedAt?: string; onUndone?: () => void } = {}) => {
    const r = await api.post<RestoreResult>('/api/trash/restore', { kind, id, expected_deleted_at: opts.expectedDeletedAt });
    undoToast(kind === 'post' ? 'Restored as a draft' : 'Restored', r.undo, opts.onUndone);
    return r;
  }, [undoToast]);

  return { trash, restore, undoToast };
}

/** Confirm with the server's consequences; refuses (with its reason) when trashing isn't allowed. */
export function TrashConfirmDialog({
  kind, id, open, onOpenChange, onConfirm,
}: { kind: TrashKind; id: string; open: boolean; onOpenChange: (o: boolean) => void; onConfirm: () => Promise<unknown> }) {
  const [c, setC] = useState<TrashConsequences | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (!open) return;
    setC(null);
    setErr(null);
    const ctl = new AbortController();
    api.get<TrashConsequences>('/api/trash/consequences', { kind, id }, { signal: ctl.signal }).then(setC).catch((e) => { if (!ctl.signal.aborted) setErr(e); });
    return () => ctl.abort();
  }, [open, kind, id]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Move ${NOUN[kind]} to Trash?`}
      description={c ? `Restorable for ${c.retention_days} days.` : undefined}
      confirmLabel="Move to Trash"
      confirmVariant="danger"
      confirmDisabledReason={!c ? (err ? 'Couldn’t check consequences.' : 'Checking…') : c.can_trash ? null : c.blocked_reason ?? 'Can’t be moved to Trash.'}
      onConfirm={onConfirm}
    >
      <div data-testid="trash-consequences" className="flex flex-col gap-2 text-[13px]">
        {err ? <ErrorNotice error={err} /> : !c ? <Skeleton className="h-12 w-full rounded-lg" /> : (
          <>
            {!c.can_trash && c.blocked_reason ? (
              <p className="flex items-start gap-2 text-danger"><ToneIcon tone="danger" className="mt-0.5" />{c.blocked_reason}</p>
            ) : null}
            <ul className="flex flex-col gap-1.5">
              {/* The retention line is the dialog description already. */}
              {c.consequences.filter((t) => !t.startsWith('Moves to Trash.')).map((t) => (
                <li key={t} className="flex items-start gap-2"><CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />{t}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
