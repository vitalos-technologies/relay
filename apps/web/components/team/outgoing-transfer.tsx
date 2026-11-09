'use client';
// Pending ownership transfers the signed-in owner can see (GET /api/workspace/ownership-transfers lists the ones they
// proposed or, for owners, all of them), with Cancel (H4). The proposed owner's own Accept / Decline lives in the shell
// banner. Cancel is DELETE /api/workspace/ownership-transfers/:id; the server decides who may cancel.
import { useState } from 'react';
import { Crown } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { useApi } from '@/lib/client/use-api';
import { fmtRelative } from '@/lib/client/format';
import { Banner, Button, ConfirmDialog, useToast } from '@/components/ui';

export interface OwnershipTransfer {
  id: string; from_user_id: string; from_email: string; to_user_id: string; to_email: string; status: string;
  keep_previous_owner_as: 'admin' | 'none' | null; created_at: string; expires_at: string;
}

export function useOwnershipTransfers(enabled: boolean) {
  return useApi<{ items: OwnershipTransfer[] }>(enabled ? '/api/workspace/ownership-transfers' : null);
}

/** Banner per pending transfer the viewer didn't receive (incoming ones are in the shell banner). */
export function OutgoingTransfers({ items, onChanged, className }: { items: OwnershipTransfer[]; onChanged: () => void; className?: string }) {
  const { session } = useSession();
  const toast = useToast();
  const [cancel, setCancel] = useState<OwnershipTransfer | null>(null);
  const outgoing = items.filter((t) => t.to_user_id !== session.user.id);
  if (!outgoing.length) return null;
  return (
    <>
      {outgoing.map((t) => (
        <Banner key={t.id} tone="info" className={className} icon={<Crown aria-hidden className="size-4" />}
          title={`Ownership transfer to ${t.to_email} pending`}
          actions={<Button size="sm" onClick={() => setCancel(t)}>Cancel transfer</Button>}>
          <span className="text-muted">
            {t.from_user_id === session.user.id ? 'Sent by you' : `Sent by ${t.from_email}`} · expires {fmtRelative(t.expires_at)}
            {t.keep_previous_owner_as === 'none' ? ' · previous owner keeps no Admin role' : ' · previous owner stays as Admin'}
          </span>
        </Banner>
      ))}
      <ConfirmDialog open={cancel !== null} onOpenChange={(o) => !o && setCancel(null)}
        title="Cancel ownership transfer?" description={cancel ? `${cancel.to_email} can no longer accept. They’re notified.` : undefined}
        confirmLabel="Cancel transfer" confirmVariant="danger"
        onConfirm={async () => {
          await api.del(`/api/workspace/ownership-transfers/${cancel!.id}`);
          toast.success('Transfer cancelled');
          onChanged();
        }} />
    </>
  );
}
