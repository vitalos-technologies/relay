// Inbox (V3.5): customer conversations, comments and cases from connected channels.
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { InboxApp } from '@/components/inbox/inbox-app';
import { FeatureGate } from '@/components/entitlements/feature-gate'; // D33: Free has no inbox

export const metadata: Metadata = { title: 'Inbox' };

export default function InboxPage() {
  return <FeatureGate feature="inbox"><Suspense fallback={null}><InboxApp /></Suspense></FeatureGate>;
}
