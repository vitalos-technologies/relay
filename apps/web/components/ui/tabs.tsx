'use client';
import * as T from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cn } from './cn';

export const Tabs = T.Root;

export function TabsList({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <T.List aria-label={label} className={cn('flex gap-1 overflow-x-auto border-b border-border', className)}>
      {children}
    </T.List>
  );
}

export function TabsTrigger({ value, children, className, disabled }: { value: string; children: ReactNode; className?: string; disabled?: boolean }) {
  return (
    <T.Trigger
      value={value}
      disabled={disabled}
      className={cn(
        'focus-inset touch-target relative -mb-px inline-flex h-10 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-[13px] font-medium text-muted transition-colors hover:text-fg disabled:opacity-50',
        'data-[state=active]:border-[var(--text)] data-[state=active]:text-fg',
        className,
      )}
    >
      {children}
    </T.Trigger>
  );
}

export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <T.Content value={value} className={cn('pt-6 focus-visible:outline-none', className)}>
      {children}
    </T.Content>
  );
}
