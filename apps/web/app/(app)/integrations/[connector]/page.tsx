import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ConnectorPage } from '@/components/integrations-hub/connector-page';

export const metadata: Metadata = { title: 'Integration' };

export default async function IntegrationConnectorPage({ params }: { params: Promise<{ connector: string }> }) {
  const { connector } = await params;
  return <Suspense fallback={null}><ConnectorPage slug={connector} /></Suspense>;
}
