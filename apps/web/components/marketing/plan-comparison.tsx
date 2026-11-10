'use client';
// Expandable comparison (brief §6: keep cards short, detailed allowances in an expandable comparison on the same page).
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui-v5/collapsible';

export function PlanComparison({ children }: { children: ReactNode }) {
  return (
    <Collapsible className="mx-auto w-full min-w-0 max-w-[1120px]">
      <div className="flex justify-center">
        <CollapsibleTrigger className="group inline-flex min-h-11 items-center gap-2 rounded-full border border-v5-border bg-v5-surface px-5 text-[15px] font-semibold text-v5-fg outline-none hover:bg-v5-raised focus-visible:outline-2 focus-visible:outline-v5-ring" data-testid="mkt-compare">
          Compare plans and allowances
          <ChevronDown aria-hidden className="size-4 transition-transform duration-200 group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="pt-6">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
