import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ffmpeg } from "./ffmpeg.js";

/**
 * Synthesize a deterministic demo clip: a 12s test pattern with a 440Hz tone
 * that is present for the first 1.5s of every 3s window and silent otherwise.
 * This produces clean, repeatable silence intervals for the pause-removal
 * vertical slice without shipping binary media in the repo.
 *
 * Idempotent: if the file already exists it is left untouched.
 */
export async function synthesizeSample(outputPath: string): Promise<string> {
  try {
    await access(outputPath);
    return outputPath;
  } catch {
    // Not present yet — generate it below.
  }

  await mkdir(dirname(outputPath), { recursive: true });

  // Commas inside the expression are escaped so FFmpeg does not treat them as
  // filterchain separators.
  const audioExpr = "0.35*sin(2*PI*440*t)*lt(mod(t\\,3)\\,1.5)";

  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30:duration=12",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=exprs=${audioExpr}:s=44100:d=12`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-t",
    "12",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ]);

  return outputPath;
}
