import { Suspense } from 'react';
import type { Metadata } from 'next';
import { MentionDetail } from '@/components/listening/mention-detail';

export const metadata: Metadata = { title: 'Mention' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={null}><MentionDetail id={id} /></Suspense>;
}
