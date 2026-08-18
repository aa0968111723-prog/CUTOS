import { previewPlanManifest } from "../../../../../../server/editor-service.js";
import { handleError, json } from "../../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ephemeral preview of the whole pending plan (does not mutate the timeline). */
export async function POST(_req: Request, ctx: { params: { id: string } }) {
  try {
    return json({ manifest: previewPlanManifest(ctx.params.id) });
  } catch (error) {
    return handleError(error);
  }
}
