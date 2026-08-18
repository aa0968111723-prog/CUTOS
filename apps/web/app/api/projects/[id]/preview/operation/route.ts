import { z } from "zod";
import { previewOperationManifest } from "../../../../../../server/editor-service.js";
import { errorResponse, handleError, json } from "../../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ opIndex: z.number().int().nonnegative() });

/** Ephemeral preview of a single pending operation (does not mutate the timeline). */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return errorResponse(400, "VALIDATION_FAILED", "opIndex is required.");
    return json({ manifest: previewOperationManifest(ctx.params.id, parsed.data.opIndex) });
  } catch (error) {
    return handleError(error);
  }
}
