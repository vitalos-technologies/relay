// Link a Slack identity to the signed-in Relay person (explicit; token from a verified Slack click; single use).
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SlackLinkPage } from '@/components/integrations-hub/slack-link';

export const metadata: Metadata = { title: 'Link Slack' };

export default function SlackLink() {
  return <Suspense fallback={null}><SlackLinkPage /></Suspense>;
}
