import { RelayWordmark } from '@/components/brand/relay-mark';
import { BRAND } from '@social-lite/core';
import type { Metadata } from 'next';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { safeReturnTo } from '@/lib/client/api';
import { PlatformIcon } from '@/components/ui/platform-icon';

export const metadata: Metadata = { title: 'Sign in' };

const ERRORS: Record<string, string> = {
  access_denied: 'Sign-in cancelled.',
  state_mismatch: 'Link expired. Start again.',
  invalid_state: 'Link expired. Start again.',
  no_workspace: 'No workspace yet. Ask an admin to invite you.',
  invite_email_mismatch: 'Use the invited email address.',
  invite_expired: 'Invitation expired. Ask for a new one.',
  oidc_error: 'Identity provider error. Try again.',
  session_expired: 'Session ended. Sign in again.',
  session_mismatch: 'Session changed. Sign in again.',
  account_mismatch: 'You verified as a different account.',
  step_up_not_fresh: 'Verification was not fresh. Try again.',
  idp_error: 'Sign-in cancelled or refused.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const returnTo = safeReturnTo(one(sp.returnTo));
  const error = one(sp.error);
  const href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  const message = error ? (ERRORS[error] ?? 'Sign-in failed. Try again.') : null;

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <div className="relative w-full max-w-[400px]">
        <div className="mb-8 flex flex-col gap-2">
          <RelayWordmark size={34} />
          <p className="text-sm text-muted">{BRAND.tagline}</p>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Sign in</h1>

          {message ? (
            <div role="alert" className="mt-6 rounded-lg bg-danger-soft px-4 py-3 text-[13px]">
              <p className="font-medium">Couldn’t sign in</p>
              <p className="mt-0.5 text-muted">{message}</p>
              {error ? <p className="mt-1 font-mono text-[11px] text-subtle">Code: {error}</p> : null}
            </div>
          ) : null}

          <a
            href={href}
            className="touch-target mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[15px] font-medium text-on-accent hover:bg-accent-hover"
          >
            Continue with single sign-on
            <ArrowRight aria-hidden className="size-4" />
          </a>

          <p className="mt-4 flex items-center gap-2 text-xs text-muted">
            <ShieldCheck aria-hidden className="size-3.5 shrink-0 text-success" />
            We never see your password.
          </p>
        </div>

        <div className="mt-8 flex items-center gap-2" role="group" aria-label="Supported networks: Instagram, Facebook, Telegram and X">
          <PlatformIcon provider="instagram" size="sm" />
          <PlatformIcon provider="facebook" size="sm" />
          <PlatformIcon provider="telegram" size="sm" />
          <PlatformIcon provider="x" size="sm" />
        </div>
      </div>
    </main>
  );
}
