import { createUploadSession, uploadLimits } from "../../../server/upload-service.js";
import { handleError, json } from "../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Advertise the deployment's real upload limits.
 *
 * The client asks before it picks a chunk size, so a deployment behind a proxy
 * with a small body limit is configured in one place instead of discovered as
 * a wall of 413s halfway through someone's video.
 */
export async function GET() {
  return json(uploadLimits());
}

/** Open a resumable upload session. No bytes are transferred by this call. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return json(await createUploadSession(body), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
