import Link from 'next/link';

export const metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <main className="flex min-h-[70dvh] items-center justify-center px-4 py-16">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-subtle">404</p>
        <h1 className="mt-2 text-[24px] font-semibold">Page not found</h1>
        <Link href="/" className="touch-target mt-6 inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover">Home</Link>
      </div>
    </main>
  );
}
