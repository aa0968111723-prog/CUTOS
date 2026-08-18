import { secToMs } from "@cutos/edit-dsl";
import { ffprobe } from "./ffmpeg.js";

export interface ProbeResult {
  durationMs: number;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

/** Read duration and stream layout of a media file via ffprobe. */
export async function probe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await ffprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as FfprobeOutput;
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
