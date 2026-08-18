import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./ffmpeg.js";
import { synthesizeSample } from "./sample.js";
import { computeSpeechRegions, segmentIntoSentences } from "./transcription.js";
import { computeWaveform } from "./waveform.js";
import { runAnalysis } from "./analysis-runner.js";
import type { Word } from "./analysis.js";

describe("computeSpeechRegions", () => {
  it("returns the complement of silence", () => {
    const regions = computeSpeechRegions(
      [
        { startMs: 1500, endMs: 3000 },
        { startMs: 4500, endMs: 6000 },
      ],
      12_000,
    );
    expect(regions).toEqual([
      { startMs: 0, endMs: 1500 },
      { startMs: 3000, endMs: 4500 },
      { startMs: 6000, endMs: 12_000 },
    ]);
  });
});

describe("segmentIntoSentences", () => {
  it("splits on punctuation and long pauses", () => {
    const words: Word[] = [
      { startMs: 0, endMs: 300, text: "Hello" },
      { startMs: 320, endMs: 700, text: "there." },
      { startMs: 2000, endMs: 2300, text: "Next" },
      { startMs: 2320, endMs: 2600, text: "one" },
    ];
    const sentences = segmentIntoSentences(words, { maxGapMs: 600 });
    expect(sentences).toHaveLength(2);
    expect(sentences[0]?.text).toBe("Hello there.");
    expect(sentences[1]?.text).toBe("Next one");
  });
});

describe("media analysis (ffmpeg integration)", () => {
  let dir = "";
  let available = false;

  beforeAll(async () => {
    try {
      await run("ffmpeg", ["-version"]);
      available = true;
    } catch {
      available = false;
    }
    dir = await mkdtemp(join(tmpdir(), "cutos-analysis-"));
  }, 30_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("computes a waveform with normalized peaks", async () => {
    if (!available) return;
    const sample = join(dir, "sample.mp4");
    await synthesizeSample(sample);
    const wf = await computeWaveform(sample, { durationMs: 12_000, peaksPerSecond: 5 });
    expect(wf.peaks.length).toBeGreaterThan(30);
    expect(Math.max(...wf.peaks)).toBeGreaterThan(0);
    expect(Math.max(...wf.peaks)).toBeLessThanOrEqual(1);
  }, 60_000);

  it("runs an incremental analysis and reuses cached sections", async () => {
    if (!available) return;
    const sample = join(dir, "sample2.mp4");
    await synthesizeSample(sample);

    const first = await runAnalysis({
      filePath: sample,
      mediaChecksum: "abc",
      sections: ["metadata", "silences"],
    });
    expect(first.metadata?.durationMs).toBeGreaterThan(11_000);
    expect((first.silences ?? []).length).toBeGreaterThanOrEqual(3);

    // Re-run only transcript; prior sections are preserved (incremental).
    const second = await runAnalysis({
      filePath: sample,
      mediaChecksum: "abc",
      existing: first,
      sections: ["transcript"],
    });
    expect(second.metadata?.durationMs).toBe(first.metadata?.durationMs);
    expect(second.silences).toEqual(first.silences);
    expect((second.transcript?.sentences ?? []).length).toBeGreaterThan(0);
  }, 60_000);
});
