import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateEditPlan, EDIT_DSL_VERSION, type EditPlan } from "@cutos/edit-dsl";
import { applyPlan, createTimeline, timelineDurationMs } from "@cutos/timeline";
import { run } from "./ffmpeg.js";
import { synthesizeSample } from "./sample.js";
import { probe } from "./probe.js";
import { detectSilence } from "./silence.js";
import { exportTimeline } from "./export.js";

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

describe("media pipeline (ffmpeg integration)", () => {
  let dir = "";
  let available = false;

  beforeAll(async () => {
    available = await ffmpegAvailable();
    dir = await mkdtemp(join(tmpdir(), "cutos-media-"));
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("synthesizes, analyzes, edits and exports a shorter clip", async () => {
    if (!available) {
      // Environment without ffmpeg: nothing to validate here.
      return;
    }

    const samplePath = join(dir, "sample.mp4");
    await synthesizeSample(samplePath);

    const info = await probe(samplePath);
    expect(info.hasAudio).toBe(true);
    expect(info.durationMs).toBeGreaterThan(11_000);

    const silences = await detectSilence(samplePath, {
      thresholdDb: -30,
      minSilenceMs: 700,
      sourceDurationMs: info.durationMs,
    });
    expect(silences.length).toBeGreaterThanOrEqual(3);

    const timeline = createTimeline({
      id: "s",
      uri: samplePath,
      durationMs: info.durationMs,
      hasAudio: info.hasAudio,
    });

    const plan: EditPlan = {
      version: EDIT_DSL_VERSION,
      id: "p",
      createdAtMs: 0,
      instruction: "remove pauses",
      summary: "remove pauses",
      provider: "test",
      operations: silences.map((s) => ({ type: "removeRange", startMs: s.startMs, endMs: s.endMs })),
    };

    const validated = validateEditPlan(plan, { sourceDurationMs: info.durationMs });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const edited = applyPlan(timeline, validated.value);
    const expectedMs = timelineDurationMs(edited);
    expect(expectedMs).toBeLessThan(info.durationMs);

    const outPath = join(dir, "out.mp4");
    await exportTimeline({ inputPath: samplePath, timeline: edited, outputPath: outPath });

    const outInfo = await probe(outPath);
    // Rendered duration should be close to the timeline model's prediction.
    expect(Math.abs(outInfo.durationMs - expectedMs)).toBeLessThan(1500);
    expect(outInfo.durationMs).toBeLessThan(info.durationMs - 2000);
  }, 120_000);
});
