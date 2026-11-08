// Listening (V3.5): connected-source monitoring, saved searches, alerts, share of voice, dashboards.
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ListeningOverview } from '@/components/listening/overview';
import { UpgradePrompt } from '@/components/entitlements/prompts'; // V4: concise prompt when not in the plan

export const metadata: Metadata = { title: 'Listening' };

export default function ListeningPage() {
  return <><UpgradePrompt feature="listening" className="mb-4" /><Suspense fallback={null}><ListeningOverview /></Suspense></>;
}
