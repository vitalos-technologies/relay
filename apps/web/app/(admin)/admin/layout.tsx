import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { AdminProviders } from '@/components/admin/providers';
import { RedirectToLogin } from '@/components/shell/redirect-to-login';
import { GuestRedirect } from '@/components/collab/guest-redirect';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Admin' };

const SESSION_COOKIES = ['sl_session', '__Host-sl_session'];

/** Admin app (V3.1 Admin). Same cheap cookie gate as the main app; every API authorizes on the server. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!SESSION_COOKIES.some((n) => jar.has(n))) return <RedirectToLogin />;
  return <AdminProviders><GuestRedirect />{children}</AdminProviders>;
}
