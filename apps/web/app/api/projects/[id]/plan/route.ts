import { z } from "zod";
import { plan } from "../../../../../server/editor-service.js";
import { errorResponse, handleError, json } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ instruction: z.string().min(1).max(2000) });

/**
 * Run the agent to produce a validated Edit Plan staged for review. Returns the
 * agent run id (for activity) and the updated project.
 */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return errorResponse(400, "An instruction is required.");
    const result = await plan(ctx.params.id, parsed.data.instruction);
    return json(result);
  } catch (error) {
    return handleError(error);
  }
}
