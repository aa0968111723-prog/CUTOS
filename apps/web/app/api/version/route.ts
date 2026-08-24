import { buildInfo } from "../../../server/build-info.js";
import { handleError, json } from "../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What build is actually serving this request.
 *
 * This endpoint exists because "is production on the latest main?" was, for a
 * while, unanswerable: the site looked deployed, the repository looked merged,
 * and the only evidence to the contrary was a user watching a spinner that had
 * already been deleted from the codebase.
 *
 * `uploadProtocolVersion` is the field to read first. It is 2 on any build that
 * contains the streaming, resumable ingress; a deployment reporting 1, or
 * answering 404 here at all, is running code from before that fix regardless of
 * what its dashboard says.
 */
export async function GET() {
  try {
    // Never cached: a stale version response would recreate the exact
    // uncertainty this endpoint exists to remove.
    return json(buildInfo(), {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (error) {
    return handleError(error);
  }
}
