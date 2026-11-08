// Listening (V3.5): connected-source monitoring, saved searches, alerts, share of voice, dashboards.
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ListeningOverview } from '@/components/listening/overview';

export const metadata: Metadata = { title: 'Listening' };

export default function ListeningPage() {
  return <Suspense fallback={null}><ListeningOverview /></Suspense>;
}
