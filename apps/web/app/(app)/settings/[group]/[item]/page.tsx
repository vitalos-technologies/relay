'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Lock, SearchX } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { EmptyState } from '@/components/ui';
import { findItem, itemAllowed, itemHref } from '@/components/settings-shell/registry';
import { useFlags } from '@/lib/client/flags';

export default function SettingsItemPage() {
  const { group, item } = useParams<{ group: string; item: string }>();
  const { can, canV2 } = useSession();
  const flags = useFlags();
  const router = useRouter();
  const found = findItem(group, item);
  const allowed = !!found && itemAllowed(found, { can, canV2, flag: flags.enabled });
  useEffect(() => {
    if (found?.href && allowed) router.replace(itemHref(found));
  }, [found, allowed, router]);
  if (!found) return <EmptyState icon={<SearchX aria-hidden />} title="Setting not found" />;
  if (found.flag && !flags.loaded) return null;
  if (!allowed) return <EmptyState icon={<Lock aria-hidden />} title="You don’t have access to this" />;
  if (found.href) return null;
  return <>{found.render?.()}</>;
}
