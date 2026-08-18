import { store } from "../../../../server/store.js";
import { toProjectDTO } from "../../../../server/dto.js";
import { handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  try {
    const project = store.require(ctx.params.id);
    return json(toProjectDTO(project));
  } catch (error) {
    return handleError(error);
  }
}
