import { z } from "zod";
import { rejectOperation } from "../../../../../../server/editor-service.js";
import { errorResponse, handleError, json } from "../../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ opIndex: z.number().int().nonnegative() });

/** Reject a single operation from the pending plan (operation-level review). */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return errorResponse(400, "opIndex is required.");
    return json(rejectOperation(ctx.params.id, parsed.data.opIndex));
  } catch (error) {
    return handleError(error);
  }
}
