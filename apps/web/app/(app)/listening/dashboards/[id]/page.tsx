import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ListeningDashboard } from '@/components/listening/dashboard';

export const metadata: Metadata = { title: 'Listening dashboard' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={null}><ListeningDashboard id={id} /></Suspense>;
}
