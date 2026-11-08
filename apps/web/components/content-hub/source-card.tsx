'use client';
// Source card: account, last sync, brand scope, state and import history of one linked source item.
import { CircleCheck, CloudOff, Database, FileText, Image as ImageIcon, Lock, RefreshCw, Trash2, Unplug } from 'lucide-react';
import type { SourceItemDto } from '@social-lite/core/contracts/content-hub';
import { fmtBytes, fmtRelative } from '@/lib/client/format';
import { Badge, Button, Card, IconButton } from '@/components/ui';

const KIND_ICON: Record<SourceItemDto['item_kind'], typeof FileText> = {
  drive_file: ImageIcon, google_doc: FileText, notion_page: FileText, notion_data_source: Database, notion_row: FileText,
};
const KIND_LABEL: Record<SourceItemDto['item_kind'], string> = {
  drive_file: 'Drive file', google_doc: 'Google Doc', notion_page: 'Notion page', notion_data_source: 'Notion data source', notion_row: 'Notion row',
};

export function SourceStateBadge({ item }: { item: Pick<SourceItemDto, 'state' | 'state_detail' | 'change_detected_at'> }) {
  if (item.state === 'linked') {
    return item.change_detected_at
      ? <Badge tone="warn" icon={<RefreshCw aria-hidden className="size-3.5" />} title="Changed at the source — refresh to review">Changed</Badge>
      : <Badge tone="success" icon={<CircleCheck aria-hidden className="size-3.5" />}>Linked</Badge>;
  }
  if (item.state === 'disconnected') return <Badge icon={<Unplug aria-hidden className="size-3.5" />} title={item.state_detail ?? undefined}>Disconnected</Badge>;
  if (item.state === 'removed') return <Badge tone="danger" icon={<CloudOff aria-hidden className="size-3.5" />} title={item.state_detail ?? undefined}>Removed</Badge>;
  return <Badge tone="danger" icon={<Lock aria-hidden className="size-3.5" />} title={item.state_detail ?? undefined}>No access</Badge>;
}

export function SourceCard({ item, onOpen, onRefresh, onDelete, refreshing }: {
  item: SourceItemDto; onOpen: () => void; onRefresh?: () => void; onDelete?: () => void; refreshing?: boolean;
}) {
  const Icon = KIND_ICON[item.item_kind];
  return (
    <Card as="li" className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--icon-tile,#121416)] text-[var(--accent-text)]" aria-hidden>
          <Icon className="size-5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onOpen} className="block max-w-full truncate text-left text-[14px] font-semibold hover:underline">{item.title ?? 'Untitled'}</button>
          <p className="truncate text-xs text-muted">{KIND_LABEL[item.item_kind]} · {item.account_label}{item.shared_drive ? ' · Shared Drive' : ''}</p>
        </div>
        <SourceStateBadge item={item} />
      </div>
      {item.preview?.excerpt ? <p className="line-clamp-2 text-[13px] text-muted">{item.preview.excerpt}</p> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>{item.last_synced_at ? `Synced ${fmtRelative(item.last_synced_at)}` : 'Not imported yet'}</span>
        {item.size_bytes ? <span>{fmtBytes(item.size_bytes)}</span> : null}
        <span>{item.import_count} import{item.import_count === 1 ? '' : 's'}</span>
        {item.retention_hold ? <Badge>On hold</Badge> : null}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={onOpen} disabledReason={item.state !== 'linked' ? 'Not readable right now' : null}>Import</Button>
        {onRefresh && item.last_snapshot ? <Button size="sm" onClick={onRefresh} loading={refreshing} icon={<RefreshCw aria-hidden className="size-4" />}>Refresh</Button> : null}
        <span className="flex-1" />
        {onDelete ? <IconButton label="Delete source and snapshots" icon={<Trash2 aria-hidden className="size-4" />} onClick={onDelete} /> : null}
      </div>
    </Card>
  );
}
