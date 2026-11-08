'use client';
// Approve an MCP client for this workspace (scopes + brands). Linked from consent_required tool errors.
import { use } from 'react';
import { PageHeader } from '@/components/ui';
import { McpConsentPanel } from '@/components/mcp';

export default function McpConnectPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = use(params);
  return (
    <>
      <PageHeader title="Connect client" />
      <McpConsentPanel clientRowId={clientId} />
    </>
  );
}
