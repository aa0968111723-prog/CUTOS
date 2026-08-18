import type { EditPlan } from "@cutos/edit-dsl";
import type { ContextBuilder } from "./context.js";
import { DefaultApprovalPolicy, estimateImpact, type ApprovalPolicy, type EditImpact } from "./impact.js";
import type { AgentRun, AgentRunStore, AgentStepKind } from "./run.js";
import type { AgentPermission, ToolContext, ToolRegistry } from "./tools.js";
import { verifyEdit, type VerifyResult } from "./verify.js";

/** Result shape the `create_edit_plan` tool must return. */
export interface CreatePlanToolResult {
  plan?: EditPlan;
  issues?: string[];
}

export interface AgentRuntimeDeps {
  registry: ToolRegistry;
  contextBuilder: ContextBuilder;
  runStore: AgentRunStore;
  approvalPolicy?: ApprovalPolicy;
  permissions?: AgentPermission[];
  now?: () => number;
  createId?: () => string;
}

export interface PlanEditInput {
  projectId: string;
  instruction: string;
}

/**
 * Orchestrates the agent loop: observe → build context → plan (via a tool) →
 * validate → approval. Execution/verification are recorded when the user
 * applies the plan. Every step is captured on the AgentRun for a verifiable
 * activity view — the agent never edits media directly.
 */
export class AgentRuntime {
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly permissions: Set<AgentPermission>;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.approvalPolicy = deps.approvalPolicy ?? new DefaultApprovalPolicy();
    this.permissions = new Set(deps.permissions ?? ["read", "analyze", "plan"]);
    this.now = deps.now ?? (() => Date.now());
    this.createId = deps.createId ?? (() => `run_${Math.random().toString(36).slice(2, 10)}`);
  }

  async planEdit(input: PlanEditInput): Promise<AgentRun> {
    const run: AgentRun = {
      id: this.createId(),
      projectId: input.projectId,
      input: input.instruction,
      status: "running",
      createdAt: this.now(),
      updatedAt: this.now(),
      steps: [],
      toolCalls: [],
      planId: null,
      summary: null,
      error: null,
    };
    this.step(run, "observe", "Received request", input.instruction);
    this.persist(run);

    try {
      const context = await this.deps.contextBuilder.build(input.projectId);
      this.step(
        run,
        "context",
        "Analyzed project context",
        `${Math.round(context.sourceDurationMs / 1000)}s source · ${context.silences.length} pauses · revision ${context.timelineRevision}`,
      );

      const ctx: ToolContext = { runId: run.id, projectId: input.projectId, permissions: this.permissions };
      const invocation = await this.deps.registry.call("create_edit_plan", { instruction: input.instruction, context }, ctx);
      run.toolCalls.push(invocation.record);
      this.step(run, "tool_call", `Called tool "create_edit_plan"`, invocation.record.status, invocation.record.id);

      if (invocation.record.status === "error") {
        return this.fail(run, invocation.record.error ?? "planning tool failed");
      }

      const result = invocation.result as CreatePlanToolResult;
      if (!result.plan) {
        return this.fail(run, result.issues?.join("; ") ?? "No actionable plan was produced");
      }

      const plan = result.plan;
      this.step(run, "plan", "Created edit plan", plan.summary);

      const impact = estimateImpact(plan, context.sourceDurationMs);
      this.step(
        run,
        "validate",
        "Validated plan",
        `${impact.operationCount} operation(s), est. ${Math.round(impact.estimatedDurationMs / 1000)}s (risk: ${impact.riskLevel})`,
      );

      const decision = this.approvalPolicy.evaluate(impact);
      this.step(run, "approval", decision.requiresApproval ? "Awaiting your approval" : "Auto-approved", decision.reason);

      run.planId = plan.id;
      run.summary = plan.summary;
      run.status = "awaiting_approval";
      run.updatedAt = this.now();
      this.persist(run);
      return run;
    } catch (error) {
      return this.fail(run, error instanceof Error ? error.message : String(error));
    }
  }

  /** Record execution + verification once the user applies the plan. */
  completeRun(
    runId: string,
    args: { beforeDurationMs: number; afterDurationMs: number; impact: EditImpact },
  ): AgentRun | undefined {
    const run = this.deps.runStore.get(runId);
    if (!run) return undefined;
    this.step(run, "execute", "Applied edit plan to the timeline", `duration ${args.beforeDurationMs}ms → ${args.afterDurationMs}ms`);
    const verify: VerifyResult = verifyEdit({
      beforeDurationMs: args.beforeDurationMs,
      afterDurationMs: args.afterDurationMs,
      impact: args.impact,
    });
    this.step(run, "verify", verify.ok ? "Verified result" : "Verification found issues", verify.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`).join(", "));
    this.step(run, "summary", "Done", run.summary ?? "Edit applied");
    run.status = verify.ok ? "applied" : "completed";
    run.updatedAt = this.now();
    this.persist(run);
    return run;
  }

  private step(run: AgentRun, kind: AgentStepKind, title: string, detail?: string, toolCallId?: string): void {
    run.steps.push({ at: this.now(), kind, title, detail, toolCallId });
    run.updatedAt = this.now();
  }

  private fail(run: AgentRun, error: string): AgentRun {
    run.status = "failed";
    run.error = error;
    this.step(run, "error", "Could not complete the request", error);
    run.updatedAt = this.now();
    this.persist(run);
    return run;
  }

  private persist(run: AgentRun): void {
    this.deps.runStore.save(run);
  }
}
