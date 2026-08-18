import { z } from "zod";
import { TimeMsSchema } from "@cutos/edit-dsl";

/**
 * Immutable description of the original media. CUTOS never rewrites this file;
 * every edit is expressed as ranges/segments referencing these source
 * coordinates.
 */
export const SourceMediaSchema = z.object({
  id: z.string().min(1),
  uri: z.string().min(1),
  durationMs: TimeMsSchema,
  hasAudio: z.boolean(),
});
export type SourceMedia = z.infer<typeof SourceMediaSchema>;

/**
 * A clip is a half-open source range [sourceInMs, sourceOutMs) played at
 * `speed`. The timeline output is simply the ordered concatenation of clips,
 * so ripple edits fall out naturally from adding/removing clips.
 */
export const ClipSchema = z.object({
  id: z.string().min(1),
  sourceInMs: TimeMsSchema,
  sourceOutMs: TimeMsSchema,
  speed: z.number().min(0.25).max(4),
});
export type Clip = z.infer<typeof ClipSchema>;

export const TrackSchema = z.object({
  id: z.string().min(1),
  clips: z.array(ClipSchema),
});
export type Track = z.infer<typeof TrackSchema>;

/** A timed caption anchored to source coordinates. */
export const CaptionSchema = z.object({
  id: z.string().min(1),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
  text: z.string().min(1),
});
export type Caption = z.infer<typeof CaptionSchema>;

/** A point marker anchored to source coordinates. */
export const MarkerSchema = z.object({
  id: z.string().min(1),
  atMs: TimeMsSchema,
  label: z.string().min(1),
});
export type Marker = z.infer<typeof MarkerSchema>;

export const TimelineSchema = z.object({
  id: z.string().min(1),
  source: SourceMediaSchema,
  track: TrackSchema,
  /** Optional annotation layers (kept optional for backward compatibility). */
  captions: z.array(CaptionSchema).optional(),
  markers: z.array(MarkerSchema).optional(),
});
export type Timeline = z.infer<typeof TimelineSchema>;

export function createTimeline(source: SourceMedia): Timeline {
  return {
    id: `tl_${source.id}`,
    source,
    track: {
      id: "track_main",
      clips: [
        {
          id: makeClipId(0, source.durationMs),
          sourceInMs: 0,
          sourceOutMs: source.durationMs,
          speed: 1,
        },
      ],
    },
  };
}

/** Output duration of a single clip after its speed is applied. */
export function clipOutputDurationMs(clip: Clip): number {
  return Math.round((clip.sourceOutMs - clip.sourceInMs) / clip.speed);
}

/** Total rendered timeline duration in milliseconds. */
export function timelineDurationMs(timeline: Timeline): number {
  return timeline.track.clips.reduce((sum, clip) => sum + clipOutputDurationMs(clip), 0);
}

/** Deterministic, collision-free id for a clip covering a unique source range. */
export function makeClipId(sourceInMs: number, sourceOutMs: number): string {
  return `clip_${sourceInMs}_${sourceOutMs}`;
}
