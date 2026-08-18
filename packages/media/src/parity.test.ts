import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyOperation, createTimeline, type SourceMedia, type Timeline } from "@cutos/timeline";
import { compileTimelineToPreview } from "@cutos/preview";
import { run } from "./ffmpeg.js";
import { synthesizeSample } from "./sample.js";
import { probe } from "./probe.js";
import { exportTimeline } from "./export.js";

/**
 * Preview/export parity: for the same timeline, the preview manifest duration
 * must match the real FFmpeg output duration. Because both derive from the same
 * `compileSegments`, this is guaranteed structurally; these tests verify it
 * against actual rendered media.
 */
describe("preview/export parity (ffmpeg)", () => {
  let dir = "";
  let available = false;
  let samplePath = "";
  let source: SourceMedia;

  beforeAll(async () => {
    try {
      await run("ffmpeg", ["-version"]);
      available = true;
    } catch {
      available = false;
    }
    dir = await mkdtemp(join(tmpdir(), "cutos-parity-"));
    samplePath = join(dir, "sample.mp4");
    if (available) {
      await synthesizeSample(samplePath);
      const info = await probe(samplePath);
      source = { id: "s", uri: samplePath, durationMs: info.durationMs, hasAudio: info.hasAudio };
    }
  }, 40_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function parity(name: string, build: (t: Timeline) => Timeline) {
    const timeline = build(createTimeline(source));
    const manifest = compileTimelineToPreview(timeline, { timelineRevision: 1 });
    const out = join(dir, `${name}.mp4`);
    const result = await exportTimeline({ inputPath: samplePath, timeline, outputPath: out });
    const info = await probe(out);
    // Model duration equals manifest duration by construction.
    expect(result.durationMs).toBe(manifest.durationMs);
    // Rendered duration matches the manifest within a small tolerance.
    expect(Math.abs(info.durationMs - manifest.durationMs)).toBeLessThan(1200);
  }

  it("parity across trim / delete / speed / mixed", async () => {
    if (!available) return;
    await parity("noedit", (t) => t);
    await parity("delete", (t) => applyOperation(t, { type: "removeRange", startMs: 3000, endMs: 6000 }));
    await parity("speed", (t) => applyOperation(t, { type: "setSpeed", startMs: 0, endMs: source.durationMs, speed: 2 }));
    await parity("mixed", (t) =>
      applyOperation(
        applyOperation(t, { type: "setSpeed", startMs: 6000, endMs: 12000, speed: 2 }),
        { type: "removeRange", startMs: 1500, endMs: 3000 },
      ),
    );
  }, 120_000);
});
