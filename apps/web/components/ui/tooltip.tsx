'use client';
import * as T from '@radix-ui/react-tooltip';
import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <T.Provider delayDuration={250} skipDelayDuration={100}>{children}</T.Provider>;
}

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="anim-fade z-[60] max-w-[280px] rounded-md border border-border bg-raised px-2.5 py-1.5 text-xs text-fg shadow-[var(--shadow)]"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

/** Small focusable "i" that reveals a short explanation. Use instead of a paragraph of help text. */
export function InfoTip({ children, label = 'More info', className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <Tooltip content={children}>
      <button
        type="button"
        aria-label={label}
        className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-subtle hover:text-fg', className)}
        onClick={(e) => e.preventDefault()}
      >
        <Info aria-hidden className="size-3.5" />
      </button>
    </Tooltip>
  );
}
