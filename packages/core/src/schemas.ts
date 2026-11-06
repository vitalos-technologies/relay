// Zod schemas for API payloads shared by route handlers and the client.
import { z } from 'zod';

export const uuid = z.string().uuid();

export const urlButtonSchema = z.object({ text: z.string().trim().min(1).max(64), url: z.string().url().max(2048) });

export const variantDraftSchema = z.object({
  connectionId: uuid,
  inheritText: z.boolean(),
  text: z.string().max(70_000).optional(),
  inheritMedia: z.boolean(),
  assetIds: z.array(uuid).max(10).optional(),
  link: z.string().max(2048).nullable().optional(),
  buttons: z.array(urlButtonSchema).max(8).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const draftContentSchema = z.object({
  baseText: z.string().max(70_000),
  baseLink: z.string().max(2048).nullable().optional(),
  baseAssetIds: z.array(uuid).max(10),
  variants: z.array(variantDraftSchema).max(50),
});

export const scheduleRequestSchema = z.object({
  expected_version: z.number().int().positive(),
  connection_ids: z.array(uuid).min(1).max(50),
  /** Local wall time in the chosen zone, YYYY-MM-DDTHH:mm. Omitted for publish-now. */
  input_local_time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/).optional(),
  timezone: z.string().min(1).max(64).optional(),
  /** Required only when the wall time is ambiguous (DST fold), e.g. "+01:00". */
  offset: z.string().regex(/^[+-]\d{2}:\d{2}$/).optional(),
  /** Minutes after due time before the job expires. Defaults to brand setting (15). */
  deadline_minutes: z.number().int().min(1).max(10_080).optional(),
});
export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>;
