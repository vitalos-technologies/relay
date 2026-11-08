import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SearchDetail } from '@/components/listening/search-detail';

export const metadata: Metadata = { title: 'Saved search' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={null}><SearchDetail id={id} /></Suspense>;
}
