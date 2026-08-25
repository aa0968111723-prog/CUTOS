import { describe, expect, it } from "vitest";
import { MemoryVisualIndexStore, searchVisualIndex, segmentFromObservation } from "./visual-search.js";
import type { VisualObservation } from "./chat-response.js";

describe("visual search index", () => {
  it("finds a cached segment without re-scanning", () => {
    const observation: VisualObservation = {
      startMs: 24_000,
      endMs: 26_000,
      description: "畫面中央的女生抱著大量傳單站在市集裡",
      objects: ["傳單", "女生"],
      peopleDescriptions: ["畫面中央的女生"],
      textSeen: [],
      confidence: 0.9,
      frameRefs: [25_000],
    };
    const store = new MemoryVisualIndexStore();
    store.addSegments("p", "sum", [segmentFromObservation(observation)]);
    const index = store.load("p", "sum");
    expect(index).toBeDefined();
    const hits = searchVisualIndex(index!, "女生抱傳單");
    expect(hits[0]?.segment.startMs).toBe(24_000);
  });
});
