import { z } from "zod";
import { TimeMsSchema } from "./time.js";

/**
 * Canonical, versioned Edit DSL operations. These describe editing INTENT in
 * source-relative coordinates. They never reference FFmpeg, files, or mutable
 * media. A timeline engine interprets them into a non-destructive edit graph.
 *
 * Every operation is:
 *  - self-describing (carries a human-readable `reason` for review cards),
 *  - deterministic (same op + same timeline => same result), which is what
 *    makes an Edit Plan replayable and reversible.
 */

export const EDIT_DSL_VERSION = 1 as const;

/** Ripple-remove a source range from the timeline (used for pause removal). */
export const RemoveRangeOpSchema = z.object({
  type: z.literal("removeRange"),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
  reason: z.string().max(280).optional(),
});
export type RemoveRangeOp = z.infer<typeof RemoveRangeOpSchema>;

/** Change playback speed for a source range (used for "make this faster"). */
export const SetSpeedOpSchema = z.object({
  type: z.literal("setSpeed"),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
  speed: z
    .number()
    .min(0.25, "speed must be >= 0.25x")
    .max(4, "speed must be <= 4x"),
  reason: z.string().max(280).optional(),
});
export type SetSpeedOp = z.infer<typeof SetSpeedOpSchema>;

export const EditOperationSchema = z.discriminatedUnion("type", [
  RemoveRangeOpSchema,
  SetSpeedOpSchema,
]);
export type EditOperation = z.infer<typeof EditOperationSchema>;

export type EditOperationType = EditOperation["type"];
