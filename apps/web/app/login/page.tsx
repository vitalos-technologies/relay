// /login — D34 passwordless sign-in. The sign-in page itself (Continue with Google · or · email → link + 6-digit code) is
// served by the sign-in server (Keycloak, Relay theme) so Google only appears once it is configured there. This route
// forwards straight to it, keeping the return path (and sign-up mode for the marketing handoff), and shows sign-in errors.
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { RelayWordmark } from '@/components/brand/relay-mark';
import { safeReturnTo } from '@/lib/client/api';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  access_denied: 'Sign-in cancelled.',
  state_mismatch: 'That sign-in expired. Start again.',
  invalid_state: 'That sign-in expired, or it was finished in a different browser. Start again here.',
  no_workspace: 'No workspace yet. Ask an admin to invite you.',
  invite_email_mismatch: 'Use the invited email address.',
  invite_expired: 'Invitation expired. Ask for a new one.',
  oidc_error: 'Sign-in service error. Try again.',
  session_expired: 'Session ended. Sign in again.',
  session_mismatch: 'Session changed. Sign in again.',
  account_mismatch: 'You verified as a different account.',
  step_up_not_fresh: 'Verification was not fresh. Try again.',
  idp_error: 'Sign-in cancelled or refused.',
  email_not_verified: 'Confirm your email address first.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  not_configured: 'Sign-in isn’t set up on this server yet.',
  idp_unavailable: 'The sign-in service isn’t reachable. Try again shortly.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const returnTo = safeReturnTo(one(sp.returnTo));
  const error = one(sp.error);
  // Arriving from the marketing sign-up handoff (/signup → /signup/workspace?plan=…): show the sign-up heading.
  const signup = one(sp.mode) === 'signup' || returnTo.startsWith('/signup');
  const href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}${signup ? '&mode=signup' : ''}`;
  if (!error) redirect(href);
  const message = ERRORS[error] ?? 'Sign-in failed. Try again.';

  return (
    <main className="flex min-h-dvh items-start justify-center bg-white px-4 py-14 text-[#0f0f2d] sm:items-center" style={{ colorScheme: 'light' }}>
      <div className="w-full max-w-[380px] text-center">
        <div className="mb-10 flex justify-center text-[#121416]"><RelayWordmark size={34} /></div>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{signup ? 'Create your Relay account' : 'Sign in to Relay'}</h1>
        <div role="alert" className="mt-6 rounded-[10px] bg-[#fef3f2] px-4 py-3 text-left text-[14px] text-[#b42318]">
          <p className="font-medium">Couldn’t sign in</p>
          <p className="mt-0.5">{message}</p>
          <p className="mt-1 font-mono text-[11px] opacity-80">Code: {error}</p>
        </div>
        <a href={href} data-testid="login-retry"
          className="mt-6 flex h-[46px] w-full items-center justify-center gap-2 rounded-[10px] bg-[#3b1f8f] text-[15px] font-semibold text-white hover:bg-[#4c2bb0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6d28d9]">
          Try again<ArrowRight aria-hidden className="size-4" />
        </a>
        <p className="mt-6 text-[13px] text-[#555a70]">{signup ? 'Already have an account?' : 'New to Relay?'}{' '}
          <a href={signup ? '/login' : '/signup'} className="font-medium text-[#5b21b6] hover:underline">{signup ? 'Sign in' : 'Create an account'}</a>
        </p>
      </div>
    </main>
  );
}
