import { randomUUID } from "node:crypto";
import type { EditPlan } from "@cutos/edit-dsl";
import { estimateImpact } from "@cutos/agent";
import type { ApprovalRequest, CapabilityRisk, RunCorrelation } from "@cutos/protocol";

/**
 * Impact policy for AIOS-driven mutations.
 *
 * AIOS is the control plane and owns the human-approval UX, so CUTOS does NOT
 * build a second confirmation mechanism. What CUTOS does own is the domain
 * judgement AIOS cannot make: how much of the video this edit actually
 * destroys. It computes that, names the reason with a stable code, and refuses
 * to act until the caller returns `approval.granted`.
 */

/** Removing more than this fraction of the source needs a human. */
export const HIGH_IMPACT_REMOVED_RATIO = 0.3;
/** Keeping less than this fraction of the source needs a human. */
export const MIN_KEPT_RATIO = 0.2;
/** This many delete-shaped operations in one plan needs a human. */
export const BULK_DELETE_OPERATIONS = 12;

export interface ImpactSummary {
  sourceDurationMs: number;
  estimatedDurationMs: number;
  removedMs: number;
  addedMs: number;
  keptRatio: number;
  removedRatio: number;
  operationCount: number;
  deleteOperationCount: number;
  riskLevel: CapabilityRisk;
  unsupportedOperations: string[];
}

const DELETE_TYPES = new Set(["removeRange", "deleteRange", "trim"]);

export function summarizeImpact(plan: EditPlan, sourceDurationMs: number): ImpactSummary {
  const impact = estimateImpact(plan, sourceDurationMs);
  const removedRatio = sourceDurationMs > 0 ? Math.min(1, impact.removedMs / sourceDurationMs) : 0;
  const keptRatio = sourceDurationMs > 0
    ? Math.max(0, Math.min(1, impact.estimatedDurationMs / sourceDurationMs))
    : 1;
  return {
    sourceDurationMs: impact.sourceDurationMs,
    estimatedDurationMs: impact.estimatedDurationMs,
    removedMs: impact.removedMs,
    addedMs: impact.addedMs,
    keptRatio: Number(keptRatio.toFixed(4)),
    removedRatio: Number(removedRatio.toFixed(4)),
    operationCount: impact.operationCount,
    deleteOperationCount: plan.operations.filter((op) => DELETE_TYPES.has(op.type)).length,
    riskLevel: impact.riskLevel,
    unsupportedOperations: impact.unsupportedOperations,
  };
}

export interface ApprovalDecision {
  required: boolean;
  reasonCode: string;
  messageKey: string;
  risk: CapabilityRisk;
}

/** Decide whether this specific mutation needs human sign-off. */
export function evaluateApproval(
  capability: string,
  impact: ImpactSummary,
): ApprovalDecision {
  // Export publishes a deliverable; always a human decision.
  if (capability === "export") {
    return {
      required: true,
      reasonCode: "final_export",
      messageKey: "aios.approval.finalExport",
      risk: "high",
    };
  }
  if (impact.removedRatio > HIGH_IMPACT_REMOVED_RATIO) {
    return {
      required: true,
      reasonCode: "removes_more_than_30_percent",
      messageKey: "aios.approval.removesMost",
      risk: "high",
    };
  }
  if (impact.sourceDurationMs > 0 && impact.keptRatio < MIN_KEPT_RATIO) {
    return {
      required: true,
      reasonCode: "keeps_less_than_20_percent",
      messageKey: "aios.approval.keepsLittle",
      risk: "high",
    };
  }
  if (impact.deleteOperationCount >= BULK_DELETE_OPERATIONS) {
    return {
      required: true,
      reasonCode: "bulk_delete",
      messageKey: "aios.approval.bulkDelete",
      risk: "medium",
    };
  }
  if (impact.unsupportedOperations.length > 0) {
    return {
      required: true,
      reasonCode: "unsupported_operations",
      messageKey: "aios.approval.unsupported",
      risk: "high",
    };
  }
  return {
    required: false,
    reasonCode: "within_policy",
    messageKey: "aios.approval.withinPolicy",
    risk: impact.riskLevel,
  };
}

export function buildApprovalRequest(input: {
  projectId: string;
  capability: string;
  decision: ApprovalDecision;
  impact: ImpactSummary;
  correlation: RunCorrelation;
  now?: number;
}): ApprovalRequest {
  return {
    id: randomUUID(),
    projectId: input.projectId,
    capability: input.capability,
    reasonCode: input.decision.reasonCode,
    messageKey: input.decision.messageKey,
    risk: input.decision.risk,
    impact: {
      sourceDurationMs: input.impact.sourceDurationMs,
      estimatedDurationMs: input.impact.estimatedDurationMs,
      removedMs: input.impact.removedMs,
      addedMs: input.impact.addedMs,
      keptRatio: input.impact.keptRatio,
      removedRatio: input.impact.removedRatio,
      operationCount: input.impact.operationCount,
      deleteOperationCount: input.impact.deleteOperationCount,
    },
    requestedAt: new Date(input.now ?? Date.now()).toISOString(),
    correlation: input.correlation,
  };
}
