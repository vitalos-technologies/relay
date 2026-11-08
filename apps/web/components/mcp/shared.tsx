'use client';
// Small shared pieces for the MCP settings components (copy field, scope chips, status badges).
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { McpClientStatus, McpScope } from '@social-lite/core/contracts/mcp';
import { MCP_SCOPE_LABEL } from '@social-lite/core/contracts/mcp';
import { Badge, IconButton, Tooltip, cn } from '@/components/ui';

export function CopyValue({ value, label, className, multiline }: { value: string; label: string; className?: string; multiline?: boolean }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard unavailable */ }
  };
  return (
    <div className={cn('flex min-w-0 items-start gap-2 rounded-lg bg-raised px-3 py-2', className)}>
      {multiline
        ? <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre">{value}</pre>
        : <code className="min-w-0 flex-1 truncate font-mono text-[12px] leading-6">{value}</code>}
      <IconButton label={done ? 'Copied' : `Copy ${label}`} size="sm" variant="quiet" onClick={() => void copy()} icon={done ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />} />
    </div>
  );
}

export function ScopeChips({ scopes, className }: { scopes: McpScope[]; className?: string }) {
  if (!scopes.length) return <span className="text-xs text-muted">No scopes</span>;
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {scopes.map((s) => (
        <Tooltip key={s} content={MCP_SCOPE_LABEL[s]}>
          <span className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg/90">{s}</span>
        </Tooltip>
      ))}
    </span>
  );
}

export function ClientStatusBadge({ status }: { status: McpClientStatus }) {
  const tone = status === 'active' ? 'success' : status === 'pending' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{status === 'pending' ? 'Needs approval' : status === 'active' ? 'Active' : 'Revoked'}</Badge>;
}
