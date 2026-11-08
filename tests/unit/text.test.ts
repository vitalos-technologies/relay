import { describe, expect, it } from 'vitest';
import { xWeightedLength, codePointLength, utf16Length, validateVariant, type ChannelConstraints } from '@social-lite/core';

describe('platform-aware text counting', () => {
  it('weights X URLs as 23 and CJK as 2', () => {
    expect(xWeightedLength('hi https://example.com/a/very/long/path/that/is/long')).toBe(3 + 23);
    expect(xWeightedLength('日本')).toBe(4);
  });
  it('differs from JS length for emoji', () => {
    const s = '👍🏽';
    expect(utf16Length(s)).toBe(4);
    expect(codePointLength(s)).toBe(2);
  });
});

const ig: ChannelConstraints = {
  maxTextLength: 2200, maxCaptionLength: 2200, textCounting: 'codepoints', requiresMedia: true, supportsTextOnly: false,
  supportsLink: false, supportsButtons: false, maxButtons: 0, maxImages: 1, imageMimes: ['image/jpeg'], maxImageBytes: 8 * 1048576,
  minAspectRatio: 0.8, maxAspectRatio: 1.91, maxHashtags: 30, maxMentions: 20,
};

describe('validateVariant', () => {
  it('blocks Instagram text-only with an exact fix', () => {
    const r = validateVariant({ provider: 'instagram', connectionId: 'c1', constraints: ig, text: 'hello', link: null, buttons: [], media: [] });
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.code).toBe('media_required');
    expect(r.issues[0]!.message).toMatch(/^Instagram: an image is required/);
  });
  it('rejects bad aspect ratios and not-ready media', () => {
    const r = validateVariant({ provider: 'instagram', connectionId: 'c1', constraints: ig, text: 'x', link: null, buttons: [],
      media: [{ assetId: 'a', status: 'ready', mime: 'image/jpeg', bytes: 1000, width: 1000, height: 3000 }] });
    expect(r.issues.map((i) => i.code)).toContain('aspect');
    const p = validateVariant({ provider: 'instagram', connectionId: 'c1', constraints: ig, text: 'x', link: null, buttons: [],
      media: [{ assetId: 'a', status: 'quarantined', mime: null, bytes: null, width: null, height: null }] });
    expect(p.issues.map((i) => i.code)).toContain('media_not_ready');
  });
});
