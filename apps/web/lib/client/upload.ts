import { ApiError, api } from './api';
import type { Asset, UploadIntent } from './types';

export type UploadPhase = 'queued' | 'requesting' | 'uploading' | 'validating' | 'ready' | 'rejected' | 'error';

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png'];

/** Client-side pre-check (the server re-validates the real bytes; ME-02/ME-03). */
export function precheck(file: File): string | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return `${file.name}: only JPEG and PNG images are supported in this release.`;
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

/**
 * Upload flow: upload-intent -> presigned POST (FormData with returned fields) directly to object
 * storage -> /complete (synchronous validation => ready | rejected).
 */
export async function uploadAsset(brandId: string, file: File, onPhase: (p: UploadPhase) => void): Promise<Asset> {
  onPhase('requesting');
  const intent = await api.post<UploadIntent>('/api/assets/upload-intent', {
    brand_id: brandId, filename: file.name, content_type: file.type, bytes: file.size,
  });
  onPhase('uploading');
  const fd = new FormData();
  for (const [k, v] of Object.entries(intent.upload.fields ?? {})) fd.append(k, v);
  fd.append('file', file);
  let res: Response;
  try {
    res = await fetch(intent.upload.url, { method: intent.upload.method ?? 'POST', body: fd, credentials: 'omit' });
  } catch {
    throw new ApiError(0, 'network', 'Upload failed. Check your connection and try again.', undefined, undefined, null);
  }
  if (!res.ok) {
    const msg = res.status === 400 || res.status === 403
      ? 'Upload refused — the file may be too large or the link expired. Try again.'
      : `Upload failed (${res.status}). Try again.`;
    throw new ApiError(res.status, 'upload_failed', msg, undefined, undefined, null);
  }
  onPhase('validating');
  const asset = await api.post<Asset>(`/api/assets/${intent.asset_id}/complete`, {});
  onPhase(asset.status === 'ready' ? 'ready' : asset.status === 'rejected' ? 'rejected' : 'validating');
  return asset;
}
