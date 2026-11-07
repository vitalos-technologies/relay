'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Lock, SearchX } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { EmptyState } from '@/components/ui';
import { findItem, itemHref } from '@/components/settings-shell/registry';

export default function SettingsItemPage() {
  const { group, item } = useParams<{ group: string; item: string }>();
  const { can, canV2 } = useSession();
  const router = useRouter();
  const found = findItem(group, item);
  const allowed = !!found && (!found.visible || found.visible({ can, canV2 }));
  useEffect(() => {
    if (found?.href && allowed) router.replace(itemHref(found));
  }, [found, allowed, router]);
  if (!found) return <EmptyState icon={<SearchX aria-hidden />} title="Setting not found" />;
  if (!allowed) return <EmptyState icon={<Lock aria-hidden />} title="You don’t have access to this" />;
  if (found.href) return null;
  return <>{found.render?.()}</>;
}
