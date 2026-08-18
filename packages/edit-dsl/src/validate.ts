import { EditPlanSchema, type EditPlan } from "./plan.js";
import { err, ok, type Result } from "./result.js";

export interface PlanContext {
  /** Duration of the immutable source media, in milliseconds. */
  sourceDurationMs: number;
}

/**
 * Validate untrusted plan input (e.g. raw model output) against both the
 * schema AND semantic constraints relative to the project. Model output is
 * never trusted directly: it must pass this gate before it can affect timeline
 * state. Errors are returned as data for display on the review surface.
 */
export function validateEditPlan(
  input: unknown,
  ctx: PlanContext,
): Result<EditPlan, string[]> {
  const parsed = EditPlanSchema.safeParse(input);
  if (!parsed.success) {
    return err(parsed.error.issues.map((i) => `${i.path.join(".") || "plan"}: ${i.message}`));
  }

  const plan = parsed.data;
  const errors: string[] = [];

  plan.operations.forEach((op, index) => {
    const label = `operations[${index}] (${op.type})`;
    if (op.endMs <= op.startMs) {
      errors.push(`${label}: endMs (${op.endMs}) must be greater than startMs (${op.startMs})`);
    }
    if (op.startMs > ctx.sourceDurationMs) {
      errors.push(
        `${label}: startMs (${op.startMs}) is beyond source duration (${ctx.sourceDurationMs}ms)`,
      );
    }
    if (op.endMs > ctx.sourceDurationMs) {
      errors.push(
        `${label}: endMs (${op.endMs}) is beyond source duration (${ctx.sourceDurationMs}ms)`,
      );
    }
  });

  if (errors.length > 0) {
    return err(errors);
  }

  return ok(plan);
}
