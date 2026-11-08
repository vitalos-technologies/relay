import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { BareProviders } from '@/components/shell/providers';
import { RedirectToLogin } from '@/components/shell/redirect-to-login';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Create your workspace' };

export default async function SignupWorkspaceLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!jar.has('sl_session') && !jar.has('__Host-sl_session')) return <RedirectToLogin />;
  return <BareProviders>{children}</BareProviders>;
}
