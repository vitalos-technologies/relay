'use client';
import { useState } from 'react';
import { OctagonPause, Play } from 'lucide-react';
import { api } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { Button, ConfirmDialog, Field, Textarea, useToast } from '@/components/ui';

/** Workspace-wide emergency pause (pause.emergency). Checked at dispatch time by the worker (SC-05). */
export function EmergencyPause({ variant = 'sidebar' }: { variant?: 'sidebar' | 'banner' }) {
  const { session, can, refresh } = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!session.workspace || !can('pause.emergency')) return null;
  const paused = session.workspace.publishing_paused;

  const submit = async () => {
    await api.post('/api/workspace/pause', paused ? { paused: false } : { paused: true, reason: reason.trim() || undefined });
    await refresh();
    toast.success(paused ? 'Publishing resumed' : 'Publishing paused', paused ? 'Due posts will be dispatched again.' : 'Nothing will be sent until you resume.');
    setReason('');
  };

  return (
    <>
      {variant === 'sidebar' ? (
        <Button
          variant={paused ? 'secondary' : 'danger'}
          size="md"
          className="w-full justify-start"
          icon={paused ? <Play aria-hidden className="size-4" /> : <OctagonPause aria-hidden className="size-4" />}
          onClick={() => setOpen(true)}
        >
          {paused ? 'Resume publishing' : 'Pause all publishing'}
        </Button>
      ) : (
        <Button size="sm" variant="secondary" icon={<Play aria-hidden className="size-4" />} onClick={() => setOpen(true)}>
          Resume
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={paused ? 'Resume publishing for this workspace?' : 'Pause all publishing?'}
        description={
          paused
            ? 'Scheduled posts that are still within their publish-before deadline will be dispatched. Posts whose deadline passed while paused will expire and appear in Needs attention — they are never sent in a burst.'
            : `Stops every brand in “${session.workspace.name}” from sending. Posts already being sent to a network may still complete. Schedules are kept; anything that passes its deadline while paused will expire rather than send late.`
        }
        confirmLabel={paused ? 'Resume publishing' : 'Pause publishing'}
        confirmVariant={paused ? 'primary' : 'danger'}
        onConfirm={submit}
      >
        {paused ? null : (
          <Field label="Reason" optional hint="Shown to your team on the paused banner.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className="min-h-16" />
          </Field>
        )}
      </ConfirmDialog>
    </>
  );
}
