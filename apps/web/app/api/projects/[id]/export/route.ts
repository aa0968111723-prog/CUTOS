import { enqueueExport } from "../../../../../server/editor-service.js";
import { handleError, json } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: { id: string } }) {
  try {
    return json({ jobId: enqueueExport(ctx.params.id) }, { status: 202 });
  } catch (error) {
    return handleError(error);
  }
}
