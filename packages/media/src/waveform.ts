import { ffmpegBinary } from "./ffmpeg.js";
import type { Waveform } from "./analysis.js";

export interface WaveformOptions {
  /** Peaks produced per second of audio (resolution of the waveform). */
  peaksPerSecond?: number;
  /** Source duration in ms; if omitted it is derived from the decoded audio. */
  durationMs?: number;
}

const DECODE_SAMPLE_RATE = 8000;

/**
 * Compute a normalized (0..1) peak waveform by decoding audio to mono PCM and
 * reducing it into per-bucket peaks. Runs in a worker/job, not the request
 * path. The result is cacheable via the media checksum.
 */
export async function computeWaveform(
  filePath: string,
  options: WaveformOptions = {},
): Promise<Waveform> {
  const peaksPerSecond = options.peaksPerSecond ?? 10;
  const pcm = await ffmpegBinary([
    "-i",
    filePath,
    "-ac",
    "1",
    "-ar",
    String(DECODE_SAMPLE_RATE),
    "-f",
    "s16le",
    "-",
  ]);

  const sampleCount = Math.floor(pcm.byteLength / 2);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount);
  const durationMs = options.durationMs ?? Math.round((sampleCount / DECODE_SAMPLE_RATE) * 1000);
  const bucketCount = Math.max(1, Math.round((durationMs / 1000) * peaksPerSecond));
  const perBucket = Math.max(1, Math.floor(sampleCount / bucketCount));

  const peaks: number[] = [];
  for (let b = 0; b < bucketCount; b += 1) {
    const start = b * perBucket;
    const end = Math.min(sampleCount, start + perBucket);
    let peak = 0;
    for (let i = start; i < end; i += 1) {
      const v = Math.abs(samples[i] ?? 0) / 32768;
      if (v > peak) peak = v;
    }
    peaks.push(Number(peak.toFixed(4)));
  }

  return { peaksPerSecond, peaks };
}
