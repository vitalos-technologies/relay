// Untrusted video validation and derivative generation (V1.1). Runs ONLY in the worker.
//  - ffprobe / ffmpeg are executed directly (child_process.spawn, argument arrays, never a shell),
//    with a wall-clock timeout (SIGKILL), a stdout/stderr size cap and `-protocol_whitelist file`
//    so a crafted container cannot make ffmpeg open network URLs or other files.
//  - Facts come from ffprobe: container, codecs, duration, dimensions (after rotation), fps, pixel format.
//  - Outputs: a JPEG poster frame (re-encoded by sharp into poster/preview/thumb) and a `video_publish`
//    MP4 that every provider accepts: H.264 High + AAC-LC, yuv420p, 23–60 fps, ≤ 1280×1024 (either
//    orientation), moov atom first, all metadata (GPS, device) stripped. Compatible sources are
//    remuxed (stream copy); everything else is transcoded with a bounded duration and time.
import { spawn, type ChildProcess } from 'node:child_process';

export const FFPROBE_BIN = process.env.FFPROBE_PATH ?? '/usr/bin/ffprobe';
export const FFMPEG_BIN = process.env.FFMPEG_PATH ?? '/usr/bin/ffmpeg';

export const VIDEO_MIME = ['video/mp4', 'video/quicktime'] as const;
export type VideoMime = (typeof VIDEO_MIME)[number];
export const MAX_VIDEO_UPLOAD_BYTES = 300 * 1024 * 1024;
/** Longest accepted source; also bounds transcode work (`-t`). */
export const MAX_VIDEO_SECONDS = 15 * 60;
export const MIN_VIDEO_SECONDS = 0.5;
export const MAX_VIDEO_SIDE = 8192;
export const MIN_VIDEO_SIDE = 16;
/** Publish derivative envelope (fits X 1280×1024, Instagram ≤1920 columns, Telegram, Facebook). */
export const PUBLISH_LONG_SIDE = 1280;
export const PUBLISH_SHORT_SIDE = 1024;
export const PUBLISH_MIN_FPS = 23;
export const PUBLISH_MAX_FPS = 60;
export const PUBLISH_MAX_BITRATE = 25_000_000;
export const PROBE_TIMEOUT_MS = 20_000;
export const POSTER_TIMEOUT_MS = 30_000;

/** Codecs ffmpeg can decode that we accept as sources (transcoded unless already H.264). */
const DECODABLE_VIDEO = new Set(['h264', 'hevc', 'mpeg4', 'vp9', 'vp8', 'av1', 'prores', 'mjpeg']);
const DECODABLE_AUDIO = new Set(['aac', 'mp3', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'opus', 'ac3', 'eac3', 'flac']);

export class ToolError extends Error {
  constructor(message: string, readonly kind: 'timeout' | 'exit' | 'spawn' | 'output_limit', readonly stderr = '') {
    super(message);
    this.name = 'ToolError';
  }
}

export interface RunResult { stdout: string; stderr: string }

/** Run a binary with an argument array (no shell), a hard timeout and bounded output. */
export function runTool(bin: string, args: string[], opts: { timeoutMs: number; maxOutputBytes?: number }): Promise<RunResult> {
  const max = opts.maxOutputBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' } as unknown as NodeJS.ProcessEnv });
    } catch (err) {
      reject(new ToolError(`could not start ${bin}: ${(err as Error).message}`, 'spawn'));
      return;
    }
    const out: Buffer[] = [];
    const errBuf: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new ToolError(`${bin} timed out after ${opts.timeoutMs} ms`, 'timeout')));
    }, opts.timeoutMs);
    const onData = (buf: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        child.kill('SIGKILL');
        finish(() => reject(new ToolError(`${bin} produced too much output`, 'output_limit')));
        return;
      }
      buf.push(chunk);
    };
    child.stdout!.on('data', (c: Buffer) => onData(out, c));
    child.stderr!.on('data', (c: Buffer) => onData(errBuf, c));
    child.on('error', (err) => finish(() => reject(new ToolError(`could not start ${bin}: ${err.message}`, 'spawn'))));
    child.on('close', (code, signal) => {
      const stderr = Buffer.concat(errBuf).toString('utf8').slice(0, 4000);
      if (code === 0) finish(() => resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr }));
      else finish(() => reject(new ToolError(`${bin} exited with ${code ?? signal}`, 'exit', stderr)));
    });
  });
}

/** Inputs are always local files opened through the file: protocol only. */
const input = (path: string) => ['-protocol_whitelist', 'file', '-i', `file:${path}`];

// ------------------------------------------------------------------ probe

interface ProbeStream {
  index?: number; codec_type?: string; codec_name?: string; profile?: string; width?: number; height?: number; pix_fmt?: string;
  avg_frame_rate?: string; r_frame_rate?: string; duration?: string; channels?: number; sample_rate?: string; bit_rate?: string;
  disposition?: { attached_pic?: number }; tags?: Record<string, string>; side_data_list?: Array<{ rotation?: number | string }>;
}
interface ProbeJson { streams?: ProbeStream[]; format?: { format_name?: string; duration?: string; bit_rate?: string; size?: string } }

export interface VideoFacts {
  container: string;
  videoCodec: string;
  videoProfile: string | null;
  audioCodec: string | null;
  audioProfile: string | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
  /** Coded size. */
  codedWidth: number;
  codedHeight: number;
  /** Displayed size (after rotation). */
  width: number;
  height: number;
  rotation: number;
  durationMs: number;
  frameRate: number | null;
  pixelFormat: string | null;
  bitRate: number | null;
}

export type ProbeOutcome = { ok: true; facts: VideoFacts } | { ok: false; code: string; reason: string };

function rate(s: string | undefined): number | null {
  if (!s) return null;
  const [n, d] = s.split('/').map(Number);
  if (!Number.isFinite(n) || !n) return null;
  const v = d ? n! / d : n!;
  return Number.isFinite(v) && v > 0 && v < 1000 ? Math.round(v * 1000) / 1000 : null;
}

function rotationOf(s: ProbeStream): number {
  const side = s.side_data_list?.find((x) => x.rotation !== undefined)?.rotation;
  const raw = Number(side ?? s.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
}

/** Turn ffprobe JSON into facts, or a user-facing rejection. Pure (unit-testable). */
export function analyzeProbe(json: ProbeJson): ProbeOutcome {
  const fmt = json.format?.format_name ?? '';
  if (!/(^|,)(mov|mp4)(,|$)/.test(fmt)) return { ok: false, code: 'unsupported_type', reason: 'Only MP4 and MOV videos are supported.' };
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v || !v.codec_name) return { ok: false, code: 'no_video_stream', reason: 'The file has no video track.' };
  if (!DECODABLE_VIDEO.has(v.codec_name)) {
    return { ok: false, code: 'unsupported_codec', reason: `The video codec (${v.codec_name}) is not supported. Export the video as H.264 MP4 and upload it again.` };
  }
  const a = streams.find((s) => s.codec_type === 'audio');
  if (a?.codec_name && !DECODABLE_AUDIO.has(a.codec_name)) {
    return { ok: false, code: 'unsupported_codec', reason: `The audio codec (${a.codec_name}) is not supported. Export the video with AAC audio and upload it again.` };
  }
  const w = Number(v.width);
  const h = Number(v.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return { ok: false, code: 'malformed', reason: 'The video could not be read. It may be corrupted.' };
  if (w > MAX_VIDEO_SIDE || h > MAX_VIDEO_SIDE) return { ok: false, code: 'dimensions_too_large', reason: `The video is too large (${w}×${h}). The maximum is ${MAX_VIDEO_SIDE}px per side.` };
  if (w < MIN_VIDEO_SIDE || h < MIN_VIDEO_SIDE) return { ok: false, code: 'dimensions_too_small', reason: `The video is too small (${w}×${h}). The minimum is ${MIN_VIDEO_SIDE}px per side.` };
  const dur = Number(json.format?.duration ?? v.duration);
  if (!Number.isFinite(dur) || dur <= 0) return { ok: false, code: 'malformed', reason: 'The video has no readable duration. It may be corrupted.' };
  if (dur < MIN_VIDEO_SECONDS) return { ok: false, code: 'too_short', reason: `The video is too short (${dur.toFixed(2)} s). The minimum is ${MIN_VIDEO_SECONDS} s.` };
  if (dur > MAX_VIDEO_SECONDS) return { ok: false, code: 'too_long', reason: `The video is ${Math.round(dur / 60)} minutes long. The maximum is ${MAX_VIDEO_SECONDS / 60} minutes.` };
  const rotation = rotationOf(v);
  const swap = rotation === 90 || rotation === 270;
  const container = /(^|,)mp4(,|$)/.test(fmt) && !/qt|mov/i.test(v.tags?.major_brand ?? '') ? 'mp4' : 'mov';
  return {
    ok: true,
    facts: {
      container, videoCodec: v.codec_name, videoProfile: v.profile ?? null,
      audioCodec: a?.codec_name ?? null, audioProfile: a?.profile ?? null, audioChannels: a?.channels ?? null,
      audioSampleRate: a?.sample_rate ? Number(a.sample_rate) || null : null,
      codedWidth: w, codedHeight: h, width: swap ? h : w, height: swap ? w : h, rotation,
      durationMs: Math.round(dur * 1000),
      frameRate: rate(v.avg_frame_rate) ?? rate(v.r_frame_rate),
      pixelFormat: v.pix_fmt ?? null,
      bitRate: Number(json.format?.bit_rate) || null,
    },
  };
}

export async function probeVideo(path: string): Promise<ProbeOutcome> {
  let r: RunResult;
  try {
    r = await runTool(FFPROBE_BIN, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...input(path)], { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 });
  } catch (err) {
    if (err instanceof ToolError && err.kind === 'timeout') return { ok: false, code: 'probe_timeout', reason: 'The video took too long to analyse. It may be corrupted; export it again and retry.' };
    return { ok: false, code: 'malformed', reason: 'The video could not be read. It may be corrupted or not a real video.' };
  }
  try {
    return analyzeProbe(JSON.parse(r.stdout) as ProbeJson);
  } catch {
    return { ok: false, code: 'malformed', reason: 'The video could not be read. It may be corrupted or not a real video.' };
  }
}

// ------------------------------------------------------------------ compatibility + derivative plan

/** Already provider-compatible: can be remuxed (stream copy) instead of transcoded. */
export function isPublishCompatible(f: VideoFacts): boolean {
  const fpsOk = f.frameRate !== null && f.frameRate >= PUBLISH_MIN_FPS - 0.01 && f.frameRate <= PUBLISH_MAX_FPS + 0.01;
  const long = Math.max(f.width, f.height);
  const short = Math.min(f.width, f.height);
  const audioOk = f.audioCodec === null || (f.audioCodec === 'aac' && (f.audioProfile ?? 'LC') === 'LC' && (f.audioChannels ?? 2) <= 2 && (f.audioSampleRate ?? 48000) <= 48000);
  return f.videoCodec === 'h264' && f.pixelFormat === 'yuv420p' && f.rotation === 0 && fpsOk && audioOk
    && long <= PUBLISH_LONG_SIDE && short <= PUBLISH_SHORT_SIDE && f.width % 2 === 0 && f.height % 2 === 0
    && (f.bitRate === null || f.bitRate <= PUBLISH_MAX_BITRATE);
}

/** Output size for a transcode: fits the publish envelope, keeps aspect, even dimensions, never upscales. */
export function targetSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const s = Math.min(1, PUBLISH_LONG_SIDE / long, PUBLISH_SHORT_SIDE / short);
  const even = (n: number) => Math.max(2, Math.floor((n * s) / 2) * 2);
  return { width: even(width), height: even(height) };
}

export function targetFps(fps: number | null): number | null {
  if (fps === null) return 30;
  if (fps > PUBLISH_MAX_FPS) return PUBLISH_MAX_FPS;
  if (fps < PUBLISH_MIN_FPS) return 30;
  return null; // keep
}

/** ffmpeg arguments for the transcode (exported for tests). */
export function transcodeArgs(src: string, dst: string, f: VideoFacts): string[] {
  const size = targetSize(f.width, f.height);
  const fps = targetFps(f.frameRate);
  const filters = [`scale=${size.width}:${size.height}:flags=bicubic`, ...(fps ? [`fps=${fps}`] : []), 'format=yuv420p', 'setsar=1'];
  return [
    '-nostdin', '-hide_banner', '-v', 'error', '-y', ...input(src),
    '-map', '0:v:0', '-map', '0:a:0?', '-t', String(MAX_VIDEO_SECONDS),
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-crf', '23', '-maxrate', '8M', '-bufsize', '16M',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', `file:${dst}`,
  ];
}

export function remuxArgs(src: string, dst: string): string[] {
  return [
    '-nostdin', '-hide_banner', '-v', 'error', '-y', ...input(src),
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', `file:${dst}`,
  ];
}

/** Transcode budget: generous for the duration, hard-capped. */
export function transcodeTimeoutMs(durationMs: number): number {
  return Math.min(30 * 60_000, Math.max(120_000, durationMs * 3 + 60_000));
}

export async function makePublishVideo(src: string, dst: string, f: VideoFacts): Promise<{ transcoded: boolean }> {
  if (isPublishCompatible(f)) {
    try {
      await runTool(FFMPEG_BIN, remuxArgs(src, dst), { timeoutMs: 120_000 });
      return { transcoded: false };
    } catch { /* fall back to a full transcode (e.g. edit lists the muxer refuses) */ }
  }
  await runTool(FFMPEG_BIN, transcodeArgs(src, dst, f), { timeoutMs: transcodeTimeoutMs(f.durationMs) });
  return { transcoded: true };
}

/** Extract one frame as JPEG (autorotated) for the poster/preview/thumb derivatives. */
export async function extractPoster(src: string, dst: string, f: VideoFacts): Promise<void> {
  const at = Math.min(1, f.durationMs / 2000);
  await runTool(FFMPEG_BIN, [
    '-nostdin', '-hide_banner', '-v', 'error', '-y', '-ss', at.toFixed(3), ...input(src),
    '-frames:v', '1', '-vf', 'scale=w=min(1920\\,iw):h=-2', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', `file:${dst}`,
  ], { timeoutMs: POSTER_TIMEOUT_MS });
}
