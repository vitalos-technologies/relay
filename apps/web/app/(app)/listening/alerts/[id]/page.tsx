import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AlertDetail } from '@/components/listening/alert-detail';

export const metadata: Metadata = { title: 'Listening alert' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={null}><AlertDetail id={id} /></Suspense>;
}
