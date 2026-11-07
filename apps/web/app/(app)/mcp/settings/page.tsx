'use client';
// Settings → Developer → MCP (temporary standalone route until the redesigned Settings navigation mounts it).
import { PageHeader } from '@/components/ui';
import { McpDeveloperSettings } from '@/components/mcp';

export default function McpSettingsPage() {
  return (
    <>
      <PageHeader title="MCP" />
      <McpDeveloperSettings />
    </>
  );
}
