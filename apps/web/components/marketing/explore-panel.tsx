'use client';
// Loaded on first use of an "Explore …" trigger (keeps Base UI Dialog out of the initial page JavaScript).
import type { ReactNode, RefObject } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui-v5/sheet';

export default function ExplorePanel({ open, onOpenChange, returnFocus, title, description, children }: {
  open: boolean; onOpenChange: (o: boolean) => void; returnFocus: RefObject<HTMLButtonElement | null>; title: string; description: string; children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="mkt max-w-xl gap-5" closeLabel="Close preview" finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle className="text-xl font-bold tracking-[-0.01em]">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
