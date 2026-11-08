'use client';
// Help → Contact support (V4 SUP): short form; workspace and requester come from the session, never the form.
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { SUPPORT_TICKET_CATEGORIES, type SupportTicketCategory } from '@social-lite/core/contracts/v4-support';
import { ContactSupportForm } from '@/components/support/customer';

function Inner() {
  const c = useSearchParams().get('category');
  return <ContactSupportForm initialCategory={(SUPPORT_TICKET_CATEGORIES as readonly string[]).includes(c ?? '') ? (c as SupportTicketCategory) : null} />;
}

export default function ContactSupportPage() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}
