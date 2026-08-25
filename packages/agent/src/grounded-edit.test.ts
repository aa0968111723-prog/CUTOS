import { describe, expect, it } from "vitest";
import { proposeGroundedEdit } from "./grounded-edit.js";
import type { VisualObservation } from "./chat-response.js";

const observation: VisualObservation = {
  startMs: 24_000,
  endMs: 26_000,
  description: "畫面中央的女生抱著傳單",
  objects: ["傳單"],
  peopleDescriptions: ["畫面中央的女生"],
  textSeen: [],
  confidence: 0.9,
  frameRefs: [24_000, 25_000, 26_000],
};

describe("proposeGroundedEdit", () => {
  it("turns 「從這裡開始」 into a trim from the grounded frame", () => {
    const proposed = proposeGroundedEdit({
      instruction: "好，就從這裡開始。",
      observation,
      sourceDurationMs: 60_000,
    });
    expect(proposed).not.toBeNull();
    expect(proposed?.operations).toEqual([
      expect.objectContaining({ type: "trim", startMs: 25_000, endMs: 60_000 }),
    ]);
  });

  it("turns 「刪掉這一段」 into removeRange over the observation", () => {
    const proposed = proposeGroundedEdit({
      instruction: "刪掉這一段",
      observation,
      sourceDurationMs: 60_000,
    });
    expect(proposed?.operations).toEqual([
      expect.objectContaining({ type: "removeRange", startMs: 24_000, endMs: 26_000 }),
    ]);
  });
});
