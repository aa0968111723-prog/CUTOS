import { describe, expect, it } from "vitest";
import { EDIT_DSL_VERSION, type EditPlan } from "@cutos/edit-dsl";
import { createTimeline, timelineDurationMs, type SourceMedia } from "./model.js";
import { applyOperation, applyPlan } from "./transforms.js";
import { TimelineHistory } from "./history.js";

const source: SourceMedia = {
  id: "src1",
  uri: "file:///tmp/src.mp4",
  durationMs: 12_000,
  hasAudio: true,
};

function planWith(operations: EditPlan["operations"]): EditPlan {
  return {
    version: EDIT_DSL_VERSION,
    id: "plan_test",
    createdAtMs: 0,
    instruction: "test",
    summary: "test",
    provider: "test",
    operations,
  };
}

describe("timeline model", () => {
  it("starts as a single clip spanning the whole source", () => {
    const tl = createTimeline(source);
    expect(tl.track.clips).toHaveLength(1);
    expect(timelineDurationMs(tl)).toBe(12_000);
  });
});

describe("removeRange", () => {
  it("ripple-removes an interior range and shortens the timeline", () => {
    const tl = createTimeline(source);
    const next = applyOperation(tl, { type: "removeRange", startMs: 3000, endMs: 5000 });
    expect(next.track.clips).toEqual([
      expect.objectContaining({ sourceInMs: 0, sourceOutMs: 3000 }),
      expect.objectContaining({ sourceInMs: 5000, sourceOutMs: 12_000 }),
    ]);
    expect(timelineDurationMs(next)).toBe(10_000);
  });

  it("does not mutate the input timeline (source immutable)", () => {
    const tl = createTimeline(source);
    applyOperation(tl, { type: "removeRange", startMs: 1000, endMs: 2000 });
    expect(tl.track.clips).toHaveLength(1);
    expect(tl.source.durationMs).toBe(12_000);
  });

  it("removes head and tail ranges", () => {
    const tl = createTimeline(source);
    let next = applyOperation(tl, { type: "removeRange", startMs: 0, endMs: 1000 });
    next = applyOperation(next, { type: "removeRange", startMs: 11_000, endMs: 12_000 });
    expect(timelineDurationMs(next)).toBe(10_000);
    expect(next.track.clips[0]?.sourceInMs).toBe(1000);
    expect(next.track.clips.at(-1)?.sourceOutMs).toBe(11_000);
  });
});

describe("setSpeed", () => {
  it("splits a clip and applies speed to the middle segment", () => {
    const tl = createTimeline(source);
    const next = applyOperation(tl, { type: "setSpeed", startMs: 4000, endMs: 8000, speed: 2 });
    expect(next.track.clips).toHaveLength(3);
    expect(next.track.clips[1]).toEqual(
      expect.objectContaining({ sourceInMs: 4000, sourceOutMs: 8000, speed: 2 }),
    );
    // 4s at 1x + 4s at 2x + 4s at 1x = 4000 + 2000 + 4000
    expect(timelineDurationMs(next)).toBe(10_000);
  });
});

describe("applyPlan replay determinism", () => {
  it("produces identical timelines when replayed", () => {
    const tl = createTimeline(source);
    const plan = planWith([
      { type: "removeRange", startMs: 2000, endMs: 3000 },
      { type: "removeRange", startMs: 6000, endMs: 7000 },
    ]);
    const a = applyPlan(tl, plan);
    const b = applyPlan(tl, plan);
    expect(a).toEqual(b);
    expect(timelineDurationMs(a)).toBe(10_000);
  });
});

describe("TimelineHistory undo/redo", () => {
  it("reverses and replays edits non-destructively", () => {
    const tl = createTimeline(source);
    const history = new TimelineHistory(tl);

    history.apply(planWith([{ type: "removeRange", startMs: 2000, endMs: 4000 }]));
    expect(timelineDurationMs(history.current)).toBe(10_000);
    expect(history.canUndo).toBe(true);

    history.undo();
    expect(timelineDurationMs(history.current)).toBe(12_000);
    expect(history.canRedo).toBe(true);

    history.redo();
    expect(timelineDurationMs(history.current)).toBe(10_000);
  });

  it("returns to the original baseline after undoing the only edit", () => {
    const tl = createTimeline(source);
    const history = new TimelineHistory(tl);
    history.apply(planWith([{ type: "removeRange", startMs: 0, endMs: 6000 }]));
    history.undo();
    expect(history.current).toEqual(tl);
    expect(history.canUndo).toBe(false);
  });
});
