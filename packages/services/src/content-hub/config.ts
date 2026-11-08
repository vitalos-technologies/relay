// Content Hub app configuration (env first, then the protected setup page via getSetting).
import { config, mockProvidersEnabled } from '../config.js';
import { getSetting } from '../settings.js';

/** Pinned Notion API version (developers.notion.com/reference/versioning, checked 2026-11-07). */
export const NOTION_VERSION = '2026-03-11';

/** Least-privilege Google scopes: per-file access (non-sensitive) + identity of the authorising account. */
export const GOOGLE_CONTENT_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'] as const;
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export function contentRedirectUri(source: 'google' | 'notion'): string {
  return `${config().APP_BASE_URL.replace(/\/$/, '')}/api/content-hub/oauth/${source}/callback`;
}

export interface GoogleContentConfig {
  clientId?: string; clientSecret?: string; pickerApiKey?: string; pickerAppId?: string; redirectUri: string;
  /** true when the dedicated content client is unset and the YouTube client is reused. */
  sharedClient: boolean;
}

export async function googleContentConfig(): Promise<GoogleContentConfig> {
  const dedicated = await getSetting('GOOGLE_CONTENT_CLIENT_ID');
  return {
    clientId: dedicated ?? (await getSetting('GOOGLE_CLIENT_ID')),
    clientSecret: dedicated ? await getSetting('GOOGLE_CONTENT_CLIENT_SECRET') : await getSetting('GOOGLE_CLIENT_SECRET'),
    pickerApiKey: await getSetting('GOOGLE_PICKER_API_KEY'),
    pickerAppId: await getSetting('GOOGLE_PICKER_APP_ID'),
    redirectUri: contentRedirectUri('google'),
    sharedClient: !dedicated,
  };
}

export interface NotionConfig { clientId?: string; clientSecret?: string; internalToken?: string; webhookToken?: string; redirectUri: string }

export async function notionConfig(): Promise<NotionConfig> {
  return {
    clientId: await getSetting('NOTION_CLIENT_ID'),
    clientSecret: await getSetting('NOTION_CLIENT_SECRET'),
    // Internal connections are for an internal test installation only (spec §11) — never in production.
    internalToken: config().APP_ENV === 'production' ? undefined : await getSetting('NOTION_INTERNAL_TOKEN'),
    webhookToken: await getSetting('NOTION_WEBHOOK_VERIFICATION_TOKEN'),
    redirectUri: contentRedirectUri('notion'),
  };
}

/** Labelled test source connections (in-process fake data) — development/test only. */
export function testSourcesEnabled(): boolean {
  return mockProvidersEnabled();
}

// Bounds (docs/V3_CONTENT_INTEGRATIONS.md "Limits").
export const LIMITS = {
  /** Drive files.export output is limited to 10 MB by Google. */
  exportBytes: 10 * 1024 * 1024,
  docJsonBytes: 15 * 1024 * 1024,
  notionMaxDepth: 4,
  notionMaxBlocks: 2_000,
  notionMaxPages: 40,          // child-list pages fetched per import (100 blocks each)
  notionRowPreview: 50,
  notionRowImport: 100,
  dataSourceQueryPages: 5,
  maxSectionsPerImport: 50,
  draftTextChars: 60_000,
  driveChangesPages: 10,
  exportUploadBytes: 5 * 1024 * 1024,   // Drive multipart upload limit
} as const;
