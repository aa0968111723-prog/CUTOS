import { z } from "zod";

/**
 * All timeline coordinates are integer milliseconds in the ORIGINAL source
 * timebase. Using an integer, source-relative unit keeps operations
 * deterministic and replayable, and keeps source media immutable: we only ever
 * reference ranges of the source, never rewrite it.
 */
export type TimeMs = number;

export const TimeMsSchema = z
  .number()
  .int("time must be an integer number of milliseconds")
  .min(0, "time must be non-negative");

export function secToMs(seconds: number): TimeMs {
  return Math.round(seconds * 1000);
}

export function msToSec(ms: TimeMs): number {
  return ms / 1000;
}

export function clampMs(value: number, minMs: TimeMs, maxMs: TimeMs): TimeMs {
  return Math.max(minMs, Math.min(maxMs, Math.round(value)));
}

/** Format milliseconds as mm:ss.mmm for human-readable review cards. */
export function formatTimecode(ms: TimeMs): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const mmm = String(millis).padStart(3, "0");
  return `${mm}:${ss}.${mmm}`;
}
