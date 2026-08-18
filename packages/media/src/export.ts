import { clipOutputDurationMs, timelineDurationMs, type Clip, type Timeline } from "@cutos/timeline";
import { ffmpeg } from "./ffmpeg.js";

export interface ExportParams {
  /** Path to the immutable source media. */
  inputPath: string;
  timeline: Timeline;
  outputPath: string;
}

export interface ExportResult {
  outputPath: string;
  /** Expected output duration derived from the timeline model. */
  durationMs: number;
}

/**
 * Decompose an arbitrary tempo factor into a chain of `atempo` filters, each in
 * FFmpeg's supported [0.5, 2.0] range, whose product equals the factor.
 */
function atempoChain(speed: number): string {
  const factors: number[] = [];
  let remaining = speed;
  while (remaining > 2.0 + 1e-9) {
    factors.push(2.0);
    remaining /= 2.0;
  }
  while (remaining < 0.5 - 1e-9) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(Number(remaining.toFixed(6)));
  return factors.map((f) => `atempo=${f}`).join(",");
}

function sec(ms: number): string {
  return (ms / 1000).toFixed(3);
}

interface FilterGraph {
  filterComplex: string;
  videoLabel: string;
  audioLabel: string | null;
}

function buildFilterGraph(clips: Clip[], hasAudio: boolean): FilterGraph {
  const parts: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];

  clips.forEach((clip, i) => {
    const start = sec(clip.sourceInMs);
    const end = sec(clip.sourceOutMs);
    const v = `v${i}`;
    parts.push(
      `[0:v]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${clip.speed}[${v}]`,
    );
    videoLabels.push(`[${v}]`);

    if (hasAudio) {
      const a = `a${i}`;
      parts.push(
        `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${atempoChain(clip.speed)}[${a}]`,
      );
      audioLabels.push(`[${a}]`);
    }
  });

  const n = clips.length;
  if (hasAudio) {
    parts.push(
      `${videoLabels.map((v, i) => `${v}${audioLabels[i]}`).join("")}concat=n=${n}:v=1:a=1[vout][aout]`,
    );
    return { filterComplex: parts.join(";"), videoLabel: "[vout]", audioLabel: "[aout]" };
  }

  parts.push(`${videoLabels.join("")}concat=n=${n}:v=1:a=0[vout]`);
  return { filterComplex: parts.join(";"), videoLabel: "[vout]", audioLabel: null };
}

/**
 * Deterministically render a timeline to a new file with FFmpeg. The source is
 * only ever read; all edits are expressed as trim/concat/tempo of source
 * ranges, so the original media is never mutated.
 */
export async function exportTimeline(params: ExportParams): Promise<ExportResult> {
  const clips = params.timeline.track.clips.filter(
    (c) => clipOutputDurationMs(c) > 0,
  );
  if (clips.length === 0) {
    throw new Error("Cannot export an empty timeline (all content was removed).");
  }

  const hasAudio = params.timeline.source.hasAudio;
  const graph = buildFilterGraph(clips, hasAudio);

  const args = [
    "-y",
    "-i",
    params.inputPath,
    "-filter_complex",
    graph.filterComplex,
    "-map",
    graph.videoLabel,
  ];
  if (graph.audioLabel) {
    args.push("-map", graph.audioLabel, "-c:a", "aac", "-b:a", "128k");
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    params.outputPath,
  );

  await ffmpeg(args);

  return {
    outputPath: params.outputPath,
    durationMs: timelineDurationMs(params.timeline),
  };
}
