import { secToMs } from "@cutos/edit-dsl";
import { ffmpeg } from "./ffmpeg.js";

export interface SilenceInterval {
  startMs: number;
  endMs: number;
}

export interface DetectSilenceOptions {
  /** Silence threshold in dBFS (e.g. -30). Louder audio is treated as speech. */
  thresholdDb?: number;
  /** Minimum silence duration to report, in milliseconds. */
  minSilenceMs?: number;
  /**
   * Source duration in milliseconds. When provided, reported intervals are
   * clamped to [0, durationMs]. FFmpeg can report a trailing silence a few
   * milliseconds past the container duration, which would otherwise produce
   * edit ranges that fail validation against the immutable source.
   */
  sourceDurationMs?: number;
}

const SILENCE_START_RE = /silence_start:\s*(-?\d+(?:\.\d+)?)/;
const SILENCE_END_RE = /silence_end:\s*(-?\d+(?:\.\d+)?)/;

/**
 * Detect silent intervals using FFmpeg's `silencedetect` filter. This is the
 * kind of media analysis that belongs in a worker/job rather than a UI request
 * path; the returned intervals feed the agent's Edit Plan.
 */
export async function detectSilence(
  filePath: string,
  options: DetectSilenceOptions = {},
): Promise<SilenceInterval[]> {
  const thresholdDb = options.thresholdDb ?? -30;
  const minSilenceMs = options.minSilenceMs ?? 700;
  const minSilenceSec = (minSilenceMs / 1000).toFixed(3);

  const { stderr } = await ffmpeg([
    "-i",
    filePath,
    "-af",
    `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`,
    "-f",
    "null",
    "-",
  ]);

  const intervals: SilenceInterval[] = [];
  let pendingStartMs: number | null = null;
  const maxMs = options.sourceDurationMs;

  for (const line of stderr.split("\n")) {
    const startMatch = SILENCE_START_RE.exec(line);
    if (startMatch?.[1] !== undefined) {
      pendingStartMs = secToMs(Math.max(0, Number.parseFloat(startMatch[1])));
      continue;
    }
    const endMatch = SILENCE_END_RE.exec(line);
    if (endMatch?.[1] !== undefined && pendingStartMs !== null) {
      let startMs = pendingStartMs;
      let endMs = secToMs(Number.parseFloat(endMatch[1]));
      if (maxMs !== undefined) {
        startMs = Math.min(startMs, maxMs);
        endMs = Math.min(endMs, maxMs);
      }
      if (endMs > startMs) {
        intervals.push({ startMs, endMs });
      }
      pendingStartMs = null;
    }
  }

  return intervals;
}
