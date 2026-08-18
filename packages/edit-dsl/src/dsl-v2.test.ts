import { describe, expect, it } from "vitest";
import { EDIT_DSL_VERSION, isImplementedOperation } from "./operations.js";
import { migrateEditPlan } from "./migrate.js";
import { isPlanStale, validateEditPlan } from "./validate.js";

const ctx = { sourceDurationMs: 12_000 };

function plan(operations: unknown[], extra: Record<string, unknown> = {}) {
  return {
    version: EDIT_DSL_VERSION,
    id: "p",
    createdAtMs: 0,
    instruction: "do",
    summary: "s",
    provider: "test",
    operations,
    ...extra,
  };
}

describe("Edit DSL v2 migration", () => {
  it("upgrades a v1 plan to the current version", () => {
    const v1 = {
      version: 1,
      id: "old",
      createdAtMs: 0,
      instruction: "remove pauses",
      summary: "s",
      provider: "local",
      operations: [{ type: "removeRange", startMs: 1000, endMs: 2000, reason: "pause" }],
    };
    const migrated = migrateEditPlan(v1) as { version: number };
    expect(migrated.version).toBe(EDIT_DSL_VERSION);
    const result = validateEditPlan(migrated, ctx);
    expect(result.ok).toBe(true);
  });
});

describe("Edit DSL v2 operations", () => {
  it("validates new operation types with metadata", () => {
    const result = validateEditPlan(
      plan([
        { type: "trim", startMs: 1000, endMs: 8000, confidence: 0.9, source: "agent" },
        { type: "split", atMs: 4000 },
        { type: "caption", startMs: 0, endMs: 2000, text: "Hello" },
        { type: "marker", atMs: 6000, label: "highlight" },
        { type: "reframe", aspect: "9:16" },
      ]),
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it("still rejects zero-length ranges and out-of-bounds", () => {
    expect(validateEditPlan(plan([{ type: "removeRange", startMs: 5, endMs: 5 }]), ctx).ok).toBe(
      false,
    );
    expect(
      validateEditPlan(plan([{ type: "caption", startMs: 0, endMs: 99_999, text: "x" }]), ctx).ok,
    ).toBe(false);
  });

  it("knows which operations the engine implements", () => {
    expect(isImplementedOperation("removeRange")).toBe(true);
    expect(isImplementedOperation("caption")).toBe(true);
    expect(isImplementedOperation("reframe")).toBe(false);
  });
});

describe("stale-plan detection", () => {
  it("flags a plan whose target revision no longer matches", () => {
    const result = validateEditPlan(plan([{ type: "removeRange", startMs: 0, endMs: 1000 }], { targetRevision: 3 }), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isPlanStale(result.value, 3)).toBe(false);
      expect(isPlanStale(result.value, 4)).toBe(true);
    }
  });

  it("treats legacy plans without a target revision as non-stale", () => {
    const result = validateEditPlan(plan([{ type: "removeRange", startMs: 0, endMs: 1000 }]), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(isPlanStale(result.value, 99)).toBe(false);
  });
});
