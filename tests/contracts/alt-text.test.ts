// Fix H3 (2026-11-09): library alt text (PublishMedia.altText) reaches every network whose API has a field for it, and
// never one that has none. Exact outgoing requests against the provider simulators. No network.
import { describe, expect, it } from 'vitest';
import { ALT_TEXT_SUPPORT, altTextFor, cleanAltText, validateVariant, type Checkpoint, type HttpRequest, type PublishConnection, type PublishInput, type PublishingAdapter } from '@social-lite/core';
import { facebookAdapter, instagramAdapter, metaFake } from '../../packages/providers/src/meta/index.js';
import { threadsAdapter, threadsFake } from '../../packages/providers/src/threads/index.js';
import { xAdapter, xFake } from '../../packages/providers/src/x/index.js';
import { linkedinAdapter, linkedinFake } from '../../packages/providers/src/linkedin/index.js';
import { FAKE_PDS, blueskyAdapter, blueskyFake } from '../../packages/providers/src/bluesky/index.js';
import { PINTEREST_CONSTRAINTS, pinterestAdapter, pinterestFake } from '../../packages/providers/src/pinterest/index.js';
import { INSTAGRAM_CONSTRAINTS } from '../../packages/providers/src/meta/common.js';
import { NOW, image, inputOf, prepareUntilReady, simulated, video } from './v3-helpers.js';

const ALT = 'Barista pouring latte art into a white cup';
const mock = { kind: 'mock' as const, token: 'tok' };
const conn = (provider: PublishConnection['provider'], providerAccountId: string, metadata: Record<string, unknown> = {}): PublishConnection =>
  ({ id: `c-${provider}`, provider, providerAccountId, displayName: 'Sim', username: 'sim', isMock: true, metadata });
const params = (r: HttpRequest) => new URLSearchParams(typeof r.body === 'string' ? r.body : new URL(r.url).search);
const pathOf = (r: HttpRequest) => new URL(r.url).pathname;

async function run(adapter: PublishingAdapter, s: ReturnType<typeof simulated>, inp: PublishInput): Promise<void> {
  const { checkpoint } = await prepareUntilReady(adapter, s.ctx, s.clock, inp, null, 30);
  const out = await adapter.publish(s.ctx, inp, checkpoint);
  expect(['confirmed', 'processing']).toContain(out.kind);
}

describe('core altTextFor / fitAltText', () => {
  it('support matrix: sent to Facebook, Instagram, Threads, X, LinkedIn, Bluesky, Pinterest; never Telegram, TikTok, YouTube', () => {
    const m = { altText: ALT, kind: 'image' as const };
    for (const p of ['facebook', 'instagram', 'threads', 'x', 'linkedin', 'bluesky', 'pinterest'] as const) expect(altTextFor(p, m)).toBe(ALT);
    for (const p of ['telegram', 'tiktok', 'youtube'] as const) expect(altTextFor(p, m)).toBeNull();
  });
  it('videos: only Threads takes alt text on a video', () => {
    const v = { altText: ALT, kind: 'video' as const };
    expect((Object.keys(ALT_TEXT_SUPPORT) as Array<keyof typeof ALT_TEXT_SUPPORT>).filter((p) => altTextFor(p, v) !== null)).toEqual(['threads']);
    expect(altTextFor('instagram', { altText: ALT, mime: 'video/mp4' })).toBeNull();
  });
  it('override wins when non-empty; blank / missing alt text ⇒ null; whitespace collapsed; never shortened', () => {
    expect(altTextFor('pinterest', { altText: ALT }, 'Custom')).toBe('Custom');
    expect(altTextFor('pinterest', { altText: ALT }, '  ')).toBe(ALT);
    expect(altTextFor('x', { altText: '   ' })).toBeNull();
    expect(altTextFor('x', {})).toBeNull();
    expect(cleanAltText(' a\n\n b ')).toBe('a b');
    const long = 'w'.repeat(700);
    expect(altTextFor('pinterest', { altText: long })).toBe(long);
  });

  it('too long for the network ⇒ a validation issue (composer + send-time check), never a silent cut', () => {
    const v = (provider: 'instagram' | 'pinterest' | 'linkedin', constraints: typeof INSTAGRAM_CONSTRAINTS, alts: string[], options: Record<string, unknown> = {}) => validateVariant({
      provider, connectionId: 'c', constraints, text: 'Hi', link: null, buttons: [], options,
      media: alts.map((altText, i) => ({ assetId: `a${i}`, status: 'ready' as const, mime: 'image/jpeg', bytes: 10, width: 1080, height: 1080, kind: 'image' as const, altText })),
    });
    const ig = v('instagram', INSTAGRAM_CONSTRAINTS, ['ok', 'x'.repeat(1001)]);
    expect(ig.issues).toEqual([expect.objectContaining({ field: 'media', code: 'alt_text_too_long', message: 'Instagram: alt text of item 2 is 1001 of 1000 characters. Shorten it in the library.' })]);
    expect(v('instagram', INSTAGRAM_CONSTRAINTS, ['x'.repeat(1000)]).ok).toBe(true);
    expect(v('pinterest', PINTEREST_CONSTRAINTS, ['x'.repeat(501)]).issues.map((i) => i.code)).toEqual(['alt_text_too_long']);
    // Pinterest sends one alt text per Pin: only the first image counts, and a Pinterest "Alt text" option replaces it.
    expect(v('pinterest', PINTEREST_CONSTRAINTS, ['short', 'x'.repeat(900)]).ok).toBe(true);
    expect(v('pinterest', PINTEREST_CONSTRAINTS, ['x'.repeat(501)], { pinterest: { altText: 'Typed' } }).ok).toBe(true);
    expect(v('linkedin', INSTAGRAM_CONSTRAINTS, ['x'.repeat(1500)]).issues.some((i) => i.code === 'alt_text_too_long')).toBe(false);
  });
});

describe('Meta', () => {
  it('Facebook single photo: alt_text_custom on POST /{page}/photos; absent without alt text', async () => {
    const s = simulated(metaFake, 'facebook', 'mock_page1');
    await run(facebookAdapter, s, inputOf(conn('facebook', 'mock_page1'), { kind: 'meta_page', pageAccessToken: 'P', userAccessToken: 'u', userTokenExpiresAt: null }, {}, [image(1, { altText: ALT })]));
    const photo = s.state.calls.find((r) => pathOf(r).endsWith('/mock_page1/photos'))!;
    expect(params(photo).get('alt_text_custom')).toBe(ALT);
    const s2 = simulated(metaFake, 'facebook', 'mock_page1');
    await run(facebookAdapter, s2, inputOf(conn('facebook', 'mock_page1'), { kind: 'meta_page', pageAccessToken: 'P', userAccessToken: 'u', userTokenExpiresAt: null }, {}, [image(1)]));
    expect(params(s2.state.calls.find((r) => pathOf(r).endsWith('/photos'))!).has('alt_text_custom')).toBe(false);
  });

  it('Facebook multi-photo: each unpublished staged photo carries its own alt_text_custom', async () => {
    const s = simulated(metaFake, 'facebook', 'mock_page1');
    await run(facebookAdapter, s, inputOf(conn('facebook', 'mock_page1'), { kind: 'meta_page', pageAccessToken: 'P', userAccessToken: 'u', userTokenExpiresAt: null }, {}, [image(1, { altText: 'One' }), image(2), image(3, { altText: 'Three' })]));
    const staged = s.state.calls.filter((r) => pathOf(r).endsWith('/photos')).map((r) => params(r).get('alt_text_custom'));
    expect(staged).toEqual(['One', null, 'Three']);
  });

  it('Instagram: alt_text on a single image container and on carousel image children; never on Reels', async () => {
    const creds = { kind: 'meta_page' as const, pageAccessToken: 'P', userAccessToken: 'u', userTokenExpiresAt: null };
    const s = simulated(metaFake, 'instagram', 'mock_ig1');
    await run(instagramAdapter, s, inputOf(conn('instagram', 'mock_ig1'), creds, {}, [image(1, { altText: ALT })]));
    expect(params(s.state.calls.find((r) => pathOf(r).endsWith('/mock_ig1/media'))!).get('alt_text')).toBe(ALT);

    const c = simulated(metaFake, 'instagram', 'mock_ig1');
    await run(instagramAdapter, c, inputOf(conn('instagram', 'mock_ig1'), creds, {}, [image(1, { altText: 'First' }), image(2, { altText: 'Second' })]));
    const children = c.state.calls.filter((r) => pathOf(r).endsWith('/mock_ig1/media') && params(r).get('is_carousel_item') === 'true');
    expect(children.map((r) => params(r).get('alt_text'))).toEqual(['First', 'Second']);
    expect(params(c.state.calls.find((r) => params(r).get('media_type') === 'CAROUSEL')!).has('alt_text')).toBe(false);

    const r = simulated(metaFake, 'instagram', 'mock_ig1');
    await run(instagramAdapter, r, inputOf(conn('instagram', 'mock_ig1'), creds, { format: 'reel' }, [video(5000, { altText: ALT, posterUrl: 'https://storage.example/p.jpg' })]));
    expect(params(r.state.calls.find((x) => params(x).get('media_type') === 'REELS')!).has('alt_text')).toBe(false);
  });
});

describe('Threads, X, LinkedIn, Bluesky, Pinterest', () => {
  it('Threads: alt_text on the image container', async () => {
    const s = simulated(threadsFake, 'threads', 'mock_th_1');
    await run(threadsAdapter, s, inputOf(conn('threads', 'mock_th_1'), mock, {}, [image(1, { altText: ALT })]));
    const create = s.state.calls.find((r) => r.method === 'POST' && pathOf(r).endsWith('/mock_th_1/threads'))!;
    expect(params(create).get('alt_text')).toBe(ALT);
  });

  it('X single image: POST /2/media/metadata after the upload, before /2/tweets; a ready checkpoint never repeats it', async () => {
    const s = simulated(xFake, 'x', 'mock_x_user');
    const inp = inputOf(conn('x', 'mock_x_user'), mock, {}, [image(1, { altText: ALT })]);
    const { checkpoint } = await prepareUntilReady(xAdapter, s.ctx, s.clock, inp);
    const ops = s.state.calls.map((r) => pathOf(r));
    expect(ops).toEqual(['/2/media/upload', '/2/media/metadata']);
    const meta = JSON.parse(s.state.calls[1]!.body as string);
    expect(meta).toEqual({ id: checkpoint.data.mediaId, metadata: { alt_text: { text: ALT } } });
    expect(checkpoint.data.altSet).toBe(true);
    const again = await xAdapter.prepare(s.ctx, inp, checkpoint);
    expect(again.kind).toBe('ready');
    expect(s.state.calls).toHaveLength(2);
    expect((await xAdapter.publish(s.ctx, inp, checkpoint)).kind).toBe('confirmed');
  });

  it('X: no alt text ⇒ no metadata call (it is billable); multi-image ⇒ one call per described image, recorded per item', async () => {
    const s = simulated(xFake, 'x', 'mock_x_user');
    await prepareUntilReady(xAdapter, s.ctx, s.clock, inputOf(conn('x', 'mock_x_user'), mock, {}, [image(1)]));
    expect(s.state.calls.some((r) => pathOf(r) === '/2/media/metadata')).toBe(false);
    const m = simulated(xFake, 'x', 'mock_x_user');
    const { checkpoint } = await prepareUntilReady(xAdapter, m.ctx, m.clock, inputOf(conn('x', 'mock_x_user'), mock, {}, [image(1, { altText: 'One' }), image(2), image(3, { altText: 'Three' })]));
    const metas = m.state.calls.filter((r) => pathOf(r) === '/2/media/metadata').map((r) => JSON.parse(r.body as string).metadata.alt_text.text);
    expect(metas).toEqual(['One', 'Three']);
    expect((checkpoint.data.items as Array<{ altSet?: boolean }>).map((i) => i.altSet === true)).toEqual([true, false, true]);
  });

  it('X: a failed metadata call keeps the uploaded media id; the retry repeats only the metadata call', async () => {
    const s = simulated(xFake, 'x', 'mock_x_user');
    s.state.failOn = (r) => pathOf(r) === '/2/media/metadata';
    const inp = inputOf(conn('x', 'mock_x_user'), mock, {}, [image(1, { altText: ALT })]);
    const first = await xAdapter.prepare(s.ctx, inp, null);
    expect(first).toMatchObject({ kind: 'retryable', checkpoint: { step: 'media_ready' } });
    const second = await xAdapter.prepare(s.ctx, inp, (first as { checkpoint: Checkpoint }).checkpoint);
    expect(second.kind).toBe('ready');
    expect(s.state.calls.map((r) => pathOf(r))).toEqual(['/2/media/upload', '/2/media/metadata', '/2/media/metadata']);
  });

  it('LinkedIn: library alt text on each image; a per-post altTexts override still wins', async () => {
    const s = simulated(linkedinFake, 'linkedin', 'mock_li_member');
    const c = conn('linkedin', 'mock_li_member', { account_type: 'member', granted_scopes: ['openid', 'profile', 'w_member_social'] });
    await run(linkedinAdapter, s, inputOf(c, mock, { options: { linkedin: { altTexts: ['', 'Override'] } } }, [image(1, { altText: 'Library one' }), image(2, { altText: 'Library two' })]));
    const body = JSON.parse(s.state.calls.at(-1)!.body as string);
    expect(body.content.multiImage.images.map((i: { altText?: string }) => i.altText)).toEqual(['Library one', 'Override']);
  });

  it('Bluesky: the required `alt` carries the library alt text ("" when there is none)', async () => {
    const s = simulated(blueskyFake, 'bluesky', 'did:plc:abc');
    const creds = { kind: 'atproto_app_password' as const, identifier: 'me.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop', did: 'did:plc:abc', service: 'https://bsky.social', pdsUrl: FAKE_PDS,
      accessJwt: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(NOW.getTime() / 1000) + 7200 })).toString('base64url')}.sig`, refreshJwt: 'r', accessExpiresAt: new Date(NOW.getTime() + 7200_000).toISOString() };
    await run(blueskyAdapter, s, inputOf({ ...conn('bluesky', 'did:plc:abc'), isMock: false }, creds, { text: 'Hi' }, [image(1, { altText: ALT }), image(2)]));
    const rec = JSON.parse(s.state.calls.at(-1)!.body as string).record;
    expect(rec.embed.images.map((i: { alt: string }) => i.alt)).toEqual([ALT, '']);
  });

  it('Pinterest: the Pin alt_text is the Pinterest option, else the first image\'s library alt text; too long ⇒ nothing sent', async () => {
    const a = simulated(pinterestFake, 'pinterest', 'mock_board_1');
    await run(pinterestAdapter, a, inputOf(conn('pinterest', 'mock_board_1'), mock, {}, [image(1, { altText: ALT })]));
    expect(JSON.parse(a.state.calls.find((r) => pathOf(r) === '/v5/pins' && r.method === 'POST')!.body as string).alt_text).toBe(ALT);
    const b = simulated(pinterestFake, 'pinterest', 'mock_board_1');
    await run(pinterestAdapter, b, inputOf(conn('pinterest', 'mock_board_1'), mock, { options: { pinterest: { altText: 'Typed for Pinterest' } } }, [image(1, { altText: ALT })]));
    expect(JSON.parse(b.state.calls.find((r) => pathOf(r) === '/v5/pins' && r.method === 'POST')!.body as string).alt_text).toBe('Typed for Pinterest');
    const c = simulated(pinterestFake, 'pinterest', 'mock_board_1');
    const tooLong = inputOf(conn('pinterest', 'mock_board_1'), mock, {}, [image(1, { altText: 'w'.repeat(600) })]);
    expect(pinterestAdapter.validate(tooLong).issues.map((i) => i.code)).toEqual(['alt_text_too_long']);
    expect(await pinterestAdapter.prepare(c.ctx, tooLong, null)).toMatchObject({ kind: 'permanent', code: 'invalid_content' });
    expect(c.state.calls.some((r) => pathOf(r) === '/v5/pins')).toBe(false);
  });
});

