import type { EditContext } from "./context.js";
import type { ExtractedFrame, TranscriptSlice, VideoContextPacket } from "./vision.js";

const WINDOW_MS = 3_000;

export function sliceTranscript(
  sentences: { startMs: number; endMs: number; text: string; speaker?: string | null }[] | undefined,
  startMs: number,
  endMs: number,
): TranscriptSlice[] {
  if (!sentences) return [];
  return sentences
    .filter((s) => s.endMs > startMs && s.startMs < endMs)
    .map((s) => ({
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      speaker: s.speaker ?? null,
    }));
}

export function buildVideoContextPacket(input: {
  projectId: string;
  centerMs: number;
  frames: ExtractedFrame[];
  context: EditContext;
}): VideoContextPacket {
  const { projectId, centerMs, frames, context } = input;
  const sentences = context.transcriptSentences;
  const before = sliceTranscript(sentences, Math.max(0, centerMs - WINDOW_MS), centerMs);
  const current = sliceTranscript(sentences, Math.max(0, centerMs - 500), centerMs + 500);
  const after = sliceTranscript(sentences, centerMs, centerMs + WINDOW_MS);
  const speaker = current[0]?.speaker ?? before[before.length - 1]?.speaker ?? null;
  const scene =
    context.scenes?.find((s) => s.startMs <= centerMs && centerMs < s.endMs) ??
    context.scenes?.find((s) => s.startMs <= centerMs && s.endMs >= centerMs) ??
    null;
  return {
    projectId,
    centerMs,
    frames,
    transcriptBefore: before,
    transcriptCurrent: current,
    transcriptAfter: after,
    speaker: speaker ?? null,
    topic: context.topics?.[0] ?? null,
    scene,
    timelineRevision: context.timelineRevision,
  };
}

export function defaultInspectWindow(centerMs: number): {
  centerMs: number;
  beforeMs: number;
  afterMs: number;
  samples: number;
} {
  return { centerMs, beforeMs: 1000, afterMs: 1000, samples: 5 };
}
