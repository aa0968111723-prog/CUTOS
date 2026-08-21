import { retryProbe } from "../../../../../server/editor-service.js";
import { handleError, json } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-read the media metadata of a project whose probe failed.
 *
 * The uploaded asset is kept on a probe failure precisely so this exists: the
 * user retries a metadata read, not a 300 MB upload.
 */
export async function POST(_req: Request, ctx: { params: { id: string } }) {
  try {
    return json(retryProbe(ctx.params.id), { status: 202 });
  } catch (error) {
    return handleError(error);
  }
}
