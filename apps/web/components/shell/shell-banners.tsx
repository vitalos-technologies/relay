'use client';
import { FlaskConical, OctagonPause, WifiOff } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { useOnline } from '@/lib/client/hooks';
import { EmergencyPause } from './emergency-pause';

/** Persistent shell-level status: offline, workspace paused, demo workspace. */
export function ShellBanners() {
  const { session } = useSession();
  const online = useOnline();
  const ws = session.workspace;
  return (
    <div className="flex flex-col">
      {!online ? (
        <div role="status" className="flex items-center justify-center gap-2 border-b border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-warn-soft px-4 py-2 text-[13px]">
          <WifiOff aria-hidden className="size-4 text-warn" />
          <span className="font-medium">Offline</span>
        </div>
      ) : null}
      {ws?.publishing_paused ? (
        <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-danger-soft px-4 py-2 text-[13px]">
          <OctagonPause aria-hidden className="size-4 text-danger" />
          <span className="font-medium">Publishing paused</span>
          <EmergencyPause variant="banner" />
        </div>
      ) : null}
      {ws?.is_demo ? (
        <div role="note" className="flex items-center justify-center gap-2 bg-sunken px-4 py-1 text-xs text-muted">
          <FlaskConical aria-hidden className="size-3.5" />
          <span>Demo · simulated destinations</span>
        </div>
      ) : null}
    </div>
  );
}
