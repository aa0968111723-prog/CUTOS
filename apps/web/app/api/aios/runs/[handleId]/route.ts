import {
  cancelAiosRun,
  getAiosRun,
  resumeAiosRun,
} from "../../../../../server/aios-orchestrator-service.js";
import { errorResponse, handleError, json } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { handleId: string } };

/** Poll one AIOS run handle. */
export async function GET(_req: Request, { params }: Params) {
  try {
    return json(await getAiosRun(params.handleId));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Cancel or resume a run.
 *
 * `action` is a closed set, not a method name: there is deliberately no way to
 * name an arbitrary orchestrator method from the wire.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: unknown };
    if (body.action === "cancel") return json(await cancelAiosRun(params.handleId));
    if (body.action === "resume") return json(await resumeAiosRun(params.handleId));
    return errorResponse(400, "VALIDATION_FAILED", "action must be 'cancel' or 'resume'.");
  } catch (error) {
    return handleError(error);
  }
}
