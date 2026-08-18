import { validateEditPlan } from "@cutos/edit-dsl";
import { store } from "../../../../../server/store.js";
import { errorResponse, handleError, json } from "../../../../../server/http.js";
import { toProjectDTO } from "../../../../../server/dto.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Apply the staged plan to the timeline (non-destructive; pushes to history). */
export async function POST(_req: Request, ctx: { params: { id: string } }) {
  try {
    const project = store.require(ctx.params.id);
    const plan = project.pendingPlan;
    if (!plan) {
      return errorResponse(409, "There is no pending plan to apply.");
    }

    // Re-validate before mutating timeline state (never trust staged data).
    const validated = validateEditPlan(plan, {
      sourceDurationMs: project.source.durationMs,
    });
    if (!validated.ok) {
      return errorResponse(422, "The pending plan is no longer valid.", {
        issues: validated.errors,
      });
    }

    project.history.apply(validated.value);
    project.pendingPlan = undefined;
    // The rendered output is stale once the timeline changes.
    project.output = undefined;

    return json(toProjectDTO(project));
  } catch (error) {
    return handleError(error);
  }
}
