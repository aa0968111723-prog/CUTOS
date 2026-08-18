import { spawn } from "node:child_process";

const FFMPEG_BIN = process.env.CUTOS_FFMPEG_PATH ?? "ffmpeg";
const FFPROBE_BIN = process.env.CUTOS_FFPROBE_PATH ?? "ffprobe";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Low-level process runner. All FFmpeg/FFprobe invocations go through here so
 * media logic never shells out ad hoc and arguments are always passed as an
 * argv array (no shell string interpolation).
 */
export function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${bin} exited with code ${code}\n${stderr.slice(-2000)}`));
      }
    });
  });
}

export function ffmpeg(args: string[]): Promise<RunResult> {
  return run(FFMPEG_BIN, ["-hide_banner", "-nostdin", ...args]);
}

export function ffprobe(args: string[]): Promise<RunResult> {
  return run(FFPROBE_BIN, ["-hide_banner", ...args]);
}

/**
 * Run FFmpeg and capture stdout as raw bytes (for piping decoded PCM/frames).
 * stderr is captured as text for error reporting.
 */
export function ffmpegBinary(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, ["-hide_banner", "-nostdin", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with code ${code}\n${stderr.slice(-2000)}`));
    });
  });
}
