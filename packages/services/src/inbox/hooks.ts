// Subscribers for V3.5 inbox / case events (contracts/v35-events.ts). Streams register here: automation (E), Slack
// alerts (C), listening (D). Hooks run in the worker's 'inbox-events' consumer AFTER commit, receive ids only, must be
// idempotent (at-least-once) and may only act through the normal domain services (same permission + policy checks).
import type { InboxHookEvent, V35OutboxEvent } from '@social-lite/core/contracts/v35-events';
import { log } from '../log.js';

type Hook = (e: InboxHookEvent) => Promise<void>;
const HOOKS = new Map<V35OutboxEvent, Array<{ name: string; fn: Hook }>>();

export function onInboxEvent(event: V35OutboxEvent, name: string, fn: Hook): void {
  const list = HOOKS.get(event) ?? [];
  if (!list.some((h) => h.name === name)) list.push({ name, fn });
  HOOKS.set(event, list);
}

/** Worker consumer for the 'inbox-events' queue. A failing hook is logged and rethrown (pg-boss retries the job). */
export async function handleInboxEvent(e: { event_type: string; workspace_id: string | null; aggregate_id: string; payload: Record<string, unknown> }): Promise<number> {
  const list = HOOKS.get(e.event_type as V35OutboxEvent) ?? [];
  if (!e.workspace_id || !list.length) return 0;
  const origin = (e.payload.origin as InboxHookEvent['origin'] | undefined) ?? { kind: 'system', id: null };
  for (const h of list) {
    try {
      await h.fn({ name: e.event_type as V35OutboxEvent, workspaceId: e.workspace_id, aggregateId: e.aggregate_id, payload: e.payload, origin });
    } catch (err) {
      log.error('inbox_hook_failed', { hook: h.name, event: e.event_type, err: err as Error });
      throw err;
    }
  }
  return list.length;
}

export function resetInboxHooksForTests(): void { HOOKS.clear(); }
