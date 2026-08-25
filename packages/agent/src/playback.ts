/**
 * Client-supplied playback awareness. The server validates every field — the
 * model is never asked to guess where "here" is.
 */

export interface SelectedRange {
  startMs: number;
  endMs: number;
}

export interface PlaybackContextInput {
  playheadMs?: number;
  selectedRange?: SelectedRange;
  previewMode?: "edited" | "original";
  timelineRevision?: number;
}

export interface PlaybackContext {
  playheadMs: number;
  selectedRange?: SelectedRange;
  previewMode: "edited" | "original";
  clientRevision?: number;
}

export function validatePlaybackContext(
  input: PlaybackContextInput | undefined,
  sourceDurationMs: number,
): PlaybackContext {
  const duration = Math.max(0, sourceDurationMs);
  const playheadMs = clampMs(input?.playheadMs, duration);
  const previewMode = input?.previewMode === "original" ? "original" : "edited";
  const selected = input?.selectedRange;
  let selectedRange: SelectedRange | undefined;
  if (selected && Number.isFinite(selected.startMs) && Number.isFinite(selected.endMs)) {
    const startMs = clampMs(selected.startMs, duration);
    const endMs = Math.max(startMs, clampMs(selected.endMs, duration));
    if (endMs > startMs) selectedRange = { startMs, endMs };
  }
  const clientRevision =
    typeof input?.timelineRevision === "number" && Number.isFinite(input.timelineRevision)
      ? Math.max(0, Math.round(input.timelineRevision))
      : undefined;
  return { playheadMs, selectedRange, previewMode, clientRevision };
}

function clampMs(value: number | undefined, durationMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.max(0, Math.min(durationMs, Math.round(value)));
}
