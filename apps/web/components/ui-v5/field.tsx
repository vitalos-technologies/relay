// V5 form fields (shadcn/ui "input" / "textarea" / "label" / native select, adapted to --v5-* tokens). Added by stream WID
// (support widget forms); plain native elements — server-safe, no JS, one interactive element each. Reuse for any V5 form.
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';

const control = 'w-full min-w-0 rounded-xl border border-v5-border-strong bg-v5-surface px-3 text-[15px] text-v5-fg placeholder:text-v5-muted outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-v5-ring focus-visible:ring-2 focus-visible:ring-v5-ring/30 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-[color:var(--v5-warn)] motion-reduce:transition-none';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn(control, 'h-11', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(control, 'min-h-24 resize-y py-2.5 leading-relaxed', className)} {...props} />;
}

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select data-slot="select" className={cn(control, 'h-11 appearance-auto pr-2', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label data-slot="label" className={cn('text-[13px] font-medium text-v5-fg', className)} {...props} />;
}

/** Label + control + optional hint / error, wired with ids for screen readers (aria-describedby / aria-invalid). */
export function Field({ id, label, hint, error, children, className }: { id: string; label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error ? <p id={`${id}-hint`} className="text-xs text-v5-muted">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="text-xs font-medium text-[color:var(--v5-warn)]">{error}</p> : null}
    </div>
  );
}

/** Props to spread on the control inside <Field> so hint/error are announced. */
export function describedBy(id: string, hint?: unknown, error?: string | null): { 'aria-describedby'?: string; 'aria-invalid'?: true } {
  if (error) return { 'aria-describedby': `${id}-error`, 'aria-invalid': true };
  return hint ? { 'aria-describedby': `${id}-hint` } : {};
}
