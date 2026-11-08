'use client';
import { cloneElement, forwardRef, isValidElement, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown, CircleExclamationPoint } from 'lucide-react';
import { cn } from './cn';
import { InfoTip } from './tooltip';

const control =
  'w-full rounded-lg border border-border bg-sunken px-3 text-sm text-fg placeholder:text-subtle transition-colors hover:border-border-strong focus-visible:border-[var(--focus)] disabled:opacity-60 disabled:cursor-not-allowed aria-[invalid=true]:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(control, 'h-10 touch-target', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(control, 'min-h-24 py-2.5 leading-relaxed resize-y', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <span className={cn('relative block', className)}>
      <select ref={ref} className={cn(control, 'h-10 appearance-none pr-9 touch-target')} {...rest}>
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
    </span>
  );
});

/**
 * Label + control + hint + error. The single child control receives id, aria-describedby and aria-invalid.
 */
export function Field({
  label, hint, info, error, children, className, required, optional, labelHidden,
}: {
  label: ReactNode; hint?: ReactNode; info?: ReactNode; error?: ReactNode; children: ReactElement; className?: string;
  required?: boolean; optional?: boolean; labelHidden?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        required,
      })
    : children;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className={cn('flex items-center gap-1', labelHidden && 'sr-only')}>
        <label htmlFor={id} className="text-[13px] font-medium text-fg">
          {label}
          {optional ? <span className="ml-1.5 font-normal text-subtle">Optional</span> : null}
        </label>
        {info ? <InfoTip>{info}</InfoTip> : null}
      </div>
      {child}
      {hint ? <p id={hintId} className="text-xs text-muted">{hint}</p> : null}
      {error ? (
        <p id={errId} className="flex items-start gap-1.5 text-xs text-danger">
          <CircleExclamationPoint aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({
  label, description, className, ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-[18px] shrink-0 cursor-pointer accent-[var(--text)] disabled:cursor-not-allowed"
        aria-describedby={description ? `${id}-d` : undefined}
        {...rest}
      />
      <div className="min-w-0">
        <label htmlFor={id} className={cn('cursor-pointer text-sm', rest.disabled && 'cursor-not-allowed text-muted')}>{label}</label>
        {description ? <p id={`${id}-d`} className="text-xs text-muted">{description}</p> : null}
      </div>
    </div>
  );
}

export function RadioGroup<T extends string>({
  legend, value, onChange, options, name, className, legendHidden,
}: {
  legend: ReactNode; value: T; onChange: (v: T) => void; name: string; className?: string; legendHidden?: boolean;
  options: Array<{ value: T; label: ReactNode; description?: ReactNode; disabled?: boolean }>;
}) {
  const id = useId();
  return (
    <fieldset className={cn('flex flex-col gap-2', className)}>
      <legend className={cn('mb-1 text-[13px] font-medium', legendHidden && 'sr-only')}>{legend}</legend>
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition-colors',
            value === o.value ? 'border-border-strong bg-raised' : 'border-border hover:border-border-strong',
            o.disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          <input
            type="radio"
            name={`${name}-${id}`}
            value={o.value}
            checked={value === o.value}
            disabled={o.disabled}
            onChange={() => onChange(o.value)}
            className="mt-1 size-4 shrink-0 accent-[var(--text)]"
          />
          <span className="min-w-0">
            <span className="block text-sm">{o.label}</span>
            {o.description ? <span className="block text-xs text-muted">{o.description}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Segmented control (single choice) with radio semantics. */
export function Segmented<T extends string>({
  label, value, onChange, options, className, size = 'md',
}: {
  label: string; value: T; onChange: (v: T) => void; className?: string; size?: 'sm' | 'md';
  options: Array<{ value: T; label: ReactNode; icon?: ReactNode; disabled?: boolean }>;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-lg border border-border bg-sunken p-0.5', className)}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const enabled = options.filter((x) => !x.disabled);
              const i = enabled.findIndex((x) => x.value === value);
              const n = enabled[(i + (e.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length];
              if (n) {
                onChange(n.value);
                const parent = e.currentTarget.parentElement;
                requestAnimationFrame(() => (parent?.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus());
              }
            }}
            tabIndex={on ? 0 : -1}
            className={cn(
              'touch-target inline-flex items-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
              on ? 'bg-raised text-fg shadow-[0_0_0_1px_var(--border-strong)]' : 'text-muted hover:text-fg',
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
