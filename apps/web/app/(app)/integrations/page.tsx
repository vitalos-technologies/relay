// Integrations hub (V3.5): Asana, monday.com, HubSpot, Google Business Profile, Cloud Translation, Slack, Mailchimp.
import type { Metadata } from 'next';
import { IntegrationsHub } from '@/components/integrations-hub/hub-page';
import { UpgradePrompt } from '@/components/entitlements/prompts'; // V4: concise prompt when not in the plan

export const metadata: Metadata = { title: 'Integrations' };

export default function IntegrationsPage() {
  return <><UpgradePrompt feature="integrations_business" className="mb-4" /><IntegrationsHub /></>;
}
