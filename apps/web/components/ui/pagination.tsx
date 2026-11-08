'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';

/** Cursor pagination: the caller keeps a stack of cursors for "Previous". */
export function Pagination({ page, hasPrev, hasNext, onPrev, onNext, loading }: { page: number; hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void; loading?: boolean }) {
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 pt-4">
      <span className="text-xs text-muted tabular">Page {page}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" icon={<ChevronLeft aria-hidden className="size-4" />} onClick={onPrev} disabled={!hasPrev || loading}>Previous</Button>
        <Button size="sm" variant="secondary" onClick={onNext} disabled={!hasNext || loading}>
          Next <ChevronRight aria-hidden className="size-4" />
        </Button>
      </div>
    </nav>
  );
}
