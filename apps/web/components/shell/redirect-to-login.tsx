'use client';
import { useEffect } from 'react';

/** Rendered by the server layout when no session cookie exists; keeps the deep link as returnTo. */
export function RedirectToLogin() {
  useEffect(() => {
    const here = window.location.pathname + window.location.search;
    window.location.replace(`/login?returnTo=${encodeURIComponent(here)}`);
  }, []);
  return (
    <main className="flex min-h-dvh items-center justify-center p-6 text-[13px] text-muted">
      <p role="status">
        Redirecting to sign in… <a className="underline" href="/login">Continue</a>
      </p>
    </main>
  );
}
