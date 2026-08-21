import { finalizeUpload } from "../../../../../server/upload-service.js";
import { handleError, json } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Seal an upload into a project.
 *
 * Returns as soon as the bytes are stored and the project exists; ffprobe,
 * analysis, waveform and transcription all run as durable jobs afterwards.
 * Idempotent — a retried finalize returns the project the first one created.
 */
export async function POST(_req: Request, ctx: { params: { id: string } }) {
  try {
    const result = await finalizeUpload(ctx.params.id);
    return json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return handleError(error);
  }
}
