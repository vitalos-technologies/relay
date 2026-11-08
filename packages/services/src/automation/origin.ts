// Change origin for loop prevention (brief §18). Automation executes its actions inside withOrigin({kind:'automation'}),
// and writeOutbox (outbox.ts) stamps that origin on every event written meanwhile. Hooks receive it as
// InboxHookEvent.origin and the automation engine never reacts to its own (or another rule's) changes.
// The inbox reply service also reads it to mark automated reply attempts.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ChangeOrigin { kind: 'automation' | 'user' | 'provider' | 'system'; id: string | null }

const store = new AsyncLocalStorage<ChangeOrigin>();

export function withOrigin<T>(origin: ChangeOrigin, fn: () => Promise<T>): Promise<T> {
  return store.run(origin, fn);
}

export function currentOrigin(): ChangeOrigin | null {
  return store.getStore() ?? null;
}

export const isAutomated = (): boolean => currentOrigin()?.kind === 'automation';
