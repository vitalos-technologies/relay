'use client';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import Link from 'next/link';
import { LoaderCircle } from 'lucide-react';
import { cn } from './cn';
import { Tooltip } from './tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
export type ButtonSize = 'sm' | 'md' | 'lg';

const base =
  'touch-target inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap select-none transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-[0_0_0_1px_rgba(0,0,0,0.12)_inset]',
  secondary: 'bg-transparent text-fg border border-border hover:bg-raised',
  ghost: 'text-fg hover:bg-raised',
  quiet: 'text-muted hover:text-fg hover:bg-raised',
  danger: 'bg-danger-soft text-danger border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] hover:bg-[color-mix(in_srgb,var(--danger)_18%,transparent)]',
};
const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-5 text-[15px]',
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string) {
  return cn(base, variants[variant], sizes[size], extra);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  /** When disabled, explain why (shown as tooltip + sr text). */
  disabledReason?: string | null;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, disabledReason, className, children, disabled, type = 'button', onClick, ...rest },
  ref,
) {
  // With a reason we keep the button focusable (aria-disabled) so the explanation is reachable by keyboard.
  const soft = !!disabledReason && !disabled;
  const btn = (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={soft ? undefined : disabled || loading}
      aria-disabled={soft || loading || undefined}
      aria-busy={loading || undefined}
      onClick={soft || loading ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {loading ? <LoaderCircle aria-hidden className="size-4 anim-spin" /> : icon}
      {children}
      {soft ? <span className="sr-only">{` (unavailable: ${disabledReason})`}</span> : null}
    </button>
  );
  if (disabledReason) return <Tooltip content={disabledReason}>{btn}</Tooltip>;
  return btn;
});

export function LinkButton({
  href, variant = 'secondary', size = 'md', icon, className, children, external, ...rest
}: { href: string; variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode; className?: string; children: ReactNode; external?: boolean } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  if (external) {
    return (
      <a href={href} className={buttonClass(variant, size, className)} {...rest}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  tooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'quiet', size = 'md', className, tooltip = true, type = 'button', ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(base, variants[variant], size === 'sm' ? 'size-8' : 'size-9', 'p-0', className)}
      {...rest}
    >
      {icon}
    </button>
  );
  return tooltip ? <Tooltip content={label}>{btn}</Tooltip> : btn;
});
