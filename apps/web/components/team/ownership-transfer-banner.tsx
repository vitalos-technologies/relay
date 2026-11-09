'use client';
// Shell-level banner for the proposed new owner (H4): visible on every page, whatever their role, so a recipient without
// members.read (e.g. an Editor) can still accept or decline. Accept needs a fresh MFA sign-in (the API answers
// step_up_required → verify → back here); decline needs nothing. The server re-checks everything.
import { useState } from 'react';
import { Crown } from 'lucide-react';
import { api, isApiError } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { fmtRelative } from '@/lib/client/format';
import { Button, ConfirmDialog, useToast } from '@/components/ui';
import { HelpLink } from '@/components/help/help-link';

export function OwnershipTransferBanner() {
  const { session, refresh } = useSession();
  const toast = useToast();
  const [confirm, setConfirm] = useState<null | 'accept' | 'decline'>(null);
  const t = session.v2?.pending_ownership_transfer;
  const ws = session.workspace;
  if (!t || !ws) return null;

  const run = async () => {
    try {
      if (confirm === 'accept') await api.post(`/api/workspace/ownership-transfers/${t.id}/accept`, {});
      else await api.del(`/api/workspace/ownership-transfers/${t.id}`);
    } catch (e) {
      // Leaving to verify: keep the dialog quiet; the banner is still here on return.
      if (isApiError(e) && (e.code === 'step_up_required' || e.code === 'mfa_required')) return;
      throw e;
    }
    toast.success(confirm === 'accept' ? 'You are now the owner' : 'Transfer declined');
    await refresh();
  };

  return (
    <div role="region" aria-label="Ownership transfer" data-testid="ownership-transfer-banner"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-warn-soft px-4 py-2 text-[13px]">
      <Crown aria-hidden className="size-4 text-warn" />
      <span className="min-w-0 text-center"><span className="font-medium">{t.from_email}</span> wants you to become the owner of {ws.name}</span>
      <span className="text-muted">Expires {fmtRelative(t.expires_at)}</span>
      <span className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => setConfirm('accept')}>Accept ownership</Button>
        <Button size="sm" variant="secondary" onClick={() => setConfirm('decline')}>Decline</Button>
      </span>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'accept' ? `Become the owner of ${ws.name}?` : 'Decline ownership?'}
        description={confirm === 'accept'
          ? `You get every permission, including billing and deleting the workspace. ${t.from_email} ${t.keep_previous_owner_as === 'none' ? 'keeps no Admin role.' : 'stays as Admin.'}`
          : `${t.from_email} stays the owner and is told you declined.`}
        confirmLabel={confirm === 'accept' ? 'Accept ownership' : 'Decline'}
        confirmVariant={confirm === 'decline' ? 'danger' : 'primary'}
        onConfirm={run}
      >
        {confirm === 'accept' ? <p className="text-[13px] text-muted">You may be asked to sign in again with your second factor.</p> : null}
        <HelpLink slug="transfer-ownership" label="About ownership transfers" />
      </ConfirmDialog>
    </div>
  );
}
