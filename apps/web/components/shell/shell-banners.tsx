'use client';
import Link from 'next/link';
import { FlaskConical, LifeBuoy, OctagonPause, WifiOff } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { useOnline } from '@/lib/client/hooks';
import { EmergencyPause } from './emergency-pause';
import { EntitlementStrip } from '@/components/entitlements/shell-strip';
import { OwnershipTransferBanner } from '@/components/team/ownership-transfer-banner';

/** Persistent shell-level status: offline, workspace paused, ownership transfer to you, demo workspace. */
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
      {/* H4: the proposed new owner can accept or decline from any page, whatever their role. */}
      <OwnershipTransferBanner />
      {/* V4 entitlements: paid actions paused (trial ended / payment problem) — billing + support links always shown */}
      <EntitlementStrip />
      {session.support_access?.active ? (
        // V3.1 Admin §13: everyone in the workspace sees that Relay support currently has (read-only) access.
        <div role="status" className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-[color-mix(in_srgb,var(--info)_35%,transparent)] bg-info-soft px-4 py-2 text-[13px]">
          <LifeBuoy aria-hidden className="size-4 text-info" />
          <span className="font-medium">{session.support_access.mine ? 'You have read-only support access here' : 'Relay support has read-only access'}</span>
          {session.support_access.until ? <span className="text-muted">until {new Date(session.support_access.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
          <Link href="/admin/security/support" className="font-medium underline">Details</Link>
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
