import {
  ANALYSIS_VERSION,
  emptyAnalysis,
  type AnalysisSection,
  type VideoAnalysis,
} from "./analysis.js";
import { probeMetadata } from "./probe.js";
import { detectSilence } from "./silence.js";
import { computeWaveform } from "./waveform.js";
import { SilenceSegmentTranscriber, type Transcriber } from "./transcription.js";

export interface RunAnalysisInput {
  filePath: string;
  /** Checksum of the media; ties the analysis to a specific file for caching. */
  mediaChecksum: string;
  /** Which sections to (re)compute this run. */
  sections: AnalysisSection[];
  /** Prior analysis to build on incrementally (sections not requested are kept). */
  existing?: VideoAnalysis;
  transcriber?: Transcriber;
  silenceOptions?: { thresholdDb?: number; minSilenceMs?: number };
  now?: number;
  onSection?: (section: AnalysisSection) => void;
}

/**
 * Compute the requested analysis sections and merge them into the existing
 * analysis. Cacheable (keyed by `mediaChecksum` + `analysisVersion`),
 * incremental (only requested sections run) and re-runnable (a section can be
 * recomputed without touching the others). Re-running the transcript never
 * forces a re-probe.
 */
export async function runAnalysis(input: RunAnalysisInput): Promise<VideoAnalysis> {
  const now = input.now ?? Date.now();
  const reusable =
    input.existing &&
    input.existing.mediaChecksum === input.mediaChecksum &&
    input.existing.analysisVersion === ANALYSIS_VERSION;

  let analysis: VideoAnalysis = reusable
    ? { ...input.existing!, updatedAt: now }
    : emptyAnalysis(input.mediaChecksum, now);

  // Ensure we have metadata (needed by other sections); cache it if fresh.
  let metadata = analysis.metadata;
  if (!metadata) {
    metadata = await probeMetadata(input.filePath);
    analysis = { ...analysis, metadata };
  }
  const durationMs = metadata.durationMs;

  for (const section of input.sections) {
    input.onSection?.(section);
    switch (section) {
      case "metadata": {
        analysis = { ...analysis, metadata: await probeMetadata(input.filePath) };
        break;
      }
      case "silences": {
        const silences = await detectSilence(input.filePath, {
          thresholdDb: input.silenceOptions?.thresholdDb ?? -30,
          minSilenceMs: input.silenceOptions?.minSilenceMs ?? 700,
          sourceDurationMs: durationMs,
        });
        analysis = { ...analysis, silences };
        break;
      }
      case "waveform": {
        if (metadata.hasAudio) {
          analysis = {
            ...analysis,
            waveform: await computeWaveform(input.filePath, { durationMs }),
          };
        }
        break;
      }
      case "transcript": {
        const transcriber = input.transcriber ?? new SilenceSegmentTranscriber();
        analysis = {
          ...analysis,
          transcript: await transcriber.transcribe(input.filePath, {
            durationMs,
            silences: analysis.silences,
          }),
        };
        break;
      }
      case "scenes": {
        // Scene/shot detection is modeled but not yet implemented; skip cleanly.
        break;
      }
    }
  }

  return { ...analysis, updatedAt: now };
}
