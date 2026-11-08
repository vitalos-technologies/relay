// External report destinations (Google Docs / Drive file / Notion page) through the shared ReportExporter contract
// (packages/core/src/contracts/exports.ts, implemented by the Content Hub stream). Analytics never talks to Google or
// Notion itself. Until an implementation is registered, a stub reports "destination not connected" honestly.
//
// Wiring (lead/CH): call registerReportExporter(contentHubExporter) once in the worker process before report-export
// jobs run (and in the web process if exports are ever run inline).
import { randomUUID } from 'node:crypto';
import type { ExportDestinationKind, ExportInput, ExportJob, ReportExporter } from '@social-lite/core/contracts/exports';
import type { Ctx } from '../context.js';

const registry = new Map<ExportDestinationKind, ReportExporter<Ctx>>();

export function registerReportExporter(e: ReportExporter<Ctx>): void {
  for (const k of e.kinds) registry.set(k, e);
}

/** Test hook. */
export function clearReportExporters(): void { registry.clear(); }

export const notConnectedExporter: ReportExporter<Ctx> = {
  kinds: ['google_doc', 'drive_file', 'notion_page'],
  async export(_ctx: Ctx, input: ExportInput): Promise<ExportJob> {
    return {
      id: randomUUID(), status: 'failed', destination_kind: input.destination.kind, destination_parent_id: input.destination.parentId, title: input.title,
      format: input.format, brand_id: input.content.brandId, created_at: new Date().toISOString(), completed_at: null, result_url: null, result_external_id: null,
      sharing_warning: null,
      error: { code: 'destination_not_connected', message: 'No Google Drive/Docs or Notion export destination is connected. Connect one in Settings → Content sources, or download the file instead.' },
    };
  },
};

export function reportExporterFor(kind: ExportDestinationKind): ReportExporter<Ctx> {
  return registry.get(kind) ?? notConnectedExporter;
}
