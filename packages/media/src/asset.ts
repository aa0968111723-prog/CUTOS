import { z } from "zod";
import { TimeMsSchema } from "@cutos/edit-dsl";

/**
 * The kinds of derived + original media CUTOS tracks for a project. The
 * original is immutable; everything else is a regenerable derivative referenced
 * by an opaque storage key (never an absolute local path).
 */
export const MediaAssetKindSchema = z.enum([
  "original",
  "proxy",
  "audio",
  "waveform",
  "thumbnail",
  "transcript",
  "export",
]);
export type MediaAssetKind = z.infer<typeof MediaAssetKindSchema>;

export const MediaAssetSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: MediaAssetKindSchema,
  mimeType: z.string().min(1),
  storageKey: z.string().min(1),
  checksum: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  durationMs: TimeMsSchema.nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  codec: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;
