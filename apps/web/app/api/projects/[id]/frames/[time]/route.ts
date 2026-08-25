import { extractFrame } from "../../../../../../server/editor-service.js";
import { errorResponse, handleError } from "../../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * JPEG still for a project time. Addressed by projectId + timeMs only — never
 * a filesystem path.
 */
export async function GET(_req: Request, ctx: { params: { id: string; time: string } }) {
  try {
    const timeMs = Number.parseInt(ctx.params.time, 10);
    if (!Number.isFinite(timeMs) || timeMs < 0) {
      return errorResponse(400, "VALIDATION_FAILED", "time must be a non-negative integer (ms).");
    }
    const frame = await extractFrame(ctx.params.id, timeMs);
    return new Response(Buffer.from(frame.data), {
      status: 200,
      headers: {
        "content-type": frame.mimeType,
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
