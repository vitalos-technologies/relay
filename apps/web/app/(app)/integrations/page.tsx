// Integrations hub (V3.5): Asana, monday.com, HubSpot, Google Business Profile, Cloud Translation, Slack, Mailchimp.
import type { Metadata } from 'next';
import { IntegrationsHub } from '@/components/integrations-hub/hub-page';

export const metadata: Metadata = { title: 'Integrations' };

export default function IntegrationsPage() {
  return <IntegrationsHub />;
}
