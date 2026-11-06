// OWNED BY: Meta provider workstream. Placeholder until implemented.
import type { OAuthConnector, PublishingAdapter } from '@social-lite/core';
import type { FakeHandler } from '../transport/mock.js';
const todo = (): never => { throw new Error('meta adapter not implemented yet'); };
export const facebookAdapter = new Proxy({ provider: 'facebook' }, { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : todo) }) as unknown as PublishingAdapter;
export const instagramAdapter = new Proxy({ provider: 'instagram' }, { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : todo) }) as unknown as PublishingAdapter;
export const facebookConnector = null as unknown as OAuthConnector;
export const instagramConnector = null as unknown as OAuthConnector;
export const metaFake: FakeHandler = async () => todo();
