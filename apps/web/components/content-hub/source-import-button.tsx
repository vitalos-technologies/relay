'use client';
// Composer entry point: jump to the brand's Content Hub sources (Drive, Docs, Notion) to import into drafts.
import { FolderInput } from 'lucide-react';
import { useSession } from '@/lib/client/session';
import { LinkButton } from '@/components/ui';

export function SourceImportButton({ brandId }: { brandId: string }) {
  const { canV2 } = useSession();
  if (!brandId || !canV2('content.create')) return null;
  return <LinkButton href={`/library?tab=sources&brand=${brandId}`} icon={<FolderInput aria-hidden className="size-4" />}>From Drive or Notion</LinkButton>;
}
