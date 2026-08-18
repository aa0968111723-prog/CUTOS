import { describe, expect, it } from "vitest";
import { EDIT_DSL_VERSION, type EditPlan } from "@cutos/edit-dsl";
import { createTimeline, timelineDurationMs, type SourceMedia } from "./model.js";
import { applyOperation, UnsupportedOperationError } from "./transforms.js";
import { TimelineHistory } from "./history.js";
import { toSequence } from "./sequence.js";

const source: SourceMedia = {
  id: "s",
  uri: "storage://s",
  durationMs: 12_000,
  hasAudio: true,
};

function planWith(operations: EditPlan["operations"]): EditPlan {
  return {
    version: EDIT_DSL_VERSION,
    id: "p",
    createdAtMs: 0,
    instruction: "x",
    summary: "x",
    provider: "test",
    operations,
  };
}

describe("timeline v2 operations", () => {
  it("trim keeps only the requested range", () => {
    const t = applyOperation(createTimeline(source), { type: "trim", startMs: 2000, endMs: 8000 });
    expect(timelineDurationMs(t)).toBe(6000);
    expect(t.track.clips[0]?.sourceInMs).toBe(2000);
    expect(t.track.clips.at(-1)?.sourceOutMs).toBe(8000);
  });

  it("split divides a clip without changing duration", () => {
    const t = applyOperation(createTimeline(source), { type: "split", atMs: 5000 });
    expect(t.track.clips).toHaveLength(2);
    expect(timelineDurationMs(t)).toBe(12_000);
  });

  it("caption and marker attach annotations", () => {
    let t = applyOperation(createTimeline(source), {
      type: "caption",
      startMs: 0,
      endMs: 2000,
      text: "Intro",
    });
    t = applyOperation(t, { type: "marker", atMs: 6000, label: "Highlight" });
    expect(t.captions).toHaveLength(1);
    expect(t.markers).toHaveLength(1);
  });

  it("throws for modeled-but-unimplemented operations", () => {
    expect(() =>
      applyOperation(createTimeline(source), { type: "reframe", aspect: "9:16" }),
    ).toThrow(UnsupportedOperationError);
  });
});

describe("timeline history serialization", () => {
  it("round-trips undo/redo state across a restore", () => {
    const h = new TimelineHistory(createTimeline(source));
    h.apply(planWith([{ type: "removeRange", startMs: 2000, endMs: 4000 }]));
    h.apply(planWith([{ type: "removeRange", startMs: 8000, endMs: 9000 }]));
    h.undo();
    const snapshot = h.serialize();

    const restored = TimelineHistory.restore(snapshot);
    expect(restored.revision).toBe(h.revision);
    expect(timelineDurationMs(restored.current)).toBe(timelineDurationMs(h.current));
    expect(restored.canRedo).toBe(true);
    restored.redo();
    expect(timelineDurationMs(restored.current)).toBe(9000);
  });
});

describe("sequence projection", () => {
  it("projects clips, captions and markers into multi-track sequence", () => {
    let t = createTimeline(source);
    t = applyOperation(t, { type: "caption", startMs: 0, endMs: 1000, text: "hi" });
    t = applyOperation(t, { type: "marker", atMs: 5000, label: "m" });
    const seq = toSequence(t);
    const kinds = seq.tracks.map((tr) => tr.kind);
    expect(kinds).toContain("video");
    expect(kinds).toContain("audio");
    expect(kinds).toContain("caption");
    expect(kinds).toContain("marker");
    expect(seq.durationMs).toBe(12_000);
  });
});
