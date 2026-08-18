import { EditPlanSchema, type EditPlan } from "./plan.js";
import { migrateEditPlan } from "./migrate.js";
import type { EditOperation } from "./operations.js";
import { err, ok, type Result } from "./result.js";

export interface PlanContext {
  /** Duration of the immutable source media, in milliseconds. */
  sourceDurationMs: number;
}

interface CheckedRange {
  startMs: number;
  endMs: number;
  /** A "point" op has a single instant (no positive-length requirement). */
  point: boolean;
}

/** The time range(s)/points an operation touches, for bounds validation. */
function operationRanges(op: EditOperation): CheckedRange[] {
  switch (op.type) {
    case "removeRange":
    case "deleteRange":
    case "trim":
    case "setSpeed":
    case "caption":
    case "volume":
      return [{ startMs: op.startMs, endMs: op.endMs, point: false }];
    case "split":
    case "marker":
    case "insertClip":
      return [{ startMs: op.atMs, endMs: op.atMs, point: true }];
    case "fade":
      return [{ startMs: op.atMs, endMs: op.atMs, point: true }];
    case "moveClip":
      return [{ startMs: op.toMs, endMs: op.toMs, point: true }];
    case "removeSilence":
    case "crop":
    case "reframe":
      return [];
  }
}

/**
 * Validate untrusted plan input (e.g. raw model output) against both the schema
 * AND semantic constraints relative to the project. Model output is never
 * trusted directly: it must pass this gate before it can affect timeline state.
 * Older plan versions are migrated first. Errors are returned as data.
 */
export function validateEditPlan(
  input: unknown,
  ctx: PlanContext,
): Result<EditPlan, string[]> {
  const parsed = EditPlanSchema.safeParse(migrateEditPlan(input));
  if (!parsed.success) {
    return err(parsed.error.issues.map((i) => `${i.path.join(".") || "plan"}: ${i.message}`));
  }

  const plan = parsed.data;
  const errors: string[] = [];

  plan.operations.forEach((op, index) => {
    const label = `operations[${index}] (${op.type})`;
    for (const range of operationRanges(op)) {
      if (!range.point && range.endMs <= range.startMs) {
        errors.push(
          `${label}: endMs (${range.endMs}) must be greater than startMs (${range.startMs})`,
        );
      }
      if (range.startMs > ctx.sourceDurationMs) {
        errors.push(
          `${label}: startMs (${range.startMs}) is beyond source duration (${ctx.sourceDurationMs}ms)`,
        );
      }
      if (range.endMs > ctx.sourceDurationMs) {
        errors.push(
          `${label}: endMs (${range.endMs}) is beyond source duration (${ctx.sourceDurationMs}ms)`,
        );
      }
    }
  });

  if (errors.length > 0) {
    return err(errors);
  }

  return ok(plan);
}

/**
 * A plan is stale if it targets a timeline revision that no longer matches the
 * project's current revision (the timeline changed since the plan was built).
 * Legacy plans without a target revision are treated as non-stale.
 */
export function isPlanStale(plan: EditPlan, currentRevision: number): boolean {
  return plan.targetRevision !== undefined && plan.targetRevision !== currentRevision;
}
