import Link from 'next/link';

export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.12em] text-subtle">404</p>
      <h1 className="mt-2 text-[22px] font-semibold">Not found</h1>
      <p className="mt-2 text-[13px] text-muted">It may have been archived, or it belongs to another workspace.</p>
      <Link href="/" className="mt-5 inline-block text-[13px] text-accent-text hover:underline">Back to Home</Link>
    </div>
  );
}
