// OWNED BY: Telegram/X provider workstream. Placeholder until implemented.
import type { OAuthConnector, PublishingAdapter } from '@social-lite/core';
import type { FakeHandler } from '../transport/mock.js';
const todo = (): never => { throw new Error('x adapter not implemented yet'); };
export const xAdapter = new Proxy({ provider: 'x' }, { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : todo) }) as unknown as PublishingAdapter;
export const xConnector = null as unknown as OAuthConnector;
export const xFake: FakeHandler = async () => todo();
