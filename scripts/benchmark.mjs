#!/usr/bin/env node
// CUTOS media pipeline benchmark.
//
// Measures the wall-clock cost of each media stage (synthesize/import, probe,
// silence detection, waveform decode, and an FFmpeg trim+concat export) for
// synthetic clips of configurable length. FFmpeg dominates these stages, so
// this benchmarks the real production bottleneck.
//
// Usage:
//   node scripts/benchmark.mjs [seconds...]
//   node scripts/benchmark.mjs 10 60 600     # 10s, 1min, 10min
//
// Defaults to 10s and 60s to stay fast in CI; pass larger values (e.g. 1800,
// 3600) to profile 30/60-minute media.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const durations = (process.argv.slice(2).map(Number).filter((n) => n > 0));
const targets = durations.length > 0 ? durations : [10, 60];

function runFfmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exit ${code}`))));
  });
}

async function time(label, fn) {
  const start = performance.now();
  await fn();
  return Math.round(performance.now() - start);
}

async function benchmark(seconds, dir) {
  const src = join(dir, `src_${seconds}.mp4`);
  const out = join(dir, `out_${seconds}.mp4`);
  const audioExpr = "0.35*sin(2*PI*440*t)*lt(mod(t\\,3)\\,1.5)";

  const synth = await time("synth", () =>
    runFfmpeg("ffmpeg", [
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${seconds}`,
      "-f", "lavfi", "-i", `aevalsrc=exprs=${audioExpr}:s=44100:d=${seconds}`,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-t", String(seconds), src,
    ]),
  );

  const probe = await time("probe", () =>
    runFfmpeg("ffprobe", ["-v", "error", "-show_format", "-show_streams", src]),
  );

  const silence = await time("silence", () =>
    runFfmpeg("ffmpeg", ["-hide_banner", "-nostdin", "-i", src, "-af", "silencedetect=noise=-30dB:d=0.7", "-f", "null", "-"]),
  );

  const waveform = await time("waveform", () =>
    runFfmpeg("ffmpeg", [
      "-hide_banner", "-nostdin", "-y", "-i", src,
      "-ac", "1", "-ar", "8000", "-f", "s16le", join(dir, `wf_${seconds}.raw`),
    ]),
  );

  // Export: remove the 1.5s silent gap in each 3s window (concatenated kept segments).
  const kept = [];
  for (let start = 0; start + 3 <= seconds; start += 3) kept.push([start, start + 1.5]);
  const parts = [];
  const vlabels = [];
  const alabels = [];
  kept.forEach(([s, e], i) => {
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
    vlabels.push(`[v${i}]`);
    alabels.push(`[a${i}]`);
  });
  const n = kept.length;
  const filter = `${parts.join(";")};${vlabels.map((v, i) => `${v}${alabels[i]}`).join("")}concat=n=${n}:v=1:a=1[vo][ao]`;
  const exportMs = await time("export", () =>
    runFfmpeg("ffmpeg", [
      "-hide_banner", "-nostdin", "-y", "-i", src,
      "-filter_complex", filter, "-map", "[vo]", "-map", "[ao]",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", out,
    ]),
  );

  return { seconds, synth, probe, silence, waveform, export: exportMs };
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "cutos-bench-"));
  try {
    const rows = [];
    for (const s of targets) {
      process.stderr.write(`benchmarking ${s}s clip...\n`);
      rows.push(await benchmark(s, dir));
    }
    console.log("\nCUTOS media pipeline benchmark (milliseconds)");
    console.log("clip(s) | synth | probe | silence | waveform | export");
    console.log("--------|-------|-------|---------|----------|-------");
    for (const r of rows) {
      console.log(
        `${String(r.seconds).padStart(7)} | ${String(r.synth).padStart(5)} | ${String(r.probe).padStart(5)} | ${String(r.silence).padStart(7)} | ${String(r.waveform).padStart(8)} | ${String(r.export).padStart(6)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
