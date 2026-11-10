'use client';
// Loaded on first use of an "Explore …" trigger (keeps Base UI Dialog out of the initial page JavaScript). With `media` (a
// real screenshot of the matching app screen) the image sits on top, or on the left on wide screens, with the text beside it.
import type { ReactNode, RefObject } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui-v5/sheet';
import { cn } from '@/components/ui-v5/cn';

export default function ExplorePanel({ open, onOpenChange, returnFocus, title, description, media, children }: {
  open: boolean; onOpenChange: (o: boolean) => void; returnFocus: RefObject<HTMLButtonElement | null>; title: string; description: string; media?: ReactNode; children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('mkt gap-5', media ? 'max-w-[1080px] p-4 pt-14 sm:p-6 sm:pt-14 lg:pt-6 lg:pr-14 lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start lg:gap-7' : 'max-w-xl')} closeLabel="Close preview" finalFocus={returnFocus}>
        {media ? <div className="min-w-0 lg:sticky lg:top-0">{media}</div> : null}
        <div className="flex min-w-0 flex-col gap-5">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold tracking-[-0.01em]">{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
