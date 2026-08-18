import { z } from "zod";
import type { Timeline } from "@cutos/timeline";
import { compileSegments, previewDurationMs, type PreviewSegment } from "./segments.js";
import { sourceTimeToTimelineTime } from "./mapping.js";

export const PreviewSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  clipId: z.string(),
  sourceInMs: z.number().int().nonnegative(),
  sourceOutMs: z.number().int().nonnegative(),
  speed: z.number().positive(),
  timelineInMs: z.number().int().nonnegative(),
  timelineOutMs: z.number().int().nonnegative(),
});

export const PreviewCaptionSchema = z.object({
  id: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
});
export type PreviewCaption = z.infer<typeof PreviewCaptionSchema>;

export const PreviewMarkerSchema = z.object({
  id: z.string(),
  atMs: z.number().int().nonnegative(),
  label: z.string(),
});
export type PreviewMarker = z.infer<typeof PreviewMarkerSchema>;

/**
 * A fully self-contained description of how to play the edited timeline, in
 * edited-timeline coordinates. It is derived entirely from the Timeline — there
 * is no separate "preview timeline" to keep in sync.
 */
export const PreviewManifestSchema = z.object({
  timelineRevision: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  hasAudio: z.boolean(),
  segments: z.array(PreviewSegmentSchema),
  captions: z.array(PreviewCaptionSchema),
  markers: z.array(PreviewMarkerSchema),
});
export type PreviewManifest = z.infer<typeof PreviewManifestSchema>;

export interface CompilePreviewOptions {
  timelineRevision: number;
}

/** Compile a timeline into a preview manifest (segments + overlays in edited time). */
export function compileTimelineToPreview(
  timeline: Timeline,
  options: CompilePreviewOptions,
): PreviewManifest {
  const segments = compileSegments(timeline);
  const durationMs = previewDurationMs(segments);

  const captions: PreviewCaption[] = [];
  for (const caption of timeline.captions ?? []) {
    const start = sourceTimeToTimelineTime(segments, caption.startMs);
    if (start === null) continue; // caption's source content was removed
    const mappedEnd = sourceTimeToTimelineTime(segments, caption.endMs);
    const end = mappedEnd !== null && mappedEnd > start ? mappedEnd : Math.min(durationMs, start + 1500);
    captions.push({ id: caption.id, startMs: start, endMs: end, text: caption.text });
  }

  const markers: PreviewMarker[] = [];
  for (const marker of timeline.markers ?? []) {
    const at = sourceTimeToTimelineTime(segments, marker.atMs);
    if (at === null) continue;
    markers.push({ id: marker.id, atMs: at, label: marker.label });
  }

  return {
    timelineRevision: options.timelineRevision,
    durationMs,
    hasAudio: timeline.source.hasAudio,
    segments,
    captions,
    markers,
  };
}

/** Captions active at a given edited-timeline time. */
export function getActiveCaptionsAt(manifest: PreviewManifest, timelineMs: number): PreviewCaption[] {
  return manifest.captions.filter((c) => timelineMs >= c.startMs && timelineMs < c.endMs);
}

export type { PreviewSegment };
