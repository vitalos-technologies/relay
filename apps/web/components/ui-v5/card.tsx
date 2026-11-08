// V5 Card (shadcn/ui "card", adapted to v5 tokens). Plain markup, server-safe.
import type { ComponentProps } from 'react';
import { cn } from './cn';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('flex flex-col rounded-[20px] border border-v5-border bg-v5-surface text-v5-fg shadow-[0_1px_2px_rgb(15_15_45/0.04),0_8px_24px_-12px_rgb(15_15_45/0.10)]', className)} {...props} />;
}
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1.5 p-6 pb-0', className)} {...props} />;
}
export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 data-slot="card-title" className={cn('text-lg font-semibold tracking-[-0.01em] text-v5-fg', className)} {...props} />;
}
export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p data-slot="card-description" className={cn('text-sm text-v5-muted', className)} {...props} />;
}
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('p-6', className)} {...props} />;
}
export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('flex items-center gap-3 p-6 pt-0', className)} {...props} />;
}
