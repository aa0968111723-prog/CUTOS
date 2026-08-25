import { describe, expect, it } from "vitest";
import { classifyIntent } from "./intent.js";

describe("classifyIntent", () => {
  it("treats a bare clock as inspect_time, not an edit", () => {
    const intent = classifyIntent("0:25");
    expect(intent.primary).toBe("inspect_time");
    expect(intent.needsEditPlan).toBe(false);
    expect(intent.timeRefs.some((r) => r.kind === "absolute" && r.ms === 25_000)).toBe(true);
  });

  it("classifies 「0:25 那邊你看得到嗎」 as inspect + question, never edit", () => {
    const intent = classifyIntent("0:25 那邊你看得到嗎");
    expect(intent.needsEditPlan).toBe(false);
    expect(intent.needsVision).toBe(true);
    expect([intent.primary, ...intent.secondary]).toEqual(
      expect.arrayContaining(["inspect_time", "ask_video_question"]),
    );
  });

  it("classifies 「25秒那個女生手上拿什麼」 as a timed visual question", () => {
    const intent = classifyIntent("25秒那個女生手上拿什麼");
    expect(intent.needsEditPlan).toBe(false);
    expect(intent.needsVision).toBe(true);
    expect([intent.primary, ...intent.secondary]).toEqual(
      expect.arrayContaining(["inspect_time", "ask_video_question"]),
    );
  });

  it("classifies 「剛剛那一幕是在做什麼」 as current-frame inspection", () => {
    const intent = classifyIntent("剛剛那一幕是在做什麼");
    expect(intent.needsEditPlan).toBe(false);
    expect([intent.primary, ...intent.secondary]).toEqual(
      expect.arrayContaining(["inspect_current_frame", "ask_video_question"]),
    );
  });

  it("classifies 「哪裡有女生抱著傳單」 as visual search", () => {
    const intent = classifyIntent("哪裡有女生抱著傳單");
    expect(intent.primary).toBe("semantic_search");
    expect(intent.needsEditPlan).toBe(false);
    expect(intent.needsVision).toBe(true);
  });

  it("classifies 「從女生抱傳單這裡開始」 as an edit that needs a visual lookup", () => {
    const intent = classifyIntent("從女生抱傳單這裡開始");
    expect(intent.needsEditPlan).toBe(true);
    expect([intent.primary, ...intent.secondary]).toContain("edit");
    expect([intent.primary, ...intent.secondary]).toContain("semantic_search");
  });

  it("classifies 「刪掉這一段」 as edit", () => {
    const intent = classifyIntent("刪掉這一段");
    expect(intent.primary).toBe("edit");
    expect(intent.needsEditPlan).toBe(true);
  });

  it("classifies 「從這裡開始」 as edit", () => {
    const intent = classifyIntent("從這裡開始");
    expect(intent.primary).toBe("edit");
    expect(intent.needsEditPlan).toBe(true);
  });

  it("does not treat 「這幕可以留下嗎」 as an immediate edit", () => {
    const intent = classifyIntent("這幕可以留下嗎");
    expect(intent.needsEditPlan).toBe(false);
    expect(intent.needsVision).toBe(true);
  });
});
