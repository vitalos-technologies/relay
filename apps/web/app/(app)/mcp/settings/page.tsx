import { redirect } from 'next/navigation';

// Moved to Settings → Developer → MCP.
export default function McpSettingsPage() {
  redirect('/settings/developer/mcp');
}
