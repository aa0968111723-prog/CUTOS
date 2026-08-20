import { z } from "zod";
import { listActivity } from "../../../../server/aios-activity.js";
import { errorResponse, handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  projectId: z.string().min(1),
  afterSequence: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

/** Replayable cross-system activity feed for the AIOS control-plane UI. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      projectId: url.searchParams.get("projectId") ?? undefined,
      afterSequence: url.searchParams.get("afterSequence") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return errorResponse(400, "VALIDATION_FAILED", "projectId is required.");
    }
    return json(listActivity(parsed.data.projectId, {
      ...(parsed.data.afterSequence === undefined ? {} : { afterSequence: parsed.data.afterSequence }),
      ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    }));
  } catch (error) {
    return handleError(error);
  }
}
