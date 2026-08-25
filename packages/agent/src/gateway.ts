import {
  validateEditPlan,
  type EditPlan,
  type Result,
  EDIT_DSL_VERSION,
} from "@cutos/edit-dsl";
import type { Planner, PlanRequest, ProposedEdits } from "./types.js";

export interface GatewayOptions {
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /** Id factory injection for deterministic tests. */
  createId?: () => string;
}

/**
 * The provider gateway is the single choke point between agents and project
 * state. A planner proposes operations; the gateway wraps them in a versioned
 * Edit Plan and validates them against the schema AND the project before
 * returning. Invalid model output never reaches the timeline.
 */
export class PlanGateway {
  private readonly planner: Planner;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(planner: Planner, options: GatewayOptions = {}) {
    this.planner = planner;
    this.now = options.now ?? (() => Date.now());
    this.createId =
      options.createId ??
      (() => `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  }

  get providerName(): string {
    return this.planner.name;
  }

  /**
   * Wrap already-proposed operations (e.g. a grounded trim) in a versioned
   * Edit Plan and validate. Used when conversation grounding, not the LLM,
   * produced the operations — the model still never touches the timeline.
   */
  wrap(proposed: ProposedEdits, request: PlanRequest): Result<EditPlan, string[]> {
    const envelope = {
      version: EDIT_DSL_VERSION,
      id: this.createId(),
      createdAtMs: this.now(),
      instruction: request.instruction,
      summary: proposed.summary,
      provider: this.planner.name,
      createdBy: this.planner.name,
      targetRevision: request.targetRevision ?? 0,
      operations: proposed.operations,
    };
    return validateEditPlan(envelope, { sourceDurationMs: request.sourceDurationMs });
  }

  async plan(request: PlanRequest): Promise<Result<EditPlan, string[]>> {
    const proposed = await this.planner.propose(request);
    return this.wrap(proposed, request);
  }
}
