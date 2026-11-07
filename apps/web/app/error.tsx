'use client';
import { useEffect } from 'react';

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surface in the console for support; never shown with stack to the user.
    console.error(error);
  }, [error]);
  return (
    <main className="flex min-h-[70dvh] items-center justify-center px-4 py-16">
      <div role="alert" className="max-w-md text-center">
        <h1 className="text-[22px] font-semibold">Something went wrong</h1>
        <p className="mt-2 text-[13px] text-muted">Your saved work is safe.</p>
        {error.digest ? <p className="mt-3 font-mono text-[11px] text-subtle">Reference {error.digest}</p> : null}
        <div className="mt-6 flex justify-center gap-2">
          <button type="button" onClick={reset} className="touch-target inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover">Try again</button>
          <a href="/" className="touch-target inline-flex h-10 items-center rounded-lg border border-border bg-raised px-4 text-sm font-medium">Go to Home</a>
        </div>
      </div>
    </main>
  );
}
