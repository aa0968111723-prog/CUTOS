import { runReadinessCheck } from "../../../server/diagnostics.js";
import { handleError, json } from "../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether this deployment can genuinely accept video work.
 *
 * Unlike `/api/health`, this one is a gate: 200 means a user can upload a video
 * and have it read, and 503 means they cannot. It is the endpoint to point a
 * platform readiness probe at, and the one the UI asks before it offers an
 * upload button — because telling someone their deployment is broken is far
 * cheaper before they pick a 300 MB file than halfway through sending it.
 *
 * The body separates `canAcceptUploads` from `canProcessMedia` on purpose.
 * Losing ffprobe is serious but leaves the user's bytes safe and their
 * workspace reachable; losing the data directory destroys an upload the moment
 * it is accepted. Collapsing those into one flag would either block people
 * needlessly or let them upload into a void.
 */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const report = await runReadinessCheck({ fresh: params.get("fresh") === "1" });
    return json(report, {
      status: report.ready ? 200 : 503,
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (error) {
    return handleError(error);
  }
}
