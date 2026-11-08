'use client';
// Platform → Support → ticket (V4 SUP): timeline with public replies and internal notes, triage, context, assist.
import { use } from 'react';
import { StaffTicketView } from '@/components/platform-support/ticket';

export default function PlatformSupportTicketPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  return <StaffTicketView reference={decodeURIComponent(ref)} />;
}
