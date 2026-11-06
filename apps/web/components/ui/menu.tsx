'use client';
import * as M from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from './cn';

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({ children, align = 'end', className }: { children: ReactNode; align?: 'start' | 'end' | 'center'; className?: string }) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className={cn('anim-pop z-[60] min-w-[200px] rounded-xl border border-border bg-raised p-1 shadow-[var(--shadow)]', className)}
      >
        {children}
      </M.Content>
    </M.Portal>
  );
}

export function MenuItem({ children, onSelect, icon, danger, disabled }: { children: ReactNode; onSelect?: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <M.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        'touch-target flex h-9 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 text-[13px] outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-surface [&>svg]:size-4 [&>svg]:text-muted',
        danger && 'text-danger [&>svg]:text-danger',
      )}
    >
      {icon}
      {children}
    </M.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.06em] text-subtle">{children}</M.Label>;
}
export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-border" />;
}
export const MenuRadioGroup = M.RadioGroup;
export function MenuRadioItem({ value, children, icon }: { value: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <M.RadioItem
      value={value}
      className="touch-target flex h-9 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 text-[13px] outline-none data-[highlighted]:bg-surface data-[state=checked]:text-accent-text [&>svg]:size-4"
    >
      {icon}
      <span className="flex-1">{children}</span>
      <M.ItemIndicator><span aria-hidden className="size-1.5 rounded-full bg-[var(--accent-text)] inline-block" /></M.ItemIndicator>
    </M.RadioItem>
  );
}

export function MenuLinkItem({ href, children, icon, active }: { href: string; children: ReactNode; icon?: ReactNode; active?: boolean }) {
  return (
    <M.Item asChild>
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        className="touch-target flex h-10 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 text-[13px] outline-none data-[highlighted]:bg-surface aria-[current=page]:text-accent-text [&>svg]:size-4 [&>svg]:text-muted"
      >
        {icon}
        {children}
      </Link>
    </M.Item>
  );
}
