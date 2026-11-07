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
    toast.success(paused ? 'Publishing resumed' : 'Publishing paused');
    setReason('');
  };

  return (
    <>
      {variant === 'sidebar' ? (
        <Button
          variant="quiet"
          size="md"
          className={paused ? 'w-full justify-start' : 'w-full justify-start text-danger!'}
          icon={paused ? <Play aria-hidden className="size-4" /> : <OctagonPause aria-hidden className="size-4" />}
          onClick={() => setOpen(true)}
        >
          {paused ? 'Resume publishing' : 'Pause publishing'}
        </Button>
      ) : (
        <Button size="sm" variant="secondary" icon={<Play aria-hidden className="size-4" />} onClick={() => setOpen(true)}>
          Resume
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={paused ? 'Resume publishing?' : `Pause all of “${session.workspace.name}”?`}
        description={
          paused
            ? 'Posts past their deadline expire — never sent late.'
            : 'Posts already sending may complete. Missed deadlines expire.'
        }
        confirmLabel={paused ? 'Resume' : 'Pause'}
        confirmVariant={paused ? 'primary' : 'danger'}
        onConfirm={submit}
      >
        {paused ? null : (
          <Field label="Reason" optional hint="Shown to your team.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className="min-h-16" />
          </Field>
        )}
      </ConfirmDialog>
    </>
  );
}
