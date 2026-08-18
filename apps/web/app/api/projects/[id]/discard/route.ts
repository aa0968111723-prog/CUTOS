import { store } from "../../../../../server/store.js";
import { handleError, json } from "../../../../../server/http.js";
import { toProjectDTO } from "../../../../../server/dto.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Discard the staged plan without applying it. */
export async function POST(_req: Request, ctx: { params: { id: string } }) {
  try {
    const project = store.require(ctx.params.id);
    project.pendingPlan = undefined;
    return json(toProjectDTO(project));
  } catch (error) {
    return handleError(error);
  }
}
