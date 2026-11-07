'use client';
// V3.1 Admin: every Settings sub-page rendered inside the admin shell from the ONE shared registry
// (components/settings-shell/registry.tsx). Entries that live on their own page open their admin equivalent.
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Lock, SearchX } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { useFlags } from '@/lib/client/flags';
import { EmptyState, PageHeader } from '@/components/ui';
import { findItem, itemAllowed } from '@/components/settings-shell/registry';

const ADMIN_EQUIVALENT: Record<string, string> = {
  '/team': '/admin/people', '/team/invitations': '/admin/people/invitations', '/team/teams': '/admin/people/teams',
  '/accounts': '/admin/connections', '/accounts/health': '/admin/connections', '/activity': '/admin/security/audit',
};

export default function AdminSettingsItemPage() {
  const { group, item } = useParams<{ group: string; item: string }>();
  const { can, canV2 } = useSession();
  const flags = useFlags();
  const router = useRouter();
  const found = findItem(group, item);
  const allowed = !!found && itemAllowed(found, { can, canV2, flag: flags.enabled });
  useEffect(() => {
    if (found?.href && allowed) router.replace(ADMIN_EQUIVALENT[found.href] ?? found.href);
  }, [found, allowed, router]);
  if (!found) return <EmptyState icon={<SearchX aria-hidden />} title="Setting not found" />;
  if (found.flag && !flags.loaded) return null;
  if (!allowed) return <EmptyState icon={<Lock aria-hidden />} title="You don’t have access to this" />;
  if (found.href) return null;
  return (
    <>
      {found.ownHeader ? null : <PageHeader title={found.label} />}
      <div className="max-w-3xl">{found.render?.()}</div>
    </>
  );
}
