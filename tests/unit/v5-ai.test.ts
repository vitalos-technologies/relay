// V5 AI workspace — pure logic: suggestions (relevant + actionable, acceptance item 13), task-type guess, weekly
// planning slot/conflict maths and inbox "missing information" flags.
import { describe, expect, it } from 'vitest';
import { guessWorkflow, type AiWorkspaceDto } from '@social-lite/core/contracts/v5-ai';
import { buildSuggestions, weekToPlan } from '@social-lite/services/ai-workflows/suggestions';
import { conflicts, freeSlots } from '@social-lite/services/ai-workflows/workflows/planning';
import { missingInfo } from '@social-lite/services/ai-workflows/workflows/insight';

const B = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-10T09:00:00Z'); // Tuesday

function ctx(over: Partial<Omit<AiWorkspaceDto, 'suggestions'>> = {}, can: Partial<AiWorkspaceDto['brands'][number]['can']> = {}): Omit<AiWorkspaceDto, 'suggestions'> {
  return {
    status: { configured: false, reason: 'AI is not set up.', can_use: true, budget: { period: '2026-11', used: 0, cap: 100_000, remaining: 100_000 } },
    features: { ai_drafting: true, ai_workflows: true, upgrade_plan: null },
    brand_id: B,
    brands: [{ id: B, name: 'Acme', timezone: 'Europe/London', approval_required: false,
      accounts: [{ id: 'c1', provider: 'Instagram', display_name: 'Acme IG', ready: true, simulated: true }, { id: 'c2', provider: 'X', display_name: 'Acme X', ready: false, simulated: true }],
      can: { draft: true, schedule: true, reply: true, read_inbox: true, analytics: true, listening: true, manage_knowledge: true, ...can } }],
    documents: [{ kind: 'source_item', id: 'd1', title: 'Spring brief', brand_id: B, updated_at: '2026-11-09T09:00:00Z' }, { kind: 'post', id: 'p1', title: 'Approved post', brand_id: B, approved: true, updated_at: null }],
    knowledge: [],
    inbox: { unanswered: 4, conversations: [{ id: 'v1', title: 'Where is my order', waiting_since: null, channel: 'facebook' }] },
    analytics: { has_data: true, last_data_at: '2026-11-08T00:00:00Z' },
    listening: { available: false, searches: 0 },
    week: { calendar_posts: 2, ready_drafts: 3, slots: 0 },
    ...over,
  };
}

describe('V5 suggestions (acceptance 13: relevant and actionable)', () => {
  it('offers 4–6 suggestions from real data, each with a prefilled task', () => {
    const s = buildSuggestions(ctx(), NOW);
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(s.length).toBeLessThanOrEqual(6);
    expect(s.map((x) => x.workflow)).toEqual(['inbox_assistance', 'campaign_from_brief', 'weekly_planning', 'performance_analysis', 'content_adaptation']);
    for (const x of s) {
      expect(x.prefill.inputs.brand_id).toBe(B);
      expect(x.reason.length).toBeGreaterThan(0);
    }
    expect(s[0]!.reason).toBe('4 unanswered messages');
    expect(s[1]!.prefill.inputs).toMatchObject({ source: { kind: 'source_item', id: 'd1' } });
  });

  it('never targets an unconnected account (only ready destinations are prefilled)', () => {
    const s = buildSuggestions(ctx(), NOW);
    for (const x of s) {
      const ids = (x.prefill.inputs.connection_ids as string[] | undefined) ?? [];
      expect(ids).not.toContain('c2');
    }
    const none = buildSuggestions(ctx({ brands: [{ ...ctx().brands[0]!, accounts: [{ id: 'c2', provider: 'X', display_name: 'Acme X', ready: false, simulated: false }] }] }), NOW);
    expect(none.map((x) => x.workflow)).not.toContain('campaign_from_brief');
    expect(none.map((x) => x.workflow)).not.toContain('weekly_planning');
    expect(none.map((x) => x.workflow)).not.toContain('content_adaptation');
  });

  it('offers a campaign even without documents (the task flow asks for a brief) and adaptation of an unapproved post', () => {
    const s = buildSuggestions(ctx({ documents: [{ kind: 'post', id: 'p2', title: 'Draft post', brand_id: B, approved: false, updated_at: null }] }), NOW);
    const camp = s.find((x) => x.workflow === 'campaign_from_brief')!;
    expect(camp).toMatchObject({ title: 'Turn a brief into a campaign', reason: 'Attach a text or Markdown brief' });
    expect(camp.prefill.inputs.source).toBeUndefined();
    expect(s.find((x) => x.workflow === 'content_adaptation')!.reason).toBe('“Draft post” · not approved yet');
  });

  it('respects permissions, data availability and plan features', () => {
    expect(buildSuggestions(ctx({}, { read_inbox: false }), NOW).map((x) => x.workflow)).not.toContain('inbox_assistance');
    expect(buildSuggestions(ctx({ analytics: { has_data: false, last_data_at: null } }), NOW).map((x) => x.workflow)).not.toContain('performance_analysis');
    expect(buildSuggestions(ctx({ inbox: { unanswered: 0, conversations: [] } }), NOW).map((x) => x.workflow)).not.toContain('inbox_assistance');
    // Standard plan: no multi-step workflows; single-step ask only when AI is set up.
    const standard = buildSuggestions(ctx({ features: { ai_drafting: true, ai_workflows: false, upgrade_plan: 'professional' } }), NOW);
    expect(standard).toEqual([]);
    const standardOn = buildSuggestions(ctx({ features: { ai_drafting: true, ai_workflows: false, upgrade_plan: 'professional' }, status: { ...ctx().status, configured: true } }), NOW);
    expect(standardOn.map((x) => x.workflow)).toEqual(['ask']);
    expect(buildSuggestions(ctx({ status: { ...ctx().status, can_use: false } }), NOW)).toEqual([]);
  });

  it('never suggests listening analysis (no listening workflow without data)', () => {
    const s = buildSuggestions(ctx({ listening: { available: false, searches: 3 } }), NOW);
    expect(s.some((x) => /listening|topics/i.test(x.title))).toBe(false);
  });

  it('plans this week until Thursday, then next week', () => {
    expect(weekToPlan(new Date('2026-11-10T09:00:00Z'))).toBe('2026-11-09');
    expect(weekToPlan(new Date('2026-11-13T09:00:00Z'))).toBe('2026-11-16');
    expect(weekToPlan(new Date('2026-11-15T09:00:00Z'))).toBe('2026-11-16');
  });
});

describe('V5 composer task guess (deterministic)', () => {
  it('maps free text to a workflow, defaulting to ask', () => {
    expect(guessWorkflow('Draft replies to the unanswered messages')).toBe('inbox_assistance');
    expect(guessWorkflow('Explain this month’s performance')).toBe('performance_analysis');
    expect(guessWorkflow('Plan next week')).toBe('weekly_planning');
    expect(guessWorkflow('Create platform-specific versions of the launch post')).toBe('content_adaptation');
    expect(guessWorkflow('Turn the spring brief into a campaign')).toBe('campaign_from_brief');
    expect(guessWorkflow('What is our returns window?')).toBe('ask');
  });
});

describe('V5 weekly planning maths', () => {
  const cal = [
    { post_id: 'a', title: 'A', due_at: '2026-11-11T10:00:00Z', local: '2026-11-11T10:00', connection_ids: ['c1'], status: 'active' },
    { post_id: 'b', title: 'B', due_at: '2026-11-11T10:30:00Z', local: '2026-11-11T10:30', connection_ids: ['c1'], status: 'active' },
    { post_id: 'c', title: 'C', due_at: '2026-11-11T10:15:00Z', local: '2026-11-11T10:15', connection_ids: ['c9'], status: 'active' },
  ];
  it('finds same-account conflicts under an hour apart only', () => {
    const c = conflicts(cal);
    expect(c.map(([x, y]) => `${x.post_id}${y.post_id}`)).toEqual(['ab']);
  });
  it('removes past and occupied slots', () => {
    const slots = [
      { local: '2026-11-10T08:00', instant: '2026-11-10T08:00:00Z', connection_ids: null }, // past
      { local: '2026-11-11T10:20', instant: '2026-11-11T10:20:00Z', connection_ids: ['c1'] }, // taken on c1
      { local: '2026-11-11T10:20', instant: '2026-11-11T10:20:00Z', connection_ids: ['c5'] }, // other account: free
      { local: '2026-11-12T10:00', instant: '2026-11-12T10:00:00Z', connection_ids: null },
    ];
    expect(freeSlots(slots, cal, NOW).map((s) => `${s.local}/${s.connection_ids?.join(',') ?? '*'}`)).toEqual(['2026-11-11T10:20/c5', '2026-11-12T10:00/*']);
  });
});

describe('V5 inbox missing information', () => {
  it('flags order questions without an order number', () => {
    expect(missingInfo('order_status', 'Where is my parcel?')).toEqual(['No order number in the message.']);
    expect(missingInfo('order_status', 'Where is order #48213?')).toEqual([]);
    expect(missingInfo('praise', 'Love it')).toEqual([]);
  });
});
