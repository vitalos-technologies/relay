// Shared export contract (V3): Analytics (AN) produces report content; Content Hub (CH) implements destinations
// (new Google Doc, file in a selected Drive folder, new Notion page under a selected parent). Defined minimally by CH;
// AN may extend additively (re-read before editing — shared file).
//
// Rules every exporter follows (docs/V3_CONTENT_INTEGRATIONS.md "Exports"):
//  - explicit, permissioned action; the DESTINATION (connection + granted parent) and the CONTENT (permission on the
//    exported data) are checked independently, at request time AND again when the job runs;
//  - creates a NEW document/file/page by default — never overwrites the source;
//  - never changes sharing/ACLs; the destination's inherited sharing is reported as `sharing_warning`.

export type ExportFormat = 'html' | 'markdown' | 'csv' | 'pdf' | 'text';
export type ExportDestinationKind = 'google_doc' | 'drive_file' | 'notion_page';

export interface ExportDestination {
  kind: ExportDestinationKind;
  /** Content Hub connection (content_connections.id) that authorises writing to the destination. */
  connectionId: string;
  /** Selected + granted parent: Drive folder id or Notion page id. null = Drive root of the connected account (Docs/Drive only). */
  parentId: string | null;
}

/** What is exported and the permission needed to read it (re-checked when the job runs). */
export interface ExportContentRef {
  kind: 'analytics_report' | 'content_plan' | 'other';
  brandId: string | null;
  permission: 'analytics.read' | 'content.read';
  /** Optional reference, e.g. a saved report id or a campaign id. */
  ref?: string | null;
}

export interface ExportInput {
  destination: ExportDestination;
  title: string;
  format: ExportFormat;
  /** Exactly one of contentBytes / html / text. */
  contentBytes?: Uint8Array;
  html?: string;
  text?: string;
  /** MIME type of contentBytes (e.g. application/pdf, text/csv). */
  mimeType?: string;
  content: ExportContentRef;
  /** Retries with the same key never create a second document. */
  idempotencyKey?: string;
}

export type ExportJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ExportJob {
  id: string;
  status: ExportJobStatus;
  destination_kind: ExportDestinationKind;
  destination_parent_id: string | null;
  title: string;
  format: ExportFormat;
  brand_id: string | null;
  created_at: string;
  completed_at: string | null;
  /** Link to the created document (only after completion). */
  result_url: string | null;
  result_external_id: string | null;
  /** e.g. "The new Doc inherits the sharing of folder ‘Reports’." Relay never changes sharing. */
  sharing_warning: string | null;
  error: { code: string; message: string } | null;
}

/** Implemented by Content Hub for each destination kind. Ctx is the services request context. */
export interface ReportExporter<Ctx = unknown> {
  readonly kinds: readonly ExportDestinationKind[];
  export(ctx: Ctx, input: ExportInput): Promise<ExportJob>;
}
