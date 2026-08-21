import {
  cancelAiosRun,
  getAiosRun,
  resumeAiosRun,
} from "../../../../../server/aios-orchestrator-service.js";
import {
  assertAiosAuthorized,
  AiosUnauthorizedError,
  credentialFromHeaders,
} from "../../../../../server/aios-auth.js";
import { errorResponse, handleError, json } from "../../../../../server/http.js";

/** Same credential as the submit route: a run handle is not public state. */
function guard(req: Request): Response | null {
  try {
    assertAiosAuthorized(credentialFromHeaders(req.headers));
    return null;
  } catch (error) {
    if (!(error instanceof AiosUnauthorizedError)) throw error;
    return errorResponse(401, "VALIDATION_FAILED", error.message);
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { handleId: string } };

/** Poll one AIOS run handle. */
export async function GET(req: Request, { params }: Params) {
  try {
    const denied = guard(req);
    if (denied) return denied;
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
    const denied = guard(req);
    if (denied) return denied;
    const body = (await req.json().catch(() => ({}))) as { action?: unknown };
    if (body.action === "cancel") return json(await cancelAiosRun(params.handleId));
    if (body.action === "resume") return json(await resumeAiosRun(params.handleId));
    return errorResponse(400, "VALIDATION_FAILED", "action must be 'cancel' or 'resume'.");
  } catch (error) {
    return handleError(error);
  }
}
