import type { PreviewSegment } from "./segments.js";

export interface SourceLocation {
  segmentIndex: number;
  sourceMs: number;
  speed: number;
}

/** Find the segment active at an edited-timeline time (clamped to the last). */
export function getActiveSegmentAt(
  segments: PreviewSegment[],
  timelineMs: number,
): PreviewSegment | null {
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (timelineMs >= segment.timelineInMs && timelineMs < segment.timelineOutMs) {
      return segment;
    }
  }
  // At/after the end, clamp to the last segment.
  const last = segments.at(-1);
  return last && timelineMs >= last.timelineOutMs ? last : (segments[0] ?? null);
}

/**
 * Map an edited-timeline time to a source time. Speed-aware:
 * `source = sourceIn + (t - timelineIn) * speed`.
 */
export function timelineTimeToSourceTime(
  segments: PreviewSegment[],
  timelineMs: number,
): SourceLocation | null {
  const segment = getActiveSegmentAt(segments, timelineMs);
  if (!segment) return null;
  const clamped = Math.max(segment.timelineInMs, Math.min(timelineMs, segment.timelineOutMs));
  const sourceMs = segment.sourceInMs + (clamped - segment.timelineInMs) * segment.speed;
  return {
    segmentIndex: segment.index,
    sourceMs: Math.round(Math.max(segment.sourceInMs, Math.min(sourceMs, segment.sourceOutMs))),
    speed: segment.speed,
  };
}

/**
 * Map a source time to an edited-timeline time. Returns null when that source
 * time falls inside a deleted range (not present in any kept segment). When the
 * source time is covered by multiple segments (e.g. after a split), the earliest
 * is used.
 */
export function sourceTimeToTimelineTime(
  segments: PreviewSegment[],
  sourceMs: number,
): number | null {
  for (const segment of segments) {
    if (sourceMs >= segment.sourceInMs && sourceMs < segment.sourceOutMs) {
      const timelineMs = segment.timelineInMs + (sourceMs - segment.sourceInMs) / segment.speed;
      return Math.round(timelineMs);
    }
  }
  // Exact end boundary of the last covering segment.
  for (const segment of segments) {
    if (sourceMs === segment.sourceOutMs) return segment.timelineOutMs;
  }
  return null;
}
