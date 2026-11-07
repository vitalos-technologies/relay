'use client';
import * as D from '@radix-ui/react-dialog';
import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from './cn';
import { Button, type ButtonVariant } from './button';
import { ErrorNotice } from './feedback';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** prevent closing by outside click (e.g. while saving) */
  modal?: boolean;
  busy?: boolean;
}

const widths = { sm: 'max-w-[420px]', md: 'max-w-[540px]', lg: 'max-w-[720px]', xl: 'max-w-[960px]' };

export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md', busy }: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--overlay)] backdrop-blur-[2px]" />
        <D.Content
          className={cn(
            'anim-pop fixed left-1/2 top-1/2 z-50 flex max-h-[min(92dvh,900px)] w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface shadow-[var(--shadow)]',
            widths[size],
          )}
          onEscapeKeyDown={(e) => busy && e.preventDefault()}
          onPointerDownOutside={(e) => busy && e.preventDefault()}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-6">
            <div className="min-w-0">
              <D.Title className="text-[15px] font-semibold leading-snug">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-[13px] text-muted">{description}</D.Description> : null}
            </div>
            <D.Close asChild>
              <button type="button" aria-label="Close" disabled={busy} className="touch-target -mr-1.5 -mt-1 inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg">
                <X aria-hidden className="size-4" />
              </button>
            </D.Close>
          </div>
          {children ? <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div> : null}
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 px-6 pb-6 pt-4">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function Drawer({
  open, onOpenChange, title, description, children, footer,
}: Omit<DialogProps, 'size'>) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--overlay)]" />
        <D.Content
          className="anim-slide fixed inset-y-0 right-0 z-50 flex w-full max-w-[560px] flex-col border-l border-border bg-surface shadow-[var(--shadow)]"
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <D.Title className="text-[15px] font-semibold">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-[13px] text-muted">{description}</D.Description> : null}
            </div>
            <D.Close asChild>
              <button type="button" aria-label="Close" className="touch-target -mr-1.5 inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg">
                <X aria-hidden className="size-4" />
              </button>
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3.5">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/**
 * Confirmation with an async action. Keeps the dialog open and shows the error (with reference)
 * if the action fails; closes on success.
 */
export function ConfirmDialog({
  open, onOpenChange, title, description, children, confirmLabel, confirmVariant = 'primary', onConfirm, confirmDisabledReason, size = 'sm',
}: {
  open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; description?: ReactNode; children?: ReactNode;
  confirmLabel: string; confirmVariant?: ButtonVariant; onConfirm: () => Promise<unknown> | unknown;
  confirmDisabledReason?: string | null; size?: DialogProps['size'];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
      title={title}
      description={description}
      size={size}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant={confirmVariant} onClick={run} loading={busy} disabledReason={confirmDisabledReason}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
      {error ? <ErrorNotice error={error} className="mt-3" /> : null}
    </Dialog>
  );
}
