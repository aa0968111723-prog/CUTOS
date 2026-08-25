import { ffmpegBinary } from "./ffmpeg.js";
import type { MediaAsset } from "./asset.js";

export const DEFAULT_FRAME_WIDTH = 512;

export interface FrameCacheKey {
  projectId: string;
  mediaChecksum: string;
  timeMs: number;
  width: number;
}

/**
 * Storage key for a cached JPEG. Keys are opaque and traversal-safe: only
 * [a-zA-Z0-9._-] survive, so a caller cannot smuggle a filesystem path.
 */
export function frameObjectKey(key: FrameCacheKey): string {
  const projectId = sanitizeSegment(key.projectId);
  const checksum = sanitizeSegment(key.mediaChecksum);
  const timeMs = Math.max(0, Math.round(key.timeMs));
  const width = Math.max(16, Math.round(key.width));
  return `frames/${projectId}/${checksum}/${timeMs}_${width}.jpg`;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!cleaned) throw new Error("Invalid frame cache key segment");
  return cleaned;
}

export function sampleWindowTimes(input: {
  centerMs: number;
  beforeMs: number;
  afterMs: number;
  samples: number;
  durationMs: number;
}): number[] {
  const duration = Math.max(0, Math.round(input.durationMs));
  const clamp = (ms: number) => Math.max(0, Math.min(duration, Math.round(ms)));
  const center = clamp(input.centerMs);
  const samples = Math.max(1, Math.round(input.samples));
  if (samples === 1 || duration === 0) return [center];
  const start = clamp(center - Math.max(0, input.beforeMs));
  const end = clamp(center + Math.max(0, input.afterMs));
  if (end <= start) return [center];
  const times: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < samples; i += 1) {
    const t = clamp(start + ((end - start) * i) / (samples - 1));
    if (!seen.has(t)) {
      seen.add(t);
      times.push(t);
    }
  }
  if (!seen.has(center)) {
    times.push(center);
    times.sort((a, b) => a - b);
  }
  return times;
}

export interface ExtractedJpeg {
  timeMs: number;
  mimeType: "image/jpeg";
  width: number;
  jpeg: Buffer;
}

/**
 * Low-level FFmpeg still extraction. Callers MUST pass a path obtained from
 * StorageAdapter.withLocalFile for a MediaAsset — never a user-supplied path.
 */
export async function extractJpegFrame(
  filePath: string,
  timeMs: number,
  options: { width?: number } = {},
): Promise<ExtractedJpeg> {
  const width = options.width ?? DEFAULT_FRAME_WIDTH;
  const seconds = (Math.max(0, timeMs) / 1000).toFixed(3);
  const jpeg = await ffmpegBinary([
    "-ss",
    seconds,
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:-2`,
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-q:v",
    "3",
    "-",
  ]);
  if (jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("ffmpeg did not return a JPEG frame");
  }
  return { timeMs: Math.max(0, Math.round(timeMs)), mimeType: "image/jpeg", width, jpeg };
}

export async function extractJpegWindow(
  filePath: string,
  input: {
    centerMs: number;
    beforeMs: number;
    afterMs: number;
    samples: number;
    durationMs: number;
    width?: number;
  },
): Promise<ExtractedJpeg[]> {
  const times = sampleWindowTimes(input);
  const frames: ExtractedJpeg[] = [];
  for (const timeMs of times) {
    frames.push(await extractJpegFrame(filePath, timeMs, { width: input.width }));
  }
  return frames;
}

/** Guard used by the service layer: only a MediaAsset may be decoded. */
export function assertProjectAsset(asset: MediaAsset, projectId: string): void {
  if (asset.projectId !== projectId) {
    throw new Error("MediaAsset does not belong to this project");
  }
  if (asset.kind !== "original" && asset.kind !== "proxy") {
    throw new Error("Frames may only be extracted from original or proxy media");
  }
}
