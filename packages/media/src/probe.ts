import { secToMs } from "@cutos/edit-dsl";
import { ffprobe } from "./ffmpeg.js";
import type { VideoMetadata } from "./analysis.js";

export interface ProbeResult {
  durationMs: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string; size?: string };
  streams?: FfprobeStream[];
}

async function rawProbe(filePath: string): Promise<FfprobeOutput> {
  const { stdout } = await ffprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  return JSON.parse(stdout) as FfprobeOutput;
}

/** Read duration and stream layout of a media file via ffprobe. */
export async function probe(filePath: string): Promise<ProbeResult> {
  const parsed = await rawProbe(filePath);
  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const durationSec = Number.parseFloat(parsed.format?.duration ?? "0");

  return {
    durationMs: Number.isFinite(durationSec) ? secToMs(durationSec) : 0,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    hasVideo: Boolean(videoStream),
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
  };
}

/** Full metadata section for the unified analysis model. */
export async function probeMetadata(filePath: string): Promise<VideoMetadata> {
  const parsed = await rawProbe(filePath);
  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");
  const durationSec = Number.parseFloat(parsed.format?.duration ?? "0");
  const size = parsed.format?.size ? Number.parseInt(parsed.format.size, 10) : null;

  return {
    durationMs: Number.isFinite(durationSec) ? secToMs(durationSec) : 0,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    container: parsed.format?.format_name ?? null,
    sizeBytes: size !== null && Number.isFinite(size) ? size : null,
  };
}
