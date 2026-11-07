import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { RedirectToLogin } from '@/components/shell/redirect-to-login';
import { ReviewProviders } from '@/components/collab/review-shell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Review' };

const SESSION_COOKIES = ['sl_session', '__Host-sl_session'];

/** Client review portal: its own minimal layout (no library, accounts, planner or other navigation). */
export default async function ReviewLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!SESSION_COOKIES.some((n) => jar.has(n))) return <RedirectToLogin />;
  return <ReviewProviders>{children}</ReviewProviders>;
}
