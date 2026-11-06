'use client';
import * as S from '@radix-ui/react-switch';
import { useId, type ReactNode } from 'react';
import { cn } from './cn';

export function Switch({
  checked, onCheckedChange, label, description, disabled, className,
}: { checked: boolean; onCheckedChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean; className?: string }) {
  const id = useId();
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">{label}</label>
        {description ? <p id={`${id}-d`} className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      <S.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={description ? `${id}-d` : undefined}
        className="relative mt-0.5 inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-border-strong bg-sunken transition-colors data-[state=checked]:border-transparent data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <S.Thumb className="block size-[18px] translate-x-[2px] rounded-full bg-[var(--muted)] transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-[var(--on-accent)]" />
      </S.Root>
    </div>
  );
}
