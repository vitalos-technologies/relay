import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from './cn';

export function Table({ children, caption, className }: { children: ReactNode; caption?: string; className?: string }) {
  return (
    <div className={cn('relative overflow-x-auto rounded-xl border border-border bg-surface', className)}>
      <table className="w-full border-collapse text-left text-[13px]">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}
export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-border text-xs text-muted">{children}</thead>;
}
export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn('whitespace-nowrap px-4 py-2.5 font-medium', className)} {...rest} />;
}
export function Tr({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return <tr onClick={onClick} className={cn('border-b border-border last:border-b-0', onClick && 'cursor-pointer hover:bg-raised', className)}>{children}</tr>;
}
export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-4 py-3 align-middle', className)} {...rest} />;
}
