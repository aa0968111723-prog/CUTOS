import { clipOutputDurationMs, type Timeline } from "@cutos/timeline";

/**
 * A single playable segment: a half-open source range `[sourceInMs, sourceOutMs)`
 * played at `speed`, placed on the edited timeline at `[timelineInMs, timelineOutMs)`.
 *
 * This is the SINGLE source of truth for turning a timeline into an ordered list
 * of playable ranges. Both the browser Preview backend and the FFmpeg render
 * compiler consume it, which is what guarantees preview/export parity.
 */
export interface PreviewSegment {
  index: number;
  clipId: string;
  sourceInMs: number;
  sourceOutMs: number;
  speed: number;
  timelineInMs: number;
  timelineOutMs: number;
}

/** Compile a timeline into ordered, non-empty playable segments. */
export function compileSegments(timeline: Timeline): PreviewSegment[] {
  const segments: PreviewSegment[] = [];
  let cursor = 0;
  let index = 0;
  for (const clip of timeline.track.clips) {
    const outputMs = clipOutputDurationMs(clip);
    if (outputMs <= 0) continue;
    const timelineInMs = cursor;
    const timelineOutMs = cursor + outputMs;
    segments.push({
      index,
      clipId: clip.id,
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
      speed: clip.speed,
      timelineInMs,
      timelineOutMs,
    });
    cursor = timelineOutMs;
    index += 1;
  }
  return segments;
}

/** Total edited duration = end of the last segment (0 when empty). */
export function previewDurationMs(segments: PreviewSegment[]): number {
  return segments.length ? (segments.at(-1)?.timelineOutMs ?? 0) : 0;
}
