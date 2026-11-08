'use client';
// Platform → Support → Saved replies (V4 SUP): staff-approved answers, inserted by a person into a reply; also the
// approved knowledge the Assist panel points to. Archived replies disappear from the composer.
import { useState } from 'react';
import { BookOpenText, Plus } from 'lucide-react';
import { SUPPORT_CATEGORY_LABEL, SUPPORT_TICKET_CATEGORIES, type SavedReplyDto, type SupportTicketCategory } from '@social-lite/core/contracts/v4-support';
import { api } from '@/lib/client/api';
import { useApi } from '@/lib/client/use-api';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, PageHeader, Select, SkeletonRows, Textarea, useToast } from '@/components/ui';

export function SavedReplies() {
  const toast = useToast();
  const { data, error, loading, refetch } = useApi<{ items: SavedReplyDto[] }>('/api/platform/support/saved-replies');
  const [edit, setEdit] = useState<Partial<SavedReplyDto> | null>(null);
  const [archiving, setArchiving] = useState<SavedReplyDto | null>(null);
  return (
    <>
      <PageHeader title="Saved replies" actions={<Button variant="primary" icon={<Plus aria-hidden className="size-4" />} onClick={() => setEdit({ title: '', body: '', category: null })}>New</Button>} />
      {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading || !data ? <SkeletonRows rows={4} /> : !data.items.length ? <EmptyState icon={<BookOpenText aria-hidden />} title="No saved replies" /> : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {data.items.map((r) => (
            <Card as="li" key={r.id} className="flex flex-col gap-2 p-4">
              <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium">{r.title}{r.category ? <Badge>{SUPPORT_CATEGORY_LABEL[r.category]}</Badge> : null}</p>
              <p className="line-clamp-4 whitespace-pre-wrap break-words text-[13px] text-muted">{r.body}</p>
              <div className="mt-auto flex gap-2"><Button size="sm" onClick={() => setEdit(r)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => setArchiving(r)}>Archive</Button></div>
            </Card>
          ))}
        </ul>
      )}
      <ConfirmDialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} size="lg" title={edit?.id ? 'Edit saved reply' : 'New saved reply'} confirmLabel="Save"
        confirmDisabledReason={!edit?.title?.trim() || !edit?.body?.trim() ? 'Add a title and text' : null}
        onConfirm={async () => {
          const b = { title: edit!.title!.trim(), body: edit!.body!.trim(), category: edit!.category ?? null };
          if (edit!.id) await api.put(`/api/platform/support/saved-replies/${edit!.id}`, b); else await api.post('/api/platform/support/saved-replies', b);
          toast.success('Saved'); await refetch();
        }}>
        <div className="flex flex-col gap-3">
          <Field label="Title"><Input value={edit?.title ?? ''} maxLength={120} onChange={(e) => setEdit((x) => ({ ...x, title: e.target.value }))} /></Field>
          <Field label="Category" optional>
            <Select value={edit?.category ?? ''} onChange={(e) => setEdit((x) => ({ ...x, category: (e.target.value || null) as SupportTicketCategory | null }))}>
              <option value="">Any</option>
              {SUPPORT_TICKET_CATEGORIES.map((c) => <option key={c} value={c}>{SUPPORT_CATEGORY_LABEL[c]}</option>)}
            </Select>
          </Field>
          <Field label="Text"><Textarea rows={8} maxLength={5000} value={edit?.body ?? ''} onChange={(e) => setEdit((x) => ({ ...x, body: e.target.value }))} /></Field>
        </div>
      </ConfirmDialog>
      <ConfirmDialog open={!!archiving} onOpenChange={(o) => !o && setArchiving(null)} title="Archive this saved reply?" confirmLabel="Archive" confirmVariant="danger"
        onConfirm={async () => { await api.del(`/api/platform/support/saved-replies/${archiving!.id}`); toast.success('Archived'); await refetch(); }} />
    </>
  );
}
