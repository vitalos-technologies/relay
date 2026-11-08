// Content Hub (V3 stream CH) response types for the UI: Google Drive/Docs + Notion connections, linked source
// items, import previews, imports, refresh diffs, Notion mappings and writeback. Served by
// /api/content-hub/** (apps/web/app/api/content-hub). Imported text is UNTRUSTED content — render as text only.
import type { ExportJob } from './exports.js';

export type ContentSource = 'google' | 'notion';
export type ContentAuthMode = 'oauth' | 'internal_token' | 'test';
export type ContentConnectionStatus = 'active' | 'reconnect_required' | 'disconnected';
export type SourceItemKind = 'drive_file' | 'google_doc' | 'notion_page' | 'notion_data_source' | 'notion_row';
export type SourceItemState = 'linked' | 'access_lost' | 'removed' | 'disconnected';

export interface ContentHubSourceStatus {
  source: ContentSource;
  configured: boolean;
  /** Missing setting keys (names only). */
  missing: string[];
  redirect_uri: string;
  scopes: string[];
  /** Google only: Picker (API key + app id) configured. */
  picker_configured?: boolean;
  /** Notion only: pinned Notion-Version. */
  api_version?: string;
  /** Notion only: an internal token is configured for a test installation (non-production). */
  internal_token_available?: boolean;
  /** Labelled test transports available (non-production only). */
  test_mode_available: boolean;
}

export interface ContentConnectionDto {
  id: string;
  source: ContentSource;
  scope: 'workspace' | 'brand';
  brand_id: string | null;
  account_label: string;
  auth_mode: ContentAuthMode;
  /** true when backed by a labelled test transport (never live data). */
  is_test: boolean;
  status: ContentConnectionStatus;
  status_detail: string | null;
  granted_scopes: string[];
  writeback_enabled: boolean;
  authorized_by: string | null;
  created_at: string;
  last_used_at: string | null;
  disconnected_at: string | null;
  item_count: number;
  can_manage: boolean;
}

export interface PickerConfigDto {
  client_id: string;
  api_key: string;
  app_id: string;
  scope: string;
  /** Account the connection was authorised with — the browser picker must use the same account. */
  login_hint: string;
}

export interface NormalizedLink { text: string; url: string }

export type NormalizedBlockType =
  | 'heading' | 'paragraph' | 'list_item' | 'quote' | 'code' | 'divider' | 'todo' | 'callout' | 'toggle' | 'table_row' | 'media_ref' | 'unsupported';

export interface NormalizedBlock {
  type: NormalizedBlockType;
  text: string;
  /** Heading level 1-6 (title = 1). */
  level?: number;
  ordered?: boolean;
  depth?: number;
  checked?: boolean;
  links?: NormalizedLink[];
  /** media_ref: source file reference (Notion file block) — imported only into validated storage. */
  media?: { kind: 'image' | 'video' | 'file'; name: string | null; external: boolean };
  /** unsupported: the provider's block/element type. */
  source_type?: string;
}

export interface NormalizedSection {
  /** Stable id: "<tabId>" or "<tabId>#h<n>" (heading-split) or Notion block id. */
  id: string;
  title: string;
  tab_id: string | null;
  tab_title: string | null;
  level: number;
  blocks: NormalizedBlock[];
  word_count: number;
}

export interface ImportWarning {
  code:
    | 'unsupported_element' | 'inline_image_skipped' | 'table_flattened' | 'suggestions_excluded' | 'suggestions_inline'
    | 'comments_omitted' | 'depth_limit' | 'page_limit' | 'incomplete_fetch' | 'unsupported_block' | 'file_url_expiring'
    | 'equation_text' | 'smart_chip' | 'truncated';
  message: string;
  count: number;
  section_id?: string | null;
}

export type SuggestionsMode = 'exclude' | 'accept' | 'inline';

export interface DocumentPreviewDto {
  connection_id: string;
  brand_id: string;
  external_id: string;
  title: string;
  /** sha256 of the normalized content; the import must match it (source changed ⇒ preview again). */
  fingerprint: string;
  source_version: string | null;
  source_modified_at: string | null;
  sections: NormalizedSection[];
  warnings: ImportWarning[];
  suggestions_mode: SuggestionsMode;
  comments_included: false;
  incomplete: boolean;
  /** Notice shown before import (snapshot semantics, brand visibility). */
  visibility_notice: string;
}

export interface DriveFilePreviewDto {
  connection_id: string;
  account_label: string;
  brand: { id: string; name: string };
  file: {
    id: string; name: string; mime_type: string; size_bytes: number | null; modified_time: string | null; version: string | null;
    md5_checksum: string | null; shared_drive: boolean; resolved_from_shortcut: string | null; web_view_link: string | null;
  };
  media_kind: 'image' | 'video' | 'document' | null;
  can_import: boolean;
  blocked_reason: string | null;
  sharing_effect: string;
}

export interface SourceSnapshotSummary {
  id: string;
  seq: number;
  fingerprint: string;
  imported_at: string;
  imported_by: string | null;
  source_version: string | null;
  incomplete: boolean;
  warning_count: number;
  asset_id: string | null;
  has_diff: boolean;
}

export interface SourceItemDto {
  id: string;
  brand_id: string;
  connection_id: string;
  source: ContentSource;
  account_label: string;
  item_kind: SourceItemKind;
  title: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  shared_drive: boolean;
  state: SourceItemState;
  state_detail: string | null;
  /** Linked-source preview; null whenever the item is not readable now (access lost/disconnected). */
  preview: { excerpt: string | null; section_count: number | null } | null;
  /** Display link to the source; null when not linked. Never used as a media source. */
  external_url: string | null;
  source_version: string | null;
  source_modified_at: string | null;
  change_detected_at: string | null;
  last_synced_at: string | null;
  retention_hold: boolean;
  last_snapshot: SourceSnapshotSummary | null;
  import_count: number;
}

export type ImportAction = 'media_asset' | 'doc_drafts' | 'doc_campaign' | 'notion_page_draft' | 'notion_rows' | 'refresh';
export type ImportStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface RowImportResult {
  row_id: string;
  status: 'imported' | 'skipped' | 'duplicate' | 'error';
  post_id?: string | null;
  message?: string | null;
}

export interface ImportDto {
  id: string;
  action: ImportAction;
  status: ImportStatus;
  brand_id: string;
  connection_id: string;
  source_item_id: string | null;
  snapshot_id: string | null;
  /** true when this request matched an earlier identical import (retry ⇒ same result). */
  deduplicated: boolean;
  created_at: string;
  completed_at: string | null;
  result: {
    post_ids?: string[];
    asset_id?: string | null;
    campaign_id?: string | null;
    rows?: RowImportResult[];
    refresh?: RefreshResultDto | null;
    /** Non-fatal problems (e.g. a media file that could not be copied). */
    warnings?: string[];
  };
  error: { code: string; message: string } | null;
}

export interface TextDiffLine { op: 'add' | 'remove' | 'same'; text: string }

export interface SnapshotDiffDto {
  from_snapshot_id: string | null;
  to_snapshot_id: string;
  changed: boolean;
  sections_added: string[];
  sections_removed: string[];
  sections_changed: string[];
  lines: TextDiffLine[];
  truncated: boolean;
}

export interface RefreshResultDto {
  changed: boolean;
  snapshot_id: string | null;
  diff: SnapshotDiffDto | null;
  /** revised = new version of an editable draft; new_draft = a NEW draft beside approved/scheduled/edited content. */
  drafts: Array<{ post_id: string; outcome: 'revised' | 'new_draft' | 'unchanged'; new_post_id?: string | null; reason?: string | null }>;
  state: SourceItemState;
}

export interface NotionSearchResultDto {
  id: string;
  kind: 'page' | 'data_source';
  title: string;
  url: string | null;
  last_edited_time: string | null;
  already_linked: boolean;
}

export interface NotionPropertyDto { id: string; name: string; type: string; options: string[] }

export type MappingField = 'title' | 'body' | 'campaign' | 'target_date' | 'status' | 'external_ref';
export type WritebackField = 'status' | 'scheduled_time' | 'post_url';

export interface NotionMappingDto {
  id: string | null;
  version: number;
  /** Property ids; body may be 'page_content'. */
  mapping: Partial<Record<MappingField, string>>;
  import_statuses: string[];
  writeback: Partial<Record<WritebackField, string>>;
  schema_fingerprint: string | null;
}

export interface DataSourceSchemaDto {
  source_item_id: string;
  data_source_id: string;
  title: string;
  properties: NotionPropertyDto[];
  mapping: NotionMappingDto | null;
  schema_fingerprint: string;
  /** Notion statuses never grant Relay approval — informational. */
  approval_notice: string;
}

export interface RowPreviewDto {
  row_id: string;
  title: string;
  body_preview: string;
  campaign: string | null;
  target_date: string | null;
  status: string | null;
  external_ref: string | null;
  last_edited_time: string | null;
  importable: boolean;
  errors: string[];
  already_imported: boolean;
}

export interface RowsPreviewDto {
  rows: RowPreviewDto[];
  next_cursor: string | null;
  incomplete: boolean;
  warnings: ImportWarning[];
}

export type WritebackStatus = 'pending' | 'running' | 'written' | 'conflict' | 'skipped' | 'failed' | 'cancelled';

export interface WritebackJobDto {
  id: string;
  source_item_id: string;
  post_id: string | null;
  field: WritebackField;
  status: WritebackStatus;
  desired_value: unknown;
  conflict: { external_value: unknown; expected_fingerprint: string | null; actual_fingerprint: string } | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ContentHubOverviewDto {
  status: ContentHubSourceStatus[];
  connections: ContentConnectionDto[];
  items: SourceItemDto[];
  recent_imports: ImportDto[];
  recent_exports: ExportJob[];
  /** Snapshot retention (days) after access loss/disconnect; holds override it. */
  snapshot_retention_days: number;
}
