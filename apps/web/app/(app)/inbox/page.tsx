// Inbox (V3.5): customer conversations, comments and cases from connected channels.
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { InboxApp } from '@/components/inbox/inbox-app';

export const metadata: Metadata = { title: 'Inbox' };

export default function InboxPage() {
  return <Suspense fallback={null}><InboxApp /></Suspense>;
}
