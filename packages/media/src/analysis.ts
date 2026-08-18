import { z } from "zod";
import { TimeMsSchema } from "@cutos/edit-dsl";

/**
 * Unified video-intelligence model. Every timestamp is integer milliseconds in
 * the original source timebase — modules never pass around float seconds.
 *
 * The analysis is:
 *  - cacheable + versioned: `analysisVersion` + `mediaChecksum` identify it,
 *  - incremental: each section is independent and optional, so re-running the
 *    transcript never forces a re-probe,
 *  - re-runnable: a section can be replaced without touching the others.
 */
export const ANALYSIS_VERSION = 1 as const;

export const VideoMetadataSchema = z.object({
  durationMs: TimeMsSchema,
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  container: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;

export const SilenceSchema = z.object({
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
});
export type Silence = z.infer<typeof SilenceSchema>;

export const WaveformSchema = z.object({
  /** Number of peaks per second of audio. */
  peaksPerSecond: z.number().positive(),
  /** Normalized 0..1 amplitude peaks. */
  peaks: z.array(z.number().min(0).max(1)),
});
export type Waveform = z.infer<typeof WaveformSchema>;

export const WordSchema = z.object({
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
  text: z.string(),
});
export type Word = z.infer<typeof WordSchema>;

/** A transcript sentence/segment with optional word-level timing and speaker. */
export const SentenceSchema = z.object({
  id: z.string().min(1),
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
  text: z.string(),
  speaker: z.string().nullable(),
  words: z.array(WordSchema).optional(),
});
export type Sentence = z.infer<typeof SentenceSchema>;

export const TranscriptSchema = z.object({
  language: z.string().nullable(),
  provider: z.string(),
  sentences: z.array(SentenceSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const SceneSchema = z.object({
  startMs: TimeMsSchema,
  endMs: TimeMsSchema,
});
export type Scene = z.infer<typeof SceneSchema>;

export const VideoAnalysisSchema = z.object({
  analysisVersion: z.literal(ANALYSIS_VERSION),
  /** Ties the analysis to a specific media file for caching/invalidation. */
  mediaChecksum: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
  metadata: VideoMetadataSchema.optional(),
  waveform: WaveformSchema.optional(),
  silences: z.array(SilenceSchema).optional(),
  transcript: TranscriptSchema.optional(),
  scenes: z.array(SceneSchema).optional(),
});
export type VideoAnalysis = z.infer<typeof VideoAnalysisSchema>;

/** The independently-computable analysis sections (for incremental runs). */
export type AnalysisSection = "metadata" | "waveform" | "silences" | "transcript" | "scenes";

export function emptyAnalysis(mediaChecksum: string, now: number): VideoAnalysis {
  return { analysisVersion: ANALYSIS_VERSION, mediaChecksum, updatedAt: now };
}
