'use client';
import { useEffect } from 'react';
import { ErrorNotice } from '@/components/ui';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-lg py-16">
      <h1 className="mb-3 text-[20px] font-semibold">This page hit a problem</h1>
      <ErrorNotice error={new Error('Something unexpected happened while showing this page. Your saved work is safe.')} />
      {error.digest ? <p className="mt-2 font-mono text-[11px] text-subtle">Reference {error.digest}</p> : null}
      <button type="button" onClick={reset} className="touch-target mt-4 inline-flex h-9 items-center rounded-lg border border-border bg-raised px-3.5 text-sm font-medium hover:border-border-strong">
        Try again
      </button>
    </div>
  );
}
