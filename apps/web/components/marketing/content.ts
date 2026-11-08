// Marketing copy that states facts about the product. Every number comes from the shared catalogue (plan-data.ts →
// v4-plans.ts); every behaviour matches docs/v4/PLANS_AND_ENTITLEMENTS.md, BILLING_LIFECYCLE_AND_WEBHOOKS.md and
// FAILED_PAYMENT_AND_DOWNGRADE.md (the code they describe). Keep answers short; change them when the implementation changes.
import { PLANS, allowanceFor } from '@social-lite/core/contracts/v4-plans';
import { GUEST_SEAT_EXEMPTION, TRIAL_DAYS, TRIAL_REQUIRES_CARD, describeAllowance, formatMinorGBP, pricingPlans, recurringTotalMinor } from './plan-data';
import { networks, STATUS_LABEL } from './integrations-data';

export interface FaqEntry { id: string; q: string; a: string[] }

export function faq(): FaqEntry[] {
  const [standard, professional] = pricingPlans();
  const s3 = formatMinorGBP(recurringTotalMinor('standard', 3));
  const p3 = formatMinorGBP(recurringTotalMinor('professional', 3));
  const live = networks().filter((n) => n.status === 'available').map((n) => n.name);
  const gated = networks().filter((n) => n.status !== 'available').map((n) => n.name);
  const ai = (id: 'standard' | 'professional') => describeAllowance('ai_tokens', PLANS[id].allowances.ai_tokens);
  const trialAi = allowanceFor(PLANS.standard.trial_allowances, 'ai_tokens', 1)!.toLocaleString('en-GB');
  return [
    {
      id: 'trial', q: 'How does the free trial work?',
      a: [
        `Every new workspace gets one ${TRIAL_DAYS}-day free trial of the plan you pick${TRIAL_REQUIRES_CARD ? '' : ' — no card needed'}. It starts when you create the workspace and ends at the time shown in Billing.`,
        `Trials include bounded allowances (for example ${trialAi} AI tokens for the whole trial). You can switch plan during the trial without changing the end date. Joining another workspace or signing up again doesn’t start a new trial.`,
        'If you subscribe during the trial, the first charge is on the day the trial ends. If you don’t, paid actions pause — scheduled posts are held, never published or deleted — and your data, billing, support and exports stay available.',
      ],
    },
    {
      id: 'per-user', q: 'How does per-user pricing work?',
      a: [
        `${standard!.name} is ${standard!.price} and ${professional!.name} is ${professional!.price} per user per month, billed monthly in GBP. Three ${standard!.name} users cost ${s3} a month; three ${professional!.name} users cost ${p3}.`,
        `A user is an active member of your workspace, including the owner. Pending invitations, Relay support staff and service accounts aren’t counted, and up to ${GUEST_SEAT_EXEMPTION.max_free_guests} review-only guests are free. Any tax is shown at checkout.`,
      ],
    },
    {
      id: 'channels', q: 'Which channels are supported?',
      a: [
        `Publishing works with ${networks().map((n) => n.name).join(', ')}. ${live.join(' and ')} connect with your own credentials today; ${gated.join(', ')} go live as each provider approves access (shown as “${STATUS_LABEL.provider_access}” or “${STATUS_LABEL.limited}” above).`,
        'The social inbox covers Facebook, Instagram, Threads, YouTube, Bluesky, Telegram, WhatsApp and Google reviews, as far as each network’s official API allows. X, LinkedIn and TikTok inboxes aren’t available yet. Relay never scrapes.',
      ],
    },
    {
      id: 'teammates', q: 'How do I add teammates?',
      a: [
        'Invite people from Team with a role. During the trial there’s no seat limit.',
        'On a paid plan, each new member needs a paid seat. An owner or billing admin adds seats in Billing, which shows the new seat count and monthly total before confirming. Seat reductions take effect at the end of the billing period.',
      ],
    },
    {
      id: 'cancel', q: 'Can I cancel at any time?',
      a: [
        'Yes. Cancel renewal in Billing and your plan runs until the end of the period you’ve paid for. You can resume before then.',
        'After it ends, paid actions pause but nothing is deleted: your posts, media, analytics and conversations stay, and billing, support and exports remain available.',
      ],
    },
    {
      id: 'limits', q: 'Are there limits on AI and integrations?',
      a: [
        `Yes — nothing is unlimited. AI usage has a monthly token allowance (${standard!.name}: ${ai('standard')}; ${professional!.name}: ${ai('professional')}). Multi-step AI workflows, business integrations, automations and MCP are in ${professional!.name}, each with its own monthly allowance. See “Compare plans” for every number.`,
        'There are no overage charges: at a limit the action waits or is refused, and owners can set lower budgets. Paid third-party data, such as X API usage or licensed listening sources, isn’t included.',
      ],
    },
  ];
}

/** Capability strip (brief §4). */
export const CAPABILITIES = [
  { id: 'plan', label: 'Plan', text: 'One calendar for every brand and channel.' },
  { id: 'engage', label: 'Engage', text: 'Reply to comments and messages in one inbox.' },
  { id: 'understand', label: 'Understand', text: 'See what works, with honest data coverage.' },
  { id: 'collaborate', label: 'Collaborate', text: 'Comments, tasks and approvals in context.' },
] as const;
