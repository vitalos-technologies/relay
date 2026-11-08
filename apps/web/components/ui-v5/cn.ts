// V5 shared UI (shadcn/ui copy-in components backed by Base UI; decision D25). `cn` merges Tailwind classes so a caller's
// className overrides a variant's (shadcn convention). The older app components keep `components/ui/cn.ts` (clsx only).
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
