import { runHealthChecks } from "../../../server/diagnostics.js";
import { handleError, json } from "../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-subsystem health. Never a bare `{ ok: true }`.
 *
 * A single boolean is exactly as useful as no endpoint at all: the deployment
 * this was written for was "up" the whole time it was unusable. What an
 * operator needs is which part is broken, why, and what to change — so every
 * subsystem reports itself, including the ones that are fine.
 *
 * Answers 200 by default even when subsystems are down, because a diagnostic
 * endpoint that disappears under failure is useless precisely when it matters,
 * and a platform health probe pointed here would restart the container in a
 * loop rather than let anyone read the report. Pass `?strict=1` to get 503 on
 * failure (for a probe that genuinely wants that), or use `/api/ready`, which
 * is the endpoint designed to gate traffic.
 *
 * `?fresh=1` bypasses the short memoisation of the ffmpeg/ffprobe checks.
 */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const report = await runHealthChecks({ fresh: params.get("fresh") === "1" });
    const strict = params.get("strict") === "1";
    return json(report, {
      status: strict && report.status === "down" ? 503 : 200,
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (error) {
    return handleError(error);
  }
}
