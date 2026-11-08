'use client';
// One Relay support request (V4 SUP): public conversation, reply / resolve / reopen, people, linked support access.
import { use } from 'react';
import { RequestThread } from '@/components/support/customer';

export default function RequestPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  return <RequestThread reference={decodeURIComponent(ref)} />;
}
