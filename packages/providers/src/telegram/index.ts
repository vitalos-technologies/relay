// OWNED BY: Telegram/X provider workstream. Placeholder until implemented.
import type { PublishingAdapter, TelegramConnector } from '@social-lite/core';
import type { FakeHandler } from '../transport/mock.js';
const todo = (): never => { throw new Error('telegram adapter not implemented yet'); };
export const telegramAdapter = new Proxy({ provider: 'telegram' }, { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : todo) }) as unknown as PublishingAdapter;
export const telegramConnector = null as unknown as TelegramConnector;
export const telegramFake: FakeHandler = async () => todo();
