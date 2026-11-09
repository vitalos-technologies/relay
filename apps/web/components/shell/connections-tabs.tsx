'use client';
// D28: "Connections" is one nav item with two tabs — Social accounts (/accounts) and Business apps (/integrations,
// integrations.read). Both routes stay; the tabs are links (keyboard: Tab/Enter), the current one has aria-current.
// A tab the person can't open is hidden; with only one tab left, the bar is not shown.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '@/lib/client/session';
import { useHrefWithBrand } from '@/lib/client/hooks';
import { cn } from '@/components/ui';

const TABS = [
  { href: '/accounts', label: 'Social accounts' },
  { href: '/integrations', label: 'Business apps', v2: 'integrations.read' as const },
];

export function ConnectionsTabs({ className }: { className?: string }) {
  const { canV2 } = useSession();
  const pathname = usePathname();
  const withBrand = useHrefWithBrand();
  const tabs = TABS.filter((t) => !t.v2 || canV2(t.v2));
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Connections" className={cn('-mt-2 mb-6 flex gap-1 overflow-x-auto border-b border-border md:-mt-4 md:mb-8', className)}>
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href === '/accounts' ? withBrand(t.href) : t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'focus-inset touch-target relative -mb-px inline-flex h-10 shrink-0 items-center border-b-2 px-3 text-[13px] font-medium transition-colors',
              active ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
