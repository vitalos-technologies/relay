// Extension points the MCP server calls into without importing optional modules directly.
// Content Hub (stream CH) registers its source importer here when it lands:
//   registerSourceImporter((ctx, input) => importSourceToDraft(ctx, input))
// Until then import_source_to_draft answers `source_connections_unavailable` (documented in docs/V3_MCP_GUIDE.md).
// The importer runs under the caller's MCP-restricted ctx (scopes/brands/policy already applied) and must:
//   - authorize the source connection and the target brand itself (V2 authorize()),
//   - never return provider tokens, and treat imported text as untrusted data (no instruction handling).
import type { Ctx } from '../context.js';

export interface SourceImportInput {
  brand_id: string;
  source_connection_id: string;
  /** Provider reference chosen by the user (Drive file id, Docs document id, Notion page id). */
  source_ref: string;
  title?: string;
  idempotency_key: string;
}

export interface SourceImportResult { post_id: string; version: number; source: { provider: string; ref: string; snapshot_id: string | null } }

export type SourceImporter = (ctx: Ctx, input: SourceImportInput) => Promise<SourceImportResult>;

let importer: SourceImporter | null = null;

export function registerSourceImporter(fn: SourceImporter | null): void {
  importer = fn;
}

export function sourceImporter(): SourceImporter | null {
  return importer;
}
