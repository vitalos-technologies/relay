// WhatsApp Business Platform charges shown BEFORE a send (H2). Pure and client-safe: the server decides (and requires an
// acknowledgement for anything billable); the template dialog uses the same function to show the notice early.
//
// Meta pricing (developers.facebook.com/docs/whatsapp/pricing and …/pricing/updates-to-pricing, checked 2026-11-09):
// - Charged per delivered message by category (marketing, utility, authentication, service) and recipient market.
// - From 2026-10-01: utility templates inside an open customer service window are charged (pricing type `regular`;
//   free since 2025-07-01 before that), and service messages (non-template replies inside the window) are charged
//   after a free tier of 1,000 delivered service messages per month per business phone number. The tier resets at
//   midnight in the Meta messaging account's time zone; unused messages don't roll over.
// - Free entry point windows (Click-to-WhatsApp ads) aren't modelled: Relay can't see them, so it shows the charge.
// Relay can only count what it sent. It counts conservatively (from the earliest possible month start in any time zone,
// queued and in-flight sends included) and also treats the allowance as used up once Meta has priced a service message
// as billable this month, so it never shows a charged message as free because of counting.

export const WHATSAPP_PRICING_CHANGE_AT = '2026-10-01T00:00:00.000Z';
export const WHATSAPP_FREE_SERVICE_MESSAGES_PER_MONTH = 1000;

export type WhatsAppChargeCategory = 'marketing' | 'utility' | 'authentication' | 'service';
export type WhatsAppRates = Partial<Record<WhatsAppChargeCategory, { amount: number; currency: string }>>;
export interface WhatsAppChargeNotice { billable: boolean; category: string; estimate: { amount: number; currency: string } | null; note: string }
/** Service messages Relay has sent from this number in the current Meta month, and whether Meta already billed one. */
export interface WhatsAppServiceAllowance { used: number; limit: number; billed_this_month: boolean }

export function whatsAppChargeFor(input: {
  /** Template category; null for a free-form (service) reply. A template with no category is treated as marketing. */
  template: { category: WhatsAppChargeCategory | null } | null;
  windowOpen: boolean;
  now: Date;
  service?: WhatsAppServiceAllowance | null;
  rates?: WhatsAppRates | null;
}): WhatsAppChargeNotice {
  const after = input.now.getTime() >= Date.parse(WHATSAPP_PRICING_CHANGE_AT);
  const cat: WhatsAppChargeCategory = input.template ? (input.template.category ?? 'marketing') : 'service';
  const charged = (note: string): WhatsAppChargeNotice => ({ billable: true, category: cat, estimate: input.rates?.[cat] ?? null, note });
  if (cat === 'service') {
    if (!after) return { billable: false, category: 'service', estimate: null, note: 'Free: a reply inside the 24-hour customer service window.' };
    const s = input.service;
    if (s && !s.billed_this_month && s.used < s.limit) {
      return { billable: false, category: 'service', estimate: null,
        note: `Free: within Meta’s ${s.limit.toLocaleString('en-GB')} free service messages this month for this number (${s.used.toLocaleString('en-GB')} sent through Relay so far).` };
    }
    return charged(`Charged by Meta: this number has used its ${WHATSAPP_FREE_SERVICE_MESSAGES_PER_MONTH.toLocaleString('en-GB')} free service messages this month (service rate for the recipient’s country).`);
  }
  if (cat === 'utility' && input.windowOpen && !after) return { billable: false, category: 'utility', estimate: null, note: 'Free: a utility template inside the 24-hour customer service window.' };
  return charged(`Charged by Meta per delivered message (${cat} rate for the recipient’s country).`);
}

/**
 * Earliest instant the current Meta month can have started, whatever the messaging account's time zone (UTC−12 to
 * UTC+14). Counting from here over-counts at worst, so the free allowance is never overstated.
 */
export function whatsAppServiceMonthStart(now: Date): Date {
  const startIn = (offsetHours: number) => {
    const local = new Date(now.getTime() + offsetHours * 3600_000);
    return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offsetHours * 3600_000;
  };
  return new Date(Math.min(startIn(-12), startIn(14)));
}
