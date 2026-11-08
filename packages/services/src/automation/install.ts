// Wires automation into the shared services (idempotent; called by the worker registration and tests):
//  - inbox hooks: 'inbox.message_received' (classification → rules), 'case.changed', 'listening.alert_fired' and
//    'content.approved' (stream F bridge);
//  - the dispatch-time guard for automated replies (inbox/replies.ts): every automated attempt is re-checked against
//    its policy (active, unexpired, no emergency stop, owner still allowed) right before the provider call;
//  - the assistant bridge for policy-driven AI runs (service-actor context + approved knowledge + token budget).
import { AppError } from '@social-lite/core';
import { getPool, maybeOne } from '@social-lite/db';
import { onInboxEvent } from '../inbox/hooks.js';
import { registerAutomatedReplyGuard } from '../inbox/replies.js';
import { registerAutomationAiBridge } from '../assistant/runs.js';
import { policyCtx } from './actor.js';
import { onAutomationAiRunFinished, onCaseChanged, onContentApproved, onListeningAlert, onMessageReceived } from './engine.js';
import { ownerGaps, policyActive, policyUsage, type PolicyRow } from './policies.js';

let installed = false;

export function installAutomation(): void {
  if (installed) return;
  installed = true;
  onInboxEvent('inbox.message_received', 'automation', async (e) => { await onMessageReceived(e); });
  onInboxEvent('case.changed', 'automation', async (e) => { await onCaseChanged(e); });
  // Stream F wiring: stream D's alert event and the approval bridge (engine/notify.ts) drive the two remaining triggers.
  onInboxEvent('listening.alert_fired', 'automation', async (e) => { await onListeningAlert(e); });
  onInboxEvent('content.approved', 'automation', async (e) => { await onContentApproved(e); });

  registerAutomatedReplyGuard(async (a) => {
    const db = getPool();
    const s = await maybeOne<{ policy_id: string }>(db, `SELECT policy_id FROM automation_sends WHERE workspace_id=$1 AND idempotency_key=$2`, [a.workspaceId, a.idempotencyKey]);
    if (!s) return { allowed: false, code: 'automation_unknown', message: 'No automation policy authorised this reply. Nothing was sent.' };
    const p = await maybeOne<PolicyRow>(db, `SELECT * FROM automation_policies WHERE id=$1`, [s.policy_id]);
    if (!p) return { allowed: false, code: 'automation_stopped', message: 'The automation policy was removed. Nothing was sent.' };
    const act = await policyActive(p, db);
    if (!act.ok) return { allowed: false, code: 'automation_stopped', message: `${act.reason} Nothing was sent.` };
    if (!p.brand_ids.includes(a.brandId) || !p.allowed_actions.some((x) => x === 'reply_saved' || x === 'reply_ai')) return { allowed: false, code: 'automation_scope', message: 'Outside the policy’s scope. Nothing was sent.' };
    const gaps = await ownerGaps(db, p.workspace_id, p.owner_id!, { brand_ids: [a.brandId], allowed_actions: ['reply_saved'] });
    if (gaps.length) return { allowed: false, code: 'sender_lost_access', message: 'The policy owner no longer has permission to reply. Nothing was sent.' };
    return { allowed: true };
  });

  registerAutomationAiBridge({
    async contextFor(run) {
      const db = getPool();
      const ar = await maybeOne<{ policy_id: string | null }>(db, `SELECT policy_id FROM automation_runs WHERE id=$1 AND workspace_id=$2`, [run.automation_run_id, run.workspace_id]);
      const p = ar?.policy_id ? await maybeOne<PolicyRow>(db, `SELECT * FROM automation_policies WHERE id=$1`, [ar.policy_id]) : null;
      if (!p) throw new AppError('invalid_state', 'The automation policy no longer exists.');
      if (!p.allowed_actions.includes('reply_ai')) throw new AppError('invalid_state', 'The policy no longer allows AI replies.');
      const u = await policyUsage(p, db);
      if (u.tokens_this_month >= p.monthly_token_budget) throw new AppError('invalid_state', 'The policy’s monthly AI budget is used up.');
      return { ctx: await policyCtx(p, run.automation_run_id!, db), knowledgeIds: p.knowledge_source_ids };
    },
    onFinished: onAutomationAiRunFinished,
  });
}

/** Tests: reset the install flag after resetInboxHooksForTests(). */
export function resetAutomationInstallForTests(): void { installed = false; }
