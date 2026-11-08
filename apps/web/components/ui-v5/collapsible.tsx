'use client';
// V5 Collapsible (shadcn/ui "collapsible", Base UI variant) with an animated panel height (--collapsible-panel-height).
import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { cn } from './cn';

export function Collapsible(props: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}
export function CollapsibleTrigger(props: CollapsiblePrimitive.Trigger.Props) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}
export function CollapsibleContent({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={cn('h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-250 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none', className)}
      {...props}
    />
  );
}
