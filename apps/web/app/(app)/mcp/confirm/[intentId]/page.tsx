'use client';
// Trusted confirmation of one MCP publication intent (linked from prepare_publication's confirm_url).
import { use } from 'react';
import { PageHeader } from '@/components/ui';
import { McpIntentConfirm } from '@/components/mcp';

export default function McpConfirmPage({ params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = use(params);
  return (
    <>
      <PageHeader title="Confirm publication" />
      <McpIntentConfirm intentId={intentId} />
    </>
  );
}
