import { jobs } from "../../../../server/jobs.js";
import { errorResponse, handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  try {
    const job = jobs.get(ctx.params.id);
    if (!job) {
      return errorResponse(404, "Job not found.");
    }
    return json(job);
  } catch (error) {
    return handleError(error);
  }
}
