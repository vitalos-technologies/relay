'use client';
// Platform → Support (V4 SUP): the staff inbox for customer ↔ Relay requests. Support staff only (server-enforced).
import { Suspense } from 'react';
import { SupportInbox } from '@/components/platform-support/inbox';

export default function PlatformSupportPage() {
  return <Suspense fallback={null}><SupportInbox /></Suspense>;
}
