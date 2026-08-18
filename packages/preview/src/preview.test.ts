import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createTimeline,
  timelineDurationMs,
  type SourceMedia,
  type Timeline,
} from "@cutos/timeline";
import { compileSegments, previewDurationMs } from "./segments.js";
import {
  getActiveSegmentAt,
  sourceTimeToTimelineTime,
  timelineTimeToSourceTime,
} from "./mapping.js";
import { compileTimelineToPreview, getActiveCaptionsAt } from "./manifest.js";

const source: SourceMedia = {
  id: "s",
  uri: "storage://s",
  durationMs: 20_000,
  hasAudio: true,
};

const base = (): Timeline => createTimeline(source);

describe("compileSegments", () => {
  it("no edit → single full segment", () => {
    const segs = compileSegments(base());
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ sourceInMs: 0, sourceOutMs: 20_000, timelineInMs: 0, timelineOutMs: 20_000 });
    expect(previewDurationMs(segs)).toBe(20_000);
  });

  it("trim keeps only the requested range", () => {
    const t = applyOperation(base(), { type: "trim", startMs: 5_000, endMs: 15_000 });
    const segs = compileSegments(t);
    expect(previewDurationMs(segs)).toBe(10_000);
    expect(segs[0]).toMatchObject({ sourceInMs: 5_000, sourceOutMs: 15_000, timelineInMs: 0 });
  });

  it("delete middle → two segments", () => {
    const t = applyOperation(base(), { type: "removeRange", startMs: 5_000, endMs: 10_000 });
    const segs = compileSegments(t);
    expect(segs).toHaveLength(2);
    expect(segs[1]).toMatchObject({ sourceInMs: 10_000, sourceOutMs: 20_000, timelineInMs: 5_000, timelineOutMs: 15_000 });
    expect(previewDurationMs(segs)).toBe(15_000);
  });

  it("multiple deletes", () => {
    let t = applyOperation(base(), { type: "removeRange", startMs: 2_000, endMs: 4_000 });
    t = applyOperation(t, { type: "removeRange", startMs: 12_000, endMs: 14_000 });
    const segs = compileSegments(t);
    expect(previewDurationMs(segs)).toBe(16_000);
    expect(segs).toHaveLength(3);
  });

  it("split preserves duration", () => {
    const t = applyOperation(base(), { type: "split", atMs: 8_000 });
    const segs = compileSegments(t);
    expect(segs).toHaveLength(2);
    expect(previewDurationMs(segs)).toBe(20_000);
  });

  it("speed 2x shortens the timeline", () => {
    const t = applyOperation(base(), { type: "setSpeed", startMs: 10_000, endMs: 20_000, speed: 2 });
    const segs = compileSegments(t);
    // [0,10]@1 (10s) + [10,20]@2 (5s) = 15s
    expect(previewDurationMs(segs)).toBe(15_000);
    expect(segs[1]).toMatchObject({ speed: 2, timelineInMs: 10_000, timelineOutMs: 15_000 });
  });

  it("preview duration always equals timeline duration (parity)", () => {
    const cases: Timeline[] = [
      base(),
      applyOperation(base(), { type: "removeRange", startMs: 5_000, endMs: 10_000 }),
      applyOperation(base(), { type: "trim", startMs: 3_000, endMs: 17_000 }),
      applyOperation(base(), { type: "setSpeed", startMs: 0, endMs: 20_000, speed: 4 }),
      applyOperation(
        applyOperation(base(), { type: "setSpeed", startMs: 10_000, endMs: 20_000, speed: 2 }),
        { type: "removeRange", startMs: 2_000, endMs: 4_000 },
      ),
    ];
    for (const t of cases) {
      expect(previewDurationMs(compileSegments(t))).toBe(timelineDurationMs(t));
    }
  });
});

describe("time mapping", () => {
  it("maps edited time to source across a deleted range", () => {
    const t = applyOperation(base(), { type: "removeRange", startMs: 5_000, endMs: 10_000 });
    const segs = compileSegments(t);
    // edited 6s → source 11s
    expect(timelineTimeToSourceTime(segs, 6_000)?.sourceMs).toBe(11_000);
    // round trip
    expect(sourceTimeToTimelineTime(segs, 11_000)).toBe(6_000);
  });

  it("returns null for a deleted source time", () => {
    const t = applyOperation(base(), { type: "removeRange", startMs: 5_000, endMs: 10_000 });
    const segs = compileSegments(t);
    expect(sourceTimeToTimelineTime(segs, 7_000)).toBeNull();
  });

  it("is speed-aware", () => {
    const t = applyOperation(base(), { type: "setSpeed", startMs: 10_000, endMs: 20_000, speed: 2 });
    const segs = compileSegments(t);
    // edited 12s is 2s into the 2x segment → source 10 + 2*2 = 14s
    expect(timelineTimeToSourceTime(segs, 12_000)?.sourceMs).toBe(14_000);
    expect(sourceTimeToTimelineTime(segs, 14_000)).toBe(12_000);
  });

  it("handles exact boundaries and last frame", () => {
    const t = applyOperation(base(), { type: "removeRange", startMs: 5_000, endMs: 10_000 });
    const segs = compileSegments(t);
    expect(getActiveSegmentAt(segs, 5_000)?.index).toBe(1);
    expect(getActiveSegmentAt(segs, 14_999)?.index).toBe(1);
    // Clamp at/after end.
    expect(getActiveSegmentAt(segs, 15_000)?.index).toBe(1);
  });
});

describe("compileTimelineToPreview", () => {
  it("maps captions and markers into edited time and drops deleted ones", () => {
    let t = applyOperation(base(), { type: "caption", startMs: 1_000, endMs: 3_000, text: "hi" });
    t = applyOperation(t, { type: "marker", atMs: 12_000, label: "m" });
    // Delete 5-10 (does not touch the caption at 1-3 or marker at 12).
    t = applyOperation(t, { type: "removeRange", startMs: 5_000, endMs: 10_000 });
    const manifest = compileTimelineToPreview(t, { timelineRevision: 3 });
    expect(manifest.timelineRevision).toBe(3);
    expect(manifest.durationMs).toBe(15_000);
    expect(manifest.captions).toHaveLength(1);
    expect(manifest.captions[0]).toMatchObject({ startMs: 1_000, endMs: 3_000 });
    // Marker at source 12 → edited 7 (after removing 5s before it).
    expect(manifest.markers[0]?.atMs).toBe(7_000);
    expect(getActiveCaptionsAt(manifest, 2_000)).toHaveLength(1);
  });

  it("drops a caption whose source content was removed", () => {
    let t = applyOperation(base(), { type: "caption", startMs: 6_000, endMs: 8_000, text: "gone" });
    t = applyOperation(t, { type: "removeRange", startMs: 5_000, endMs: 10_000 });
    const manifest = compileTimelineToPreview(t, { timelineRevision: 2 });
    expect(manifest.captions).toHaveLength(0);
  });
});
