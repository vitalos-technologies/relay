// Context-aware suggestions below the composer (V5 §12). Pure: derived only from the workspace context the server
// assembled for THIS person (brand, connected accounts, documents, permissions, plan features, real data). A suggestion
// is offered only when it can actually run: never publishing to an unconnected account, never analysing data that does
// not exist (no listening/analytics suggestion without data), never a multi-step workflow without the plan feature.
import type { AiWorkspaceDto, SuggestionDto, WorkspaceBrandDto, WorkspaceDocumentDto } from '@social-lite/core/contracts/v5-ai';

export type SuggestionInput = Omit<AiWorkspaceDto, 'suggestions'>;

const ago = (iso: string | null, now: Date): string => {
  if (!iso) return '';
  const d = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};

/** Monday (YYYY-MM-DD) of the week to plan: this week until Thursday, then next week. */
export function weekToPlan(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const wd = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (wd - 1) + (wd >= 5 ? 7 : 0));
  return d.toISOString().slice(0, 10);
}

export function buildSuggestions(c: SuggestionInput, now = new Date()): SuggestionDto[] {
  const brand: WorkspaceBrandDto | undefined = c.brands.find((b) => b.id === c.brand_id);
  if (!brand || !c.status.can_use) return [];
  const ready = brand.accounts.filter((a) => a.ready);
  const wf = c.features.ai_workflows;
  const out: SuggestionDto[] = [];
  const brandDocs = c.documents.filter((d) => d.brand_id === brand.id);
  const briefs = brandDocs.filter((d) => d.kind === 'source_item' || d.kind === 'knowledge' || d.kind === 'attachment');
  const approvedPosts = brandDocs.filter((d) => d.kind === 'post' && d.approved);
  const base = { brand_id: brand.id };
  // Default destinations: one ready account per network, at most five (the person can change them).
  const defaults = ready.filter((a, i) => ready.findIndex((b) => b.provider === a.provider) === i).slice(0, 5).map((a) => a.id);

  if (wf && brand.can.read_inbox && c.inbox && c.inbox.unanswered > 0) {
    const ids = c.inbox.conversations.slice(0, 5).map((x) => x.id);
    out.push({ id: 'inbox', workflow: 'inbox_assistance', title: 'Draft replies to unanswered messages',
      description: brand.can.reply ? 'Summarise the issues, flag missing details and prepare replies for your review.' : 'Summarise the issues and prepare reply drafts for a teammate.',
      reason: `${c.inbox.unanswered} unanswered message${c.inbox.unanswered === 1 ? '' : 's'}`, flow: 'pick_conversations',
      prefill: { prompt: '', inputs: { ...base, conversation_ids: ids } } });
  }
  if (wf && brand.can.draft && ready.length) {
    const doc: WorkspaceDocumentDto | undefined = briefs[0];
    const where = defaults.length === 1 ? ready[0]!.display_name : `${defaults.length} accounts`;
    out.push(doc ? {
      id: 'campaign', workflow: 'campaign_from_brief', title: 'Turn this document into a campaign',
      description: `Outline a campaign from “${doc.title}” and save drafts for ${where}.`,
      reason: `“${doc.title}”${doc.updated_at ? ` · updated ${ago(doc.updated_at, now)}` : ''}`, flow: 'pick_document',
      prefill: { prompt: '', inputs: { ...base, source: { kind: doc.kind, id: doc.id }, connection_ids: defaults } },
    } : {
      // No document yet: the task flow asks for one (attach a text/Markdown brief or link one in the Content library).
      id: 'campaign', workflow: 'campaign_from_brief', title: 'Turn a brief into a campaign',
      description: `Attach a brief and Relay outlines a campaign and saves drafts for ${where}.`,
      reason: 'Attach a text or Markdown brief', flow: 'pick_document',
      prefill: { prompt: '', inputs: { ...base, connection_ids: defaults } },
    });
  }
  if (wf && brand.can.draft && ready.length) {
    const week = weekToPlan(now);
    out.push({ id: 'week', workflow: 'weekly_planning', title: 'Plan this week’s posts',
      description: brand.can.schedule || brand.approval_required ? 'Check the calendar, place ready drafts on free slots and prepare the schedule for review.' : 'Check the calendar and propose times for ready drafts.',
      reason: [c.week.calendar_posts ? `${c.week.calendar_posts} planned` : 'Nothing planned yet', c.week.ready_drafts ? `${c.week.ready_drafts} ready draft${c.week.ready_drafts === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '),
      flow: 'pick_week', prefill: { prompt: '', inputs: { ...base, week_start: week } } });
  }
  if (wf && brand.can.analytics && c.analytics?.has_data) {
    out.push({ id: 'performance', workflow: 'performance_analysis', title: 'Explain this month’s performance',
      description: 'Compare the last 28 days with the period before, with dates, coverage and evidence.',
      reason: c.analytics.last_data_at ? `Data up to ${c.analytics.last_data_at.slice(0, 10)}` : 'Stored analytics available', flow: 'pick_range',
      prefill: { prompt: '', inputs: { ...base, range_days: 28 } } });
  }
  const posts = brandDocs.filter((d) => d.kind === 'post');
  if (wf && brand.can.draft && ready.length && posts.length) {
    // Prefer approved material; an unapproved post is offered too (the run asks before using it).
    const p = approvedPosts[0] ?? posts[0]!;
    out.push({ id: 'adapt', workflow: 'content_adaptation', title: 'Create platform-specific versions',
      description: `Adapt “${p.title}” for each account as new drafts${p.approved ? ' without changing the approved post' : ''}.`, reason: p.approved ? `“${p.title}” is approved` : `“${p.title}” · not approved yet`, flow: 'pick_post',
      prefill: { prompt: '', inputs: { ...base, source: { kind: 'post', id: p.id }, connection_ids: defaults } } });
  }
  // Single-step ask (Standard keeps basic drafting). Only when a provider is set up: without one it could not do anything.
  if (c.features.ai_drafting && c.status.configured) {
    const knowledge = c.knowledge.filter((k) => k.brand_id === brand.id && k.available).length;
    if (knowledge) {
      out.push({ id: 'ask-knowledge', workflow: 'ask', title: `Ask about ${brand.name}`, description: 'Answers use only approved knowledge, with quotes you can check.',
        reason: `${knowledge} approved source${knowledge === 1 ? '' : 's'}`, flow: 'prompt', prefill: { prompt: '', inputs: { ...base } } });
    }
    if (brand.can.draft && ready.length) {
      const a = ready[0]!;
      out.push({ id: 'ask-draft', workflow: 'ask', title: `Draft a post for ${a.display_name}`, description: 'Get copy in your brand voice to paste into a draft.',
        reason: `${a.provider} connected`, flow: 'prompt', prefill: { prompt: `Draft a short post for ${a.provider} about `, inputs: { ...base } } });
    }
  }
  return out.slice(0, 6);
}
