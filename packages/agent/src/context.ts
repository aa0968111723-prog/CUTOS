import { z } from "zod";

export const EditContextSchema = z.object({
  sourceDurationMs: z.number().int().nonnegative(),
  timelineRevision: z.number().int().nonnegative(),
  silences: z.array(z.object({ startMs: z.number(), endMs: z.number() })),
  transcriptSentences: z
    .array(
      z.object({
        startMs: z.number(),
        endMs: z.number(),
        text: z.string(),
        speaker: z.string().nullable().optional(),
      }),
    )
    .optional(),
  scenes: z.array(z.object({ startMs: z.number(), endMs: z.number() })).optional(),
  topics: z.array(z.string()).optional(),
  mediaChecksum: z.string().optional(),
});
export type EditContext = z.infer<typeof EditContextSchema>;

/** Gathers the project context an agent needs before planning. Injected by the app. */
export interface ContextBuilder {
  build(projectId: string): Promise<EditContext>;
}
