import { z } from "zod";
import { TimeMsSchema } from "./time.js";

/**
 * Canonical, versioned Edit DSL operations. These describe editing INTENT in
 * source-relative coordinates. They never reference FFmpeg, files, or mutable
 * media. A timeline engine interprets the implemented subset; the rest are
 * modeled so the agent and review surface can reason about them ahead of full
 * render support.
 *
 * Every operation is deterministic (same op + same timeline => same result),
 * which is what makes an Edit Plan replayable and reversible.
 */

export const EDIT_DSL_VERSION = 2 as const;

export const RangeSchema = z.object({
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
});
export type Range = z.infer<typeof RangeSchema>;

/** A checkable assumption the operation relied on when it was planned. */
export const PreconditionSchema = z.object({
  type: z.string().min(1),
  detail: z.record(z.unknown()).optional(),
});
export type Precondition = z.infer<typeof PreconditionSchema>;

/** Metadata shared by every operation (all optional for back-compat). */
export const OpMetaSchema = z.object({
  id: z.string().optional(),
  reason: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
  affectedRanges: z.array(RangeSchema).optional(),
  preconditions: z.array(PreconditionSchema).optional(),
  source: z.enum(["agent", "user", "heuristic"]).optional(),
  createdBy: z.string().optional(),
});

// --- Implemented operations (the timeline engine applies these today) ---

export const RemoveRangeOpSchema = OpMetaSchema.extend({
  type: z.literal("removeRange"),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
});
export const DeleteRangeOpSchema = OpMetaSchema.extend({
  type: z.literal("deleteRange"),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
});
export const TrimOpSchema = OpMetaSchema.extend({
  type: z.literal("trim"),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
});
export const SplitOpSchema = OpMetaSchema.extend({
  type: z.literal("split"),
  atMs: TimeMsSchema,
});
export const SetSpeedOpSchema = OpMetaSchema.extend({
  type: z.literal("setSpeed"),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
  speed: z.number().min(0.25, "speed must be >= 0.25x").max(4, "speed must be <= 4x"),
});
export const MarkerOpSchema = OpMetaSchema.extend({
  type: z.literal("marker"),
  atMs: TimeMsSchema,
  label: z.string().min(1).max(200),
});
export const CaptionOpSchema = OpMetaSchema.extend({
  type: z.literal("caption"),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
  text: z.string().min(1).max(2000),
});

// --- Modeled operations (validated + reviewable; render support is staged) ---

export const RemoveSilenceOpSchema = OpMetaSchema.extend({
  type: z.literal("removeSilence"),
  minSilenceMs: TimeMsSchema.optional(),
});
export const InsertClipOpSchema = OpMetaSchema.extend({
  type: z.literal("insertClip"),
  atMs: TimeMsSchema,
  sourceInMs: TimeMsSchema,
  sourceOutMs: TimeMsSchema,
  mediaRef: z.string().optional(),
});
export const MoveClipOpSchema = OpMetaSchema.extend({
  type: z.literal("moveClip"),
  clipId: z.string().min(1),
  toMs: TimeMsSchema,
});
export const CropOpSchema = OpMetaSchema.extend({
  type: z.literal("crop"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export const ReframeOpSchema = OpMetaSchema.extend({
  type: z.literal("reframe"),
  aspect: z.enum(["9:16", "1:1", "4:5", "16:9"]),
});
export const VolumeOpSchema = OpMetaSchema.extend({
  type: z.literal("volume"),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
  gainDb: z.number().min(-60).max(24),
});
export const FadeOpSchema = OpMetaSchema.extend({
  type: z.literal("fade"),
  atMs: TimeMsSchema,
  durationMs: TimeMsSchema,
  direction: z.enum(["in", "out"]),
  target: z.enum(["audio", "video"]),
});

export const EditOperationSchema = z.discriminatedUnion("type", [
  RemoveRangeOpSchema,
  DeleteRangeOpSchema,
  TrimOpSchema,
  SplitOpSchema,
  SetSpeedOpSchema,
  MarkerOpSchema,
  CaptionOpSchema,
  RemoveSilenceOpSchema,
  InsertClipOpSchema,
  MoveClipOpSchema,
  CropOpSchema,
  ReframeOpSchema,
  VolumeOpSchema,
  FadeOpSchema,
]);
export type EditOperation = z.infer<typeof EditOperationSchema>;
export type EditOperationType = EditOperation["type"];

export type RemoveRangeOp = z.infer<typeof RemoveRangeOpSchema>;
export type SetSpeedOp = z.infer<typeof SetSpeedOpSchema>;

/** Operation types the timeline engine currently renders/applies. */
export const IMPLEMENTED_OPERATIONS: readonly EditOperationType[] = [
  "removeRange",
  "deleteRange",
  "trim",
  "split",
  "setSpeed",
  "marker",
  "caption",
] as const;

export function isImplementedOperation(type: EditOperationType): boolean {
  return IMPLEMENTED_OPERATIONS.includes(type);
}
