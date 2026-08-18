import { PlanGateway, createPlanner } from "@cutos/agent";
import { store } from "../../../../../server/store.js";
import { errorResponse, handleError, json } from "../../../../../server/http.js";
import { toProjectDTO } from "../../../../../server/dto.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PlanBody {
  instruction?: string;
}

/**
 * Ask the agent to produce an Edit Plan from a natural-language instruction.
 * The plan is validated by the gateway and staged as `pendingPlan` for review;
 * it is NOT applied to the timeline here.
 */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const project = store.require(ctx.params.id);
    const body = (await req.json().catch(() => ({}))) as PlanBody;
    const instruction = body.instruction?.trim();
    if (!instruction) {
      return errorResponse(400, "An instruction is required.");
    }

    const gateway = new PlanGateway(createPlanner());
    const result = await gateway.plan({
      instruction,
      sourceDurationMs: project.source.durationMs,
      silences: project.analysis?.silences ?? [],
    });

    if (!result.ok) {
      return errorResponse(422, "The request could not be turned into a valid Edit Plan.", {
        issues: result.errors,
      });
    }

    project.pendingPlan = result.value;
    return json(toProjectDTO(project));
  } catch (error) {
    return handleError(error);
  }
}
