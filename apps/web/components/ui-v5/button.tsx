// V5 Button + ButtonLink (shadcn/ui "button", Base UI variant, adapted to Relay's namespaced v5 tokens).
//  - <Button> = Base UI Button (a real <button>; client component).
//  - <ButtonLink> = a plain <a> with the same look (server-safe, no JS). Never wrap a link in a button or vice versa.
// Colours come from --v5-* tokens: the app scope maps them to the app palette; `.mkt` (marketing page) maps them to the
// purple marketing palette (D24). See apps/web/app/globals.css "V5 shared UI tokens".
import type { AnchorHTMLAttributes, ComponentProps } from 'react';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-semibold transition-[background-color,color,box-shadow,transform] duration-150 select-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v5-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 motion-safe:active:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        primary: 'bg-v5-primary text-v5-on-primary shadow-[0_1px_2px_rgb(0_0_0/0.08)] hover:bg-v5-primary-hover',
        outline: 'border border-v5-border-strong bg-v5-surface text-v5-fg hover:bg-v5-raised',
        secondary: 'bg-v5-primary-soft text-v5-primary-text hover:bg-v5-raised',
        ghost: 'text-v5-fg hover:bg-v5-raised',
        link: 'h-auto px-0 text-v5-primary-text underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-9 px-3.5 text-[13px]',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-[15px]',
        icon: 'size-10',
      },
      shape: { pill: 'rounded-full', rounded: 'rounded-xl' },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'primary', size: 'md', shape: 'pill' },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, shape, ...props }: ButtonPrimitive.Props & ButtonVariantProps) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size, shape }), className)} {...props} />;
}

/** Link styled as a button. `href` may be an in-page anchor (#pricing), an app route or an auth route. */
export function ButtonLink({ className, variant, size, shape, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & ButtonVariantProps & { href: string }) {
  return <a data-slot="button" className={cn(buttonVariants({ variant, size, shape }), className)} {...props} />;
}

export type ButtonProps = ComponentProps<typeof Button>;
