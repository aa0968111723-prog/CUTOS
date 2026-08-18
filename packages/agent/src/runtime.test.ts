import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EDIT_DSL_VERSION, type EditPlan } from "@cutos/edit-dsl";
import { ToolPermissionError, ToolRegistry, ToolValidationError, type Tool } from "./tools.js";
import { MemoryAgentRunStore } from "./run.js";
import { DefaultApprovalPolicy, estimateImpact } from "./impact.js";
import { verifyEdit } from "./verify.js";
import { AgentRuntime, type CreatePlanToolResult } from "./runtime.js";
import { EditContextSchema, type ContextBuilder, type EditContext } from "./context.js";
import { PlanGateway } from "./gateway.js";
import { LocalHeuristicPlanner } from "./local-planner.js";

const context: EditContext = {
  sourceDurationMs: 12_000,
  timelineRevision: 0,
  silences: [
    { startMs: 1500, endMs: 3000 },
    { startMs: 4500, endMs: 6000 },
  ],
};

function planTool(): Tool<{ instruction: string; context: EditContext }, CreatePlanToolResult> {
  const gateway = new PlanGateway(new LocalHeuristicPlanner(), {
    now: () => 0,
    createId: () => "plan_x",
  });
  return {
    name: "create_edit_plan",
    description: "Create a validated edit plan",
    permission: "plan",
    argsSchema: z.object({ instruction: z.string(), context: EditContextSchema }),
    async execute(args) {
      const result = await gateway.plan({
        instruction: args.instruction,
        sourceDurationMs: args.context.sourceDurationMs,
        silences: args.context.silences,
        targetRevision: args.context.timelineRevision,
      });
      return result.ok ? { plan: result.value } : { issues: result.errors };
    },
  };
}

const contextBuilder: ContextBuilder = { build: async () => context };

describe("ToolRegistry", () => {
  it("enforces permissions and validates arguments", async () => {
    const registry = new ToolRegistry();
    registry.register(planTool());

    await expect(
      registry.call("create_edit_plan", { instruction: "x", context }, {
        runId: "r",
        projectId: "p",
        permissions: new Set(["read"]),
      }),
    ).rejects.toBeInstanceOf(ToolPermissionError);

    await expect(
      registry.call("create_edit_plan", { instruction: "x" }, {
        runId: "r",
        projectId: "p",
        permissions: new Set(["plan"]),
      }),
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("records a traceable tool call", async () => {
    const registry = new ToolRegistry();
    registry.register(planTool());
    const inv = await registry.call(
      "create_edit_plan",
      { instruction: "remove pauses", context },
      { runId: "r", projectId: "p", permissions: new Set(["plan"]) },
    );
    expect(inv.record.status).toBe("ok");
    expect(inv.record.tool).toBe("create_edit_plan");
  });
});

describe("estimateImpact + approval", () => {
  it("computes removed duration and risk", () => {
    const plan: EditPlan = {
      version: EDIT_DSL_VERSION,
      id: "p",
      createdAtMs: 0,
      instruction: "remove pauses",
      summary: "s",
      provider: "t",
      operations: [
        { type: "removeRange", startMs: 1500, endMs: 3000 },
        { type: "removeRange", startMs: 4500, endMs: 6000 },
      ],
    };
    const impact = estimateImpact(plan, 12_000);
    expect(impact.removedMs).toBe(3000);
    expect(impact.estimatedDurationMs).toBe(9000);
    const decision = new DefaultApprovalPolicy().evaluate(impact);
    expect(decision.requiresApproval).toBe(true);
  });

  it("flags unsupported operations as high risk", () => {
    const plan: EditPlan = {
      version: EDIT_DSL_VERSION,
      id: "p",
      createdAtMs: 0,
      instruction: "reframe",
      summary: "s",
      provider: "t",
      operations: [{ type: "reframe", aspect: "9:16" }],
    };
    const impact = estimateImpact(plan, 12_000);
    expect(impact.riskLevel).toBe("high");
    expect(impact.unsupportedOperations).toContain("reframe");
  });
});

describe("verifyEdit", () => {
  it("passes when duration shrinks as expected", () => {
    const impact = estimateImpact(
      {
        version: EDIT_DSL_VERSION,
        id: "p",
        createdAtMs: 0,
        instruction: "x",
        summary: "s",
        provider: "t",
        operations: [{ type: "removeRange", startMs: 0, endMs: 3000 }],
      },
      12_000,
    );
    const result = verifyEdit({ beforeDurationMs: 12_000, afterDurationMs: 9000, impact });
    expect(result.ok).toBe(true);
  });
});

describe("AgentRuntime.planEdit", () => {
  it("runs the loop to awaiting_approval and records steps", async () => {
    const runStore = new MemoryAgentRunStore();
    const registry = new ToolRegistry();
    registry.register(planTool());
    const runtime = new AgentRuntime({
      registry,
      contextBuilder,
      runStore,
      permissions: ["read", "analyze", "plan"],
      now: () => 1,
      createId: () => "run_1",
    });

    const run = await runtime.planEdit({ projectId: "p", instruction: "remove pauses" });
    expect(run.status).toBe("awaiting_approval");
    expect(run.planId).toBe("plan_x");
    expect(run.steps.map((s) => s.kind)).toEqual([
      "observe",
      "context",
      "tool_call",
      "plan",
      "validate",
      "approval",
    ]);
    expect(runStore.get("run_1")?.status).toBe("awaiting_approval");
  });

  it("fails cleanly when no plan can be produced", async () => {
    const runStore = new MemoryAgentRunStore();
    const registry = new ToolRegistry();
    registry.register(planTool());
    const runtime = new AgentRuntime({
      registry,
      contextBuilder,
      runStore,
      permissions: ["read", "analyze", "plan"],
      createId: () => "run_2",
    });
    const run = await runtime.planEdit({ projectId: "p", instruction: "tell me a joke" });
    expect(run.status).toBe("failed");
    expect(run.error).toBeTruthy();
  });

  it("records execution + verification on completion", async () => {
    const runStore = new MemoryAgentRunStore();
    const registry = new ToolRegistry();
    registry.register(planTool());
    const runtime = new AgentRuntime({ registry, contextBuilder, runStore, createId: () => "run_3" });
    await runtime.planEdit({ projectId: "p", instruction: "remove pauses" });

    const impact = estimateImpact(
      {
        version: EDIT_DSL_VERSION,
        id: "plan_x",
        createdAtMs: 0,
        instruction: "remove pauses",
        summary: "s",
        provider: "t",
        operations: [{ type: "removeRange", startMs: 1500, endMs: 3000 }],
      },
      12_000,
    );
    const completed = runtime.completeRun("run_3", {
      beforeDurationMs: 12_000,
      afterDurationMs: 10_500,
      impact,
    });
    expect(completed?.status).toBe("applied");
    expect(completed?.steps.some((s) => s.kind === "verify")).toBe(true);
  });
});
