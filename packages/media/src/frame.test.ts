import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./ffmpeg.js";
import { extractJpegFrame, frameObjectKey, sampleWindowTimes } from "./frame.js";
import { synthesizeSample } from "./sample.js";

describe("sampleWindowTimes", () => {
  it("samples 24.0–26.0 around 0:25 in 0.5s steps", () => {
    expect(
      sampleWindowTimes({
        centerMs: 25_000,
        beforeMs: 1_000,
        afterMs: 1_000,
        samples: 5,
        durationMs: 60_000,
      }),
    ).toEqual([24_000, 24_500, 25_000, 25_500, 26_000]);
  });

  it("clamps to the source duration", () => {
    const times = sampleWindowTimes({
      centerMs: 11_500,
      beforeMs: 1_000,
      afterMs: 1_000,
      samples: 5,
      durationMs: 12_000,
    });
    expect(times[0]).toBeGreaterThanOrEqual(0);
    expect(times[times.length - 1]).toBeLessThanOrEqual(12_000);
  });
});

describe("frameObjectKey", () => {
  it("never accepts a path-like checksum", () => {
    const key = frameObjectKey({
      projectId: "p1",
      mediaChecksum: "../../../etc/passwd",
      timeMs: 25000,
      width: 512,
    });
    expect(key).not.toContain("..");
    expect(key.startsWith("frames/")).toBe(true);
  });
});

describe("extractJpegFrame (ffmpeg)", () => {
  let dir = "";
  let sample = "";
  let available = false;

  beforeAll(async () => {
    try {
      await run("ffmpeg", ["-version"]);
      available = true;
    } catch {
      available = false;
    }
    dir = await mkdtemp(join(tmpdir(), "cutos-frame-"));
    sample = join(dir, "sample.mp4");
    if (available) await synthesizeSample(sample);
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("extracts a JPEG still from project media", async () => {
    if (!available) return;
    const frame = await extractJpegFrame(sample, 1_500, { width: 160 });
    expect(frame.mimeType).toBe("image/jpeg");
    expect(frame.jpeg[0]).toBe(0xff);
    expect(frame.jpeg[1]).toBe(0xd8);
    expect(frame.timeMs).toBe(1_500);
  }, 30_000);
});
