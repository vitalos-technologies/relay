'use client';
import * as P from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { cn } from './cn';

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverClose = P.Close;

export function PopoverContent({ children, className, align = 'end', label }: { children: ReactNode; className?: string; align?: 'start' | 'end' | 'center'; label?: string }) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={8}
        collisionPadding={8}
        aria-label={label}
        className={cn('anim-pop z-[60] w-[360px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-raised shadow-[var(--shadow)]', className)}
      >
        {children}
      </P.Content>
    </P.Portal>
  );
}
