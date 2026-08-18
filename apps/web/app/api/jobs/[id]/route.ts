import { getJob } from "../../../../server/editor-service.js";
import { handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  try {
    return json(getJob(ctx.params.id));
  } catch (error) {
    return handleError(error);
  }
}
