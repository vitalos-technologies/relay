import Link from 'next/link';

export const metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <main className="flex min-h-[70dvh] items-center justify-center px-4 py-16">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-subtle">404</p>
        <h1 className="mt-2 text-[24px] font-semibold">This page doesn’t exist</h1>
        <p className="mt-2 text-[13px] text-muted">The link may be out of date, or the item may belong to a workspace you don’t have access to.</p>
        <Link href="/" className="touch-target mt-6 inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover">Go to Home</Link>
      </div>
    </main>
  );
}
