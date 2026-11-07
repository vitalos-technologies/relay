// Shared domain types. Pure: no IO. Used by web, worker, services and providers.

export const PROVIDERS = [
  'instagram', 'facebook', 'telegram', 'x',
  // V3 (additive)
  'tiktok', 'youtube', 'linkedin', 'threads', 'pinterest', 'bluesky',
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABEL: Record<Provider, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  telegram: 'Telegram',
  x: 'X',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  threads: 'Threads',
  pinterest: 'Pinterest',
  bluesky: 'Bluesky',
};

export const ROLES = ['owner', 'admin', 'editor', 'approver', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const CONNECTION_STATUSES = [
  'pending_verification', 'ready', 'missing_permission', 'expiring', 'reconnect_required', 'paused', 'disconnected',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  pending_verification: 'Verifying',
  ready: 'Ready',
  missing_permission: 'Missing permission',
  expiring: 'Expiring',
  reconnect_required: 'Reconnect required',
  paused: 'Paused',
  disconnected: 'Disconnected',
};

/** Connection states that still permit dispatch. 'expiring' still works until expiry. */
export const DISPATCHABLE_CONNECTION_STATUSES: ReadonlySet<ConnectionStatus> = new Set(['ready', 'expiring']);

export const DELIVERY_STATES = [
  'scheduled', 'preparing', 'publishing', 'processing', 'retry_wait', 'published',
  'failed', 'blocked', 'paused', 'cancelled', 'expired', 'unknown', 'handoff',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const TERMINAL_DELIVERY_STATES: ReadonlySet<DeliveryState> = new Set(['published', 'failed', 'cancelled', 'expired']);
/** States in which an outbound request may be in flight; cancellation can no longer be guaranteed. */
export const IN_FLIGHT_DELIVERY_STATES: ReadonlySet<DeliveryState> = new Set(['publishing', 'processing']);

export type MediaFormat = 'text' | 'image' | 'album' | 'video' | 'reel';

export interface UrlButton { text: string; url: string }

/** Per-destination override inside a draft. */
export interface VariantDraft {
  connectionId: string;
  inheritText: boolean;          // CO-03: true => uses base text
  text?: string;                 // used when inheritText=false
  inheritMedia: boolean;
  assetIds?: string[];           // used when inheritMedia=false
  link?: string | null;          // overrides base link when defined
  buttons?: UrlButton[];         // Telegram URL buttons
  options?: Record<string, unknown>;
}

/** The mutable working draft stored on posts.draft. */
export interface DraftContent {
  baseText: string;
  baseLink?: string | null;
  baseAssetIds: string[];
  variants: VariantDraft[];
}

export const EMPTY_DRAFT: DraftContent = { baseText: '', baseLink: null, baseAssetIds: [], variants: [] };

/** A fully resolved, immutable outgoing variant (what will actually be sent). */
export interface ResolvedVariant {
  connectionId: string;
  provider: Provider;
  inheritText: boolean;
  text: string;
  link: string | null;
  assetIds: string[];
  format: MediaFormat;
  buttons: UrlButton[];
  options: Record<string, unknown>;
}

export interface ChannelConstraints {
  /** Max text length for text-only posts, in the provider's counting unit. */
  maxTextLength: number;
  /** Max caption length when media is attached. */
  maxCaptionLength: number;
  /** 'graphemes' (V3): user-perceived characters (Bluesky 300 graphemes). */
  textCounting: 'utf16' | 'codepoints' | 'x_weighted' | 'graphemes';
  requiresMedia: boolean;
  supportsTextOnly: boolean;
  supportsLink: boolean;
  supportsButtons: boolean;
  maxButtons: number;
  maxImages: number;
  imageMimes: string[];
  maxImageBytes: number;
  minImageWidth?: number;
  maxImageWidth?: number;
  minAspectRatio?: number;    // width / height
  maxAspectRatio?: number;
  maxHashtags?: number;
  maxMentions?: number;

  // ---- V1.1 richer media (all optional: absent ⇒ the destination does not support it)
  /** Items allowed in one multi-item post (carousel / album / multi-photo). Absent ⇒ maxImages. */
  maxAlbumItems?: number;
  /** Minimum items for a multi-item post (provider minimum, e.g. Telegram media group 2). */
  minAlbumItems?: number;
  /** Videos may appear inside a multi-item post (Instagram carousel, Telegram album). */
  albumAllowsVideo?: boolean;
  /** URL buttons can be attached to a multi-item post (Telegram media groups cannot carry reply_markup). */
  albumSupportsButtons?: boolean;
  /** Videos allowed per post (single-video formats). 0 / absent ⇒ video unsupported. */
  maxVideos?: number;
  videoMimes?: string[];
  maxVideoBytes?: number;
  minVideoSeconds?: number;
  maxVideoSeconds?: number;
  /** Accepted video codecs (ffprobe codec_name, e.g. 'h264', 'hevc'). */
  videoCodecs?: string[];
  /** Accepted audio codecs ('aac'); a video without audio is always accepted. */
  audioCodecs?: string[];
  minVideoAspectRatio?: number;   // width / height
  maxVideoAspectRatio?: number;
  maxVideoWidth?: number;
  /** Longest / shortest side limits (orientation-independent), e.g. X 1280×1024. */
  maxVideoLongSide?: number;
  maxVideoShortSide?: number;
  minFrameRate?: number;
  maxFrameRate?: number;
}

/** Kind of an asset as far as publishing is concerned. */
export type MediaKind = 'image' | 'video';

export interface ChannelCapabilities {
  provider: Provider;
  formats: MediaFormat[];
  canPublish: boolean;
  canEditPublished: boolean;
  canDeletePublished: boolean;
  canReadMetrics: boolean;
  canReconcile: boolean;
  constraints: ChannelConstraints;
  constraintsVersion: string;
  checkedAt: string; // ISO
  // ---- V3 (optional, additive): independently modelled capabilities.
  /** How publication happens: automated API post, delivery to the creator's drafts/inbox, or manual handoff only. */
  publishMode?: 'direct' | 'draft_handoff' | 'manual';
  /** The provider can hold a scheduled release itself (YouTube publishAt) AND the app can cancel it. */
  nativeScheduling?: boolean;
  /** Access/eligibility limits that apply to this destination (audit, trial tier, account type). */
  eligibility?: { status: 'eligible' | 'restricted' | 'awaiting_approval' | 'unsupported'; message: string };
  /** Provider-specific fields the composer must collect (variant.options.<provider>.<key>). */
  requiredOptions?: string[];
}

export type PostAggregateStatus =
  | 'draft' | 'pending_approval' | 'rejected' | 'scheduled' | 'publishing' | 'published'
  | 'partial' | 'failed' | 'needs_attention' | 'cancelled' | 'expired';

export interface ValidationIssue {
  connectionId?: string;
  provider?: Provider;
  /** 'options' (V3): a required provider-specific field (e.g. TikTok privacy level, YouTube title). */
  field: 'text' | 'media' | 'link' | 'buttons' | 'schedule' | 'destination' | 'approval' | 'options';
  code: string;
  message: string; // exact, user-facing fix
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}
