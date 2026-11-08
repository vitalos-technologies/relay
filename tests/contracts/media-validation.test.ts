// V1.1 core media rules: format derivation, per-destination video/album validation, and the pure parts
// of the video pipeline (probe analysis, compatibility, transcode sizing). No network, no binaries.
import { describe, expect, it } from 'vitest';
import { deriveFormat, mediaKindOf, resolveVariants, validateVariant, type ChannelConstraints, type MediaFacts } from '@social-lite/core';
import { analyzeProbe, isPublishCompatible, remuxArgs, targetFps, targetSize, transcodeArgs, transcodeTimeoutMs } from '../../packages/services/src/media/video.js';

const base: ChannelConstraints = {
  maxTextLength: 1000, maxCaptionLength: 1000, textCounting: 'codepoints', requiresMedia: false, supportsTextOnly: true, supportsLink: true,
  supportsButtons: true, maxButtons: 3, maxImages: 1, imageMimes: ['image/jpeg'], maxImageBytes: 5 << 20,
};
const image = (id = 'i'): MediaFacts => ({ assetId: id, status: 'ready', mime: 'image/jpeg', bytes: 1000, width: 1000, height: 1000 });
const video = (over: Partial<MediaFacts> = {}): MediaFacts => ({ assetId: 'v', status: 'ready', mime: 'video/mp4', bytes: 1000, width: 720, height: 1280, kind: 'video', durationMs: 10_000, videoCodec: 'h264', audioCodec: 'aac', frameRate: 30, ...over });
const check = (c: Partial<ChannelConstraints>, media: MediaFacts[], buttons = 0) => validateVariant({
  provider: 'telegram', connectionId: 'c', constraints: { ...base, ...c }, text: 'hi', link: null, media,
  buttons: Array.from({ length: buttons }, (_, i) => ({ text: `b${i}`, url: 'https://example.com' })),
});

describe('format derivation', () => {
  it('derives text / image / album / video / reel from media kinds', () => {
    expect(deriveFormat('x', [])).toBe('text');
    expect(deriveFormat('x', ['image'])).toBe('image');
    expect(deriveFormat('x', ['image', 'image'])).toBe('album');
    expect(deriveFormat('facebook', ['video'])).toBe('video');
    expect(deriveFormat('instagram', ['video'])).toBe('reel');
    expect(deriveFormat('instagram', ['image', 'video'])).toBe('album');
    expect(mediaKindOf({ mime: 'video/quicktime' })).toBe('video');
    expect(mediaKindOf({ mime: 'image/png' })).toBe('image');
  });

  it('resolveVariants is backwards compatible and uses asset kinds when given', () => {
    const draft = { baseText: 't', baseLink: null, baseAssetIds: ['v1'], variants: [{ connectionId: 'ig', inheritText: true, inheritMedia: true }, { connectionId: 'fb', inheritText: true, inheritMedia: true }] };
    const conns = [{ id: 'ig', provider: 'instagram' as const }, { id: 'fb', provider: 'facebook' as const }];
    expect(resolveVariants(draft, conns).map((v) => v.format)).toEqual(['image', 'image']);
    expect(resolveVariants(draft, conns, new Map([['v1', 'video' as const]])).map((v) => v.format)).toEqual(['reel', 'video']);
    expect(resolveVariants(draft, conns, { v1: 'video' }).map((v) => v.format)).toEqual(['reel', 'video']);
  });
});

describe('validateVariant: videos and albums', () => {
  it('video is refused where unsupported (once, with an exact fix)', () => {
    const r = check({}, [video()]);
    expect(r.issues.map((i) => [i.code, i.message])).toEqual([['video_unsupported', 'Telegram: videos are not supported for this destination. Remove the video or deselect it.']]);
  });

  it('checks duration, size, codecs, fps, aspect and dimensions with exact messages', () => {
    const c: Partial<ChannelConstraints> = { maxVideos: 1, maxVideoBytes: 1000, minVideoSeconds: 3, maxVideoSeconds: 60, videoCodecs: ['h264'], audioCodecs: ['aac'], maxFrameRate: 60, minFrameRate: 23, minVideoAspectRatio: 0.5, maxVideoAspectRatio: 2, maxVideoLongSide: 1280, maxVideoShortSide: 1024, videoMimes: ['video/mp4'] };
    expect(check(c, [video()]).ok).toBe(true);
    const msg = (m: Partial<MediaFacts>) => check(c, [video(m)]).issues.map((i) => i.message);
    expect(msg({ durationMs: 2000 })).toEqual(['Telegram: video is 2 s long; at least 3 s is required.']);
    expect(msg({ durationMs: 95_000 })).toEqual(['Telegram: video is 1 min 35 s long; the limit is 1 min. Trim it.']);
    expect(msg({ bytes: 3 * 1_048_576 })).toEqual(['Telegram: video is 3.0 MB; the limit is 0 MB.']);
    expect(msg({ videoCodec: 'hevc' })).toEqual(['Telegram: video codec hevc is not accepted (allowed: h264).']);
    expect(msg({ audioCodec: 'opus' })).toEqual(['Telegram: audio codec opus is not accepted (allowed: aac).']);
    expect(msg({ audioCodec: null })).toEqual([]);
    expect(msg({ frameRate: 120 })).toEqual(['Telegram: video is 120 fps; at most 60 fps.']);
    expect(msg({ width: 100, height: 1000 })).toEqual(['Telegram: video aspect ratio 0.10 is too tall (minimum 0.50). Crop it.']);
    expect(msg({ width: 1920, height: 1080 })).toEqual(['Telegram: video is 1920×1080; at most 1280×1024 (either orientation).']);
    expect(msg({ mime: 'video/webm' })).toEqual(['Telegram: video/webm videos are not accepted (allowed: video/mp4).']);
    expect(msg({ status: 'quarantined' })).toEqual(['Telegram: an attached video is still processing. Wait for it to finish.']);
  });

  it('albums: item limits, minimum, mixed media and buttons', () => {
    const album: Partial<ChannelConstraints> = { maxImages: 4, maxAlbumItems: 4, minAlbumItems: 2, maxVideos: 1, albumAllowsVideo: false, albumSupportsButtons: false };
    expect(check(album, [image('a'), image('b')]).ok).toBe(true);
    expect(check(album, [image('a'), image('b')], 1).issues.map((i) => i.code)).toEqual(['album_buttons_unsupported']);
    expect(check(album, [image('a'), image('b'), image('c'), image('d'), image('e')]).issues.map((i) => i.code)).toEqual(['too_many_images']);
    expect(check(album, [image('a'), video()]).issues.map((i) => i.code)).toEqual(['mixed_media_unsupported']);
    expect(check({ ...album, albumAllowsVideo: true }, [image('a'), video()]).ok).toBe(true);
    expect(check({ ...album, albumAllowsVideo: true, maxAlbumItems: 2 }, [image('a'), image('b'), video()]).issues.map((i) => i.code)).toEqual(['too_many_items']);
    expect(check({ ...album }, [video(), { ...video(), assetId: 'v2' }]).issues.map((i) => i.code)).toEqual(['mixed_media_unsupported']);
    // Existing single-image destinations keep their exact message.
    expect(check({}, [image('a'), image('b')]).issues.map((i) => i.message)).toEqual(['Telegram: at most 1 image per post in this release. Remove 1.']);
  });
});

describe('video pipeline (pure parts)', () => {
  const probe = (over: Record<string, unknown> = {}, v: Record<string, unknown> = {}, a: Record<string, unknown> | null = {}) => ({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.5', bit_rate: '4000000', ...over },
    streams: [
      { codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1280, height: 720, pix_fmt: 'yuv420p', avg_frame_rate: '30000/1001', ...v },
      ...(a ? [{ codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 2, sample_rate: '48000', ...a }] : []),
    ],
  });

  it('analyses ffprobe output into facts (rotation swaps displayed size)', () => {
    const r = analyzeProbe(probe({}, { side_data_list: [{ rotation: -90 }] }));
    expect(r).toMatchObject({ ok: true, facts: { width: 720, height: 1280, codedWidth: 1280, rotation: 270, durationMs: 12_500, frameRate: 29.97, videoCodec: 'h264', audioCodec: 'aac' } });
  });

  it('rejects non-MP4/MOV, missing video, unsupported codecs, bad durations and sizes with user-facing reasons', () => {
    expect(analyzeProbe(probe({ format_name: 'matroska,webm' }))).toMatchObject({ ok: false, code: 'unsupported_type' });
    expect(analyzeProbe({ format: { format_name: 'mov,mp4', duration: '3' }, streams: [{ codec_type: 'audio', codec_name: 'aac' }] })).toMatchObject({ ok: false, code: 'no_video_stream' });
    expect(analyzeProbe(probe({}, { codec_name: 'rawvideo' }))).toMatchObject({ ok: false, code: 'unsupported_codec', reason: expect.stringContaining('H.264 MP4') });
    expect(analyzeProbe(probe({ duration: '0' }))).toMatchObject({ ok: false, code: 'malformed' });
    expect(analyzeProbe(probe({ duration: '1000' }))).toMatchObject({ ok: false, code: 'too_long', reason: 'The video is 17 minutes long. The maximum is 15 minutes.' });
    expect(analyzeProbe(probe({}, { width: 9000 }))).toMatchObject({ ok: false, code: 'dimensions_too_large' });
  });

  it('decides remux vs transcode and sizes transcodes into the 1280×1024 envelope', () => {
    const ok = (analyzeProbe(probe()) as { facts: Parameters<typeof isPublishCompatible>[0] }).facts;
    expect(isPublishCompatible(ok)).toBe(true);
    expect(isPublishCompatible({ ...ok, videoCodec: 'hevc' })).toBe(false);
    expect(isPublishCompatible({ ...ok, audioCodec: 'mp3' })).toBe(false);
    expect(isPublishCompatible({ ...ok, width: 1920, height: 1080 })).toBe(false);
    expect(isPublishCompatible({ ...ok, rotation: 90 })).toBe(false);
    expect(isPublishCompatible({ ...ok, frameRate: 120 })).toBe(false);
    expect(targetSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(targetSize(1080, 1920)).toEqual({ width: 720, height: 1280 });
    expect(targetSize(1080, 1080)).toEqual({ width: 1024, height: 1024 });
    expect(targetSize(641, 361)).toEqual({ width: 640, height: 360 });
    expect(targetFps(120)).toBe(60);
    expect(targetFps(15)).toBe(30);
    expect(targetFps(30)).toBeNull();
    expect(transcodeTimeoutMs(10_000)).toBe(120_000);
    expect(transcodeTimeoutMs(15 * 60_000)).toBe(30 * 60_000);
  });

  it('ffmpeg argument arrays: file-only protocol, bounded duration, metadata stripped, faststart', () => {
    const f = (analyzeProbe(probe({}, { codec_name: 'hevc', width: 3840, height: 2160 })) as { facts: Parameters<typeof transcodeArgs>[2] }).facts;
    const t = transcodeArgs('/tmp/in', '/tmp/out.mp4', f);
    expect(t.slice(t.indexOf('-protocol_whitelist'), t.indexOf('-protocol_whitelist') + 4)).toEqual(['-protocol_whitelist', 'file', '-i', 'file:/tmp/in']);
    expect(t[t.indexOf('-t') + 1]).toBe('900');
    expect(t[t.indexOf('-vf') + 1]).toBe('scale=1280:720:flags=bicubic,format=yuv420p,setsar=1');
    expect(t).toEqual(expect.arrayContaining(['libx264', 'aac', '-map_metadata', '-1', '+faststart']));
    expect(t.at(-1)).toBe('file:/tmp/out.mp4');
    const r = remuxArgs('/tmp/in', '/tmp/out.mp4');
    expect(r).toEqual(expect.arrayContaining(['-c', 'copy', '-map_metadata', '-1', '+faststart']));
  });
});
