import { z } from "zod";
import { EditOperationSchema, EDIT_DSL_VERSION } from "./operations.js";
import { TimeMsSchema } from "./time.js";

/**
 * An Edit Plan is the reviewable artifact an agent produces from a natural
 * language request. It is validated before it is ever allowed to touch project
 * state, is retained so edits can be replayed/audited, and declares the
 * timeline revision it was planned against (for stale-plan detection).
 */
export const EditPlanSchema = z.object({
  version: z.literal(EDIT_DSL_VERSION),
  id: z.string().min(1),
  createdAtMs: TimeMsSchema,
  /** The natural language request that produced this plan. */
  instruction: z.string().min(1).max(2000),
  /** Human-readable summary shown on the review card before applying. */
  summary: z.string().min(1).max(2000),
  /** Which provider/adapter produced the plan (model-agnostic gateway). */
  provider: z.string().min(1),
  /** Who authored the plan (agent runtime, provider, or user). */
  createdBy: z.string().min(1).optional(),
  /**
   * The timeline revision this plan was built against. Applying a plan whose
   * target no longer matches the current revision is a stale-plan error.
   */
  targetRevision: z.number().int().nonnegative().optional(),
  operations: z.array(EditOperationSchema).min(1).max(1000),
});

export type EditPlan = z.infer<typeof EditPlanSchema>;
