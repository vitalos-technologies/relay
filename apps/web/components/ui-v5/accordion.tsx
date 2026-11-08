'use client';
// V5 Accordion (shadcn/ui "accordion", Base UI variant). Base UI renders a heading + button trigger with aria-expanded /
// aria-controls and a region panel; height animates through --accordion-panel-height (disabled for reduced motion).
import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';

export function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
  return <AccordionPrimitive.Root data-slot="accordion" className={cn('flex w-full flex-col', className)} {...props} />;
}

export function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return <AccordionPrimitive.Item data-slot="accordion-item" className={cn('border-b border-v5-border last:border-b-0', className)} {...props} />;
}

export function AccordionTrigger({ className, children, headingLevel = 3, ...props }: AccordionPrimitive.Trigger.Props & { headingLevel?: 2 | 3 | 4 }) {
  const H = `h${headingLevel}` as 'h3';
  return (
    <AccordionPrimitive.Header data-slot="accordion-header" className="flex" render={<H />}>
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          'group/accordion-trigger flex min-h-12 flex-1 items-center justify-between gap-4 rounded-lg py-4 text-left text-[15px] font-semibold text-v5-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v5-ring hover:text-v5-primary-text',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown aria-hidden className="size-4 shrink-0 text-v5-muted transition-transform duration-200 group-aria-expanded/accordion-trigger:rotate-180 motion-reduce:transition-none" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({ className, children, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="h-(--accordion-panel-height) overflow-hidden text-sm text-v5-muted transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none"
      {...props}
    >
      <div className={cn('pb-5 pr-8 leading-relaxed [&_a]:font-medium [&_a]:text-v5-primary-text [&_a]:underline [&_a]:underline-offset-2 [&_p+p]:mt-3', className)}>{children}</div>
    </AccordionPrimitive.Panel>
  );
}
