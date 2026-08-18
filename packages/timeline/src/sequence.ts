import { z } from "zod";
import { TimeMsSchema } from "@cutos/edit-dsl";
import { clipOutputDurationMs, timelineDurationMs, type Timeline } from "./model.js";

/**
 * The V2 semantic-timeline domain vocabulary. The editing engine currently
 * operates on the single-track {@link Timeline}; `toSequence` projects it into
 * this normalized multi-track shape that the UI's semantic timeline and future
 * multi-track features consume. Transitions/effects/transforms are modeled here
 * as first-class types even where the render engine does not yet apply them.
 */

export const MediaRefSchema = z.object({
  assetId: z.string().min(1),
  kind: z.enum(["video", "audio", "image"]),
});
export type MediaRef = z.infer<typeof MediaRefSchema>;

export const TransformSchema = z.object({
  scale: z.number().positive().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  rotationDeg: z.number().optional(),
});
export type Transform = z.infer<typeof TransformSchema>;

export const EffectSchema = z.object({
  type: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});
export type Effect = z.infer<typeof EffectSchema>;

export const TransitionSchema = z.object({
  type: z.enum(["cut", "crossfade", "fade"]),
  durationMs: TimeMsSchema,
});
export type Transition = z.infer<typeof TransitionSchema>;

export const TrackKindSchema = z.enum(["video", "audio", "caption", "marker"]);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const SequenceItemSchema = z.object({
  id: z.string().min(1),
  timelineInMs: TimeMsSchema,
  timelineOutMs: TimeMsSchema,
  sourceInMs: TimeMsSchema.optional(),
  sourceOutMs: TimeMsSchema.optional(),
  speed: z.number().positive().optional(),
  label: z.string().optional(),
  transform: TransformSchema.optional(),
  effects: z.array(EffectSchema).optional(),
});
export type SequenceItem = z.infer<typeof SequenceItemSchema>;

export const SequenceTrackSchema = z.object({
  id: z.string().min(1),
  kind: TrackKindSchema,
  items: z.array(SequenceItemSchema),
});
export type SequenceTrack = z.infer<typeof SequenceTrackSchema>;

export const SequenceSchema = z.object({
  id: z.string().min(1),
  durationMs: TimeMsSchema,
  tracks: z.array(SequenceTrackSchema),
});
export type Sequence = z.infer<typeof SequenceSchema>;

/** Project the editing timeline into a normalized multi-track sequence. */
export function toSequence(timeline: Timeline): Sequence {
  const videoItems: SequenceItem[] = [];
  const audioItems: SequenceItem[] = [];
  let cursor = 0;
  for (const clip of timeline.track.clips) {
    const out = cursor + clipOutputDurationMs(clip);
    const base = {
      timelineInMs: cursor,
      timelineOutMs: out,
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
      speed: clip.speed,
    };
    videoItems.push({ id: `v_${clip.id}`, ...base });
    if (timeline.source.hasAudio) {
      audioItems.push({ id: `a_${clip.id}`, ...base });
    }
    cursor = out;
  }

  const tracks: SequenceTrack[] = [{ id: "video", kind: "video", items: videoItems }];
  if (timeline.source.hasAudio) {
    tracks.push({ id: "audio", kind: "audio", items: audioItems });
  }
  if (timeline.captions?.length) {
    tracks.push({
      id: "captions",
      kind: "caption",
      items: timeline.captions.map((c) => ({
        id: c.id,
        timelineInMs: c.startMs,
        timelineOutMs: c.endMs,
        label: c.text,
      })),
    });
  }
  if (timeline.markers?.length) {
    tracks.push({
      id: "markers",
      kind: "marker",
      items: timeline.markers.map((m) => ({
        id: m.id,
        timelineInMs: m.atMs,
        timelineOutMs: m.atMs,
        label: m.label,
      })),
    });
  }

  return { id: `seq_${timeline.id}`, durationMs: timelineDurationMs(timeline), tracks };
}
