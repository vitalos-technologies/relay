import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ListeningCompare } from '@/components/listening/compare';

export const metadata: Metadata = { title: 'Compare' };

export default function Page() {
  return <Suspense fallback={null}><ListeningCompare /></Suspense>;
}
