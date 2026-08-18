import { describe, expect, it } from "vitest";
import { LocalHeuristicPlanner } from "./local-planner.js";
import { PlanGateway } from "./gateway.js";
import type { PlanRequest } from "./types.js";

const request: PlanRequest = {
  instruction: "remove pauses longer than 1 second",
  sourceDurationMs: 12_000,
  silences: [
    { startMs: 1500, endMs: 3000 }, // 1.5s
    { startMs: 4500, endMs: 6000 }, // 1.5s
    { startMs: 9000, endMs: 9400 }, // 0.4s (below threshold)
  ],
};

const deterministicOptions = {
  now: () => 0,
  createId: () => "plan_fixed",
};

describe("LocalHeuristicPlanner", () => {
  it("emits removeRange ops for silences over the threshold", async () => {
    const planner = new LocalHeuristicPlanner();
    const proposed = await planner.propose(request);
    expect(proposed.operations).toHaveLength(2);
    expect(proposed.operations[0]).toMatchObject({ type: "removeRange", startMs: 1500, endMs: 3000 });
  });

  it("parses speed intents", async () => {
    const planner = new LocalHeuristicPlanner();
    const proposed = await planner.propose({
      ...request,
      instruction: "make the whole thing 2x faster",
    });
    expect(proposed.operations).toContainEqual(
      expect.objectContaining({ type: "setSpeed", speed: 2 }),
    );
  });
});

describe("PlanGateway", () => {
  it("returns a validated Edit Plan for a valid request", async () => {
    const gateway = new PlanGateway(new LocalHeuristicPlanner(), deterministicOptions);
    const result = await gateway.plan(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider).toBe("local-heuristic");
      expect(result.value.operations).toHaveLength(2);
      expect(result.value.id).toBe("plan_fixed");
    }
  });

  it("rejects requests that yield no operations", async () => {
    const gateway = new PlanGateway(new LocalHeuristicPlanner(), deterministicOptions);
    const result = await gateway.plan({
      ...request,
      instruction: "tell me a joke",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects operations that exceed source duration (untrusted output)", async () => {
    const badPlanner = {
      name: "bad",
      async propose() {
        return {
          summary: "bad",
          operations: [{ type: "removeRange", startMs: 0, endMs: 999_999 }],
        };
      },
    };
    const gateway = new PlanGateway(badPlanner, deterministicOptions);
    const result = await gateway.plan(request);
    expect(result.ok).toBe(false);
  });
});
