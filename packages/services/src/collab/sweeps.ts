// Collaboration worker sweeps (workload class 'notifications'; never on the publishing queue): bounded task reminders,
// overdue reviews, offboarding (tasks whose assignee lost access), presence purge and change-feed retention.
import { getPool, type Queryable } from '@social-lite/db';
import { log } from '../log.js';
import { runOffboardingSweep, runTaskReminders } from './tasks.js';
import { runReviewOverdue } from './reviewers.js';
import { purgePresence } from './presence.js';
import { pruneCollabEvents } from './events.js';

export async function runCollabSweeps(db: Queryable = getPool()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, fn] of [
    ['reminders', () => runTaskReminders(db)],
    ['review_overdue', () => runReviewOverdue(db)],
    ['offboarding', () => runOffboardingSweep(db)],
    ['presence', () => purgePresence(db)],
  ] as const) {
    try { out[name] = await fn(); } catch (err) { log.warn('collab_sweep_failed', { sweep: name, err: err as Error }); }
  }
  return out;
}

export async function runCollabRetention(db: Queryable = getPool()): Promise<number> {
  return pruneCollabEvents(db);
}
