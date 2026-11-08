import { Skeleton } from '@/components/ui';

export function ShellSkeleton() {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[224px_minmax(0,1fr)]" role="status" aria-label="Loading Relay">
      <aside className="hidden h-dvh flex-col gap-3 border-r border-border bg-surface p-4 md:flex">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="mt-3 h-11 w-full" />
        <Skeleton className="h-10 w-full" />
        <div className="mt-4 flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}
        </div>
      </aside>
      <div className="h-14 border-b border-border bg-surface md:hidden" />
      <main className="mx-auto w-full max-w-[1280px] px-4 pt-8 sm:px-8">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-3 h-4 w-80 max-w-full" />
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </main>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
