import Link from 'next/link';

export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.12em] text-subtle">404</p>
      <h1 className="mt-2 text-[22px] font-semibold">Not found</h1>
      <Link href="/" className="mt-6 inline-block text-[13px] font-medium underline-offset-2 hover:underline">Home</Link>
    </div>
  );
}
