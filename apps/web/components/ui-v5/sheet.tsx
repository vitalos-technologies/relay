'use client';
// V5 Sheet + Dialog (shadcn/ui "sheet"/"dialog", Base UI Dialog). Focus is trapped while open and returns to the trigger on
// close; Escape and the close button dismiss; the page behind is inert and scroll-locked. Used by the marketing mobile menu
// and available to WID (mobile full-screen conversation) and AIW.
import type { ComponentProps, ReactNode } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from './cn';

export const Sheet = DialogPrimitive.Root;
export const Dialog = DialogPrimitive.Root;

export function SheetTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}
export const DialogTrigger = SheetTrigger;

export function SheetClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}
export const DialogClose = SheetClose;

function Backdrop({ className }: { className?: string }) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn('fixed inset-0 z-50 bg-v5-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none', className)}
    />
  );
}

function CloseButton({ label }: { label: string }) {
  return (
    <DialogPrimitive.Close
      data-slot="sheet-close"
      className="absolute right-3 top-3 inline-flex size-10 items-center justify-center rounded-full text-v5-muted outline-none hover:bg-v5-raised hover:text-v5-fg focus-visible:outline-2 focus-visible:outline-v5-ring"
    >
      <X aria-hidden className="size-5" />
      <span className="sr-only">{label}</span>
    </DialogPrimitive.Close>
  );
}

const SIDE = {
  right: 'inset-y-0 right-0 h-dvh w-[min(100vw,22rem)] border-l data-ending-style:translate-x-8 data-starting-style:translate-x-8',
  left: 'inset-y-0 left-0 h-dvh w-[min(100vw,22rem)] border-r data-ending-style:-translate-x-8 data-starting-style:-translate-x-8',
  top: 'inset-x-0 top-0 max-h-dvh border-b data-ending-style:-translate-y-6 data-starting-style:-translate-y-6',
  bottom: 'inset-x-0 bottom-0 max-h-dvh rounded-t-2xl border-t data-ending-style:translate-y-6 data-starting-style:translate-y-6',
  full: 'inset-0 h-dvh w-screen',
} as const;

export function SheetContent({
  className, children, side = 'right', closeLabel = 'Close', showClose = true, ...props
}: DialogPrimitive.Popup.Props & { side?: keyof typeof SIDE; closeLabel?: string; showClose?: boolean; children?: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <Backdrop />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          'fixed z-50 flex flex-col gap-4 overflow-y-auto border-v5-border bg-v5-surface p-6 text-v5-fg shadow-xl outline-none transition-[transform,opacity] duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none',
          SIDE[side],
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? <CloseButton label={closeLabel} /> : null}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export function DialogContent({ className, children, closeLabel = 'Close', showClose = true, ...props }: DialogPrimitive.Popup.Props & { closeLabel?: string; showClose?: boolean; children?: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <Backdrop />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-2xl border border-v5-border bg-v5-surface p-6 text-v5-fg shadow-xl outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 motion-reduce:transition-none',
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? <CloseButton label={closeLabel} /> : null}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-1 pr-10', className)} {...props} />;
}
export const DialogHeader = SheetHeader;

export function SheetTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn('text-lg font-semibold text-v5-fg', className)} {...props} />;
}
export const DialogTitle = SheetTitle;

export function SheetDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="sheet-description" className={cn('text-sm text-v5-muted', className)} {...props} />;
}
export const DialogDescription = SheetDescription;
