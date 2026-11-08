// V5 Badge (shadcn/ui "badge" look, adapted to v5 tokens). A plain <span> so it renders in server components with no JS.
import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

export const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium [&>svg]:size-3 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'border-transparent bg-v5-primary-soft text-v5-primary-text',
        neutral: 'border-v5-border bg-v5-raised text-v5-muted',
        success: 'border-transparent bg-v5-success-soft text-v5-success',
        warn: 'border-transparent bg-v5-warn-soft text-v5-warn',
        outline: 'border-v5-border-strong text-v5-fg',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
