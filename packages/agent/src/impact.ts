import type { EditPlan } from "@cutos/edit-dsl";

export type RiskLevel = "low" | "medium" | "high";

export interface EditImpact {
  sourceDurationMs: number;
  estimatedDurationMs: number;
  removedMs: number;
  addedMs: number;
  operationCount: number;
  riskLevel: RiskLevel;
  /** Operations whose type the timeline engine cannot yet apply. */
  unsupportedOperations: string[];
}

const IMPLEMENTED = new Set([
  "removeRange",
  "deleteRange",
  "trim",
  "split",
  "setSpeed",
  "marker",
  "caption",
]);

/**
 * Estimate the impact of applying a plan to a timeline of the given duration.
 * This drives the review card's before/after figures and the approval policy.
 * The estimate is conservative and does not mutate anything.
 */
export function estimateImpact(plan: EditPlan, sourceDurationMs: number): EditImpact {
  let removedMs = 0;
  let addedMs = 0;
  const unsupported: string[] = [];

  for (const op of plan.operations) {
    if (!IMPLEMENTED.has(op.type)) unsupported.push(op.type);
    switch (op.type) {
      case "removeRange":
      case "deleteRange":
        removedMs += Math.max(0, op.endMs - op.startMs);
        break;
      case "trim":
        removedMs += Math.max(0, sourceDurationMs - (op.endMs - op.startMs));
        break;
      case "setSpeed": {
        const span = Math.max(0, op.endMs - op.startMs);
        const newSpan = Math.round(span / op.speed);
        if (newSpan < span) removedMs += span - newSpan;
        else addedMs += newSpan - span;
        break;
      }
      default:
        break;
    }
  }

  const estimatedDurationMs = Math.max(0, sourceDurationMs - removedMs + addedMs);
  const changedFraction = sourceDurationMs > 0 ? (removedMs + addedMs) / sourceDurationMs : 0;

  let riskLevel: RiskLevel = "low";
  if (unsupported.length > 0 || changedFraction >= 0.5) riskLevel = "high";
  else if (changedFraction >= 0.2 || plan.operations.length > 10) riskLevel = "medium";

  return {
    sourceDurationMs,
    estimatedDurationMs,
    removedMs,
    addedMs,
    operationCount: plan.operations.length,
    riskLevel,
    unsupportedOperations: unsupported,
  };
}

export interface ApprovalDecision {
  requiresApproval: boolean;
  reason: string;
}

/**
 * Approval policy. High-impact edits always require explicit user approval.
 * CUTOS keeps a review-first posture, so by default every agent edit is staged
 * for review; the policy additionally flags which ones are high-impact.
 */
export interface ApprovalPolicy {
  evaluate(impact: EditImpact): ApprovalDecision;
}

export class DefaultApprovalPolicy implements ApprovalPolicy {
  constructor(private readonly reviewEverything = true) {}

  evaluate(impact: EditImpact): ApprovalDecision {
    if (impact.riskLevel === "high") {
      return { requiresApproval: true, reason: "High-impact edit (large change or unsupported operations)." };
    }
    if (impact.riskLevel === "medium") {
      return { requiresApproval: true, reason: "Moderate-impact edit." };
    }
    return {
      requiresApproval: this.reviewEverything,
      reason: this.reviewEverything ? "Review-first policy: all edits are reviewed." : "Low-impact edit.",
    };
  }
}
