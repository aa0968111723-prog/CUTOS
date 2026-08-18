import { describe, expect, it } from "vitest";
import { validateEditPlan } from "./validate.js";
import { EDIT_DSL_VERSION } from "./operations.js";
import { formatTimecode, secToMs } from "./time.js";

function basePlan(operations: unknown[]) {
  return {
    version: EDIT_DSL_VERSION,
    id: "plan_1",
    createdAtMs: 0,
    instruction: "remove long pauses",
    summary: "Remove 2 pauses",
    provider: "local-silence",
    operations,
  };
}

describe("validateEditPlan", () => {
  const ctx = { sourceDurationMs: 12_000 };

  it("accepts a well-formed removeRange plan", () => {
    const result = validateEditPlan(
      basePlan([{ type: "removeRange", startMs: 1500, endMs: 3000, reason: "silence" }]),
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.operations).toHaveLength(1);
    }
  });

  it("accepts a setSpeed plan within bounds", () => {
    const result = validateEditPlan(
      basePlan([{ type: "setSpeed", startMs: 0, endMs: 4000, speed: 2 }]),
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects unknown operation types (untrusted model output)", () => {
    const result = validateEditPlan(basePlan([{ type: "deleteEverything" }]), ctx);
    expect(result.ok).toBe(false);
  });

  it("rejects ranges where endMs <= startMs", () => {
    const result = validateEditPlan(
      basePlan([{ type: "removeRange", startMs: 3000, endMs: 3000 }]),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/must be greater than startMs/);
    }
  });

  it("rejects ranges beyond source duration", () => {
    const result = validateEditPlan(
      basePlan([{ type: "removeRange", startMs: 11_000, endMs: 20_000 }]),
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/beyond source duration/);
    }
  });

  it("rejects out-of-bounds speed values", () => {
    const result = validateEditPlan(
      basePlan([{ type: "setSpeed", startMs: 0, endMs: 1000, speed: 10 }]),
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  it("requires at least one operation", () => {
    const result = validateEditPlan(basePlan([]), ctx);
    expect(result.ok).toBe(false);
  });
});

describe("time helpers", () => {
  it("converts seconds to integer ms", () => {
    expect(secToMs(1.2345)).toBe(1235);
  });

  it("formats timecodes", () => {
    expect(formatTimecode(secToMs(65.25))).toBe("01:05.250");
  });
});
