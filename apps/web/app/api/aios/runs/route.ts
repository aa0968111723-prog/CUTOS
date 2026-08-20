import { z } from "zod";
import {
  isOrchestratorConfigured,
  listAiosRuns,
  reconcileAiosRuns,
  submitAiosRun,
} from "../../../../server/aios-orchestrator-service.js";
import { errorResponse, handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CUTOS → AIOS orchestration, reachable in production.
 *
 * `submitAiosRun` existed with no caller outside its own tests: the whole
 * direction was unreachable from a running CUTOS, which is exactly why nobody
 * noticed that ai_os served none of the endpoints it targets. Routing it is
 * what makes the adapter a feature rather than a library.
 *
 * The capability is an abstract intent (`video.highlight.package`), never a
 * step list, a model name or a vendor — which backend serves it is entirely an
 * AIOS decision.
 */
const SubmitSchema = z.object({
  projectId: z.string().min(1),
  goal: z.string().min(1).max(4_000),
  capability: z.string().min(1).max(120),
  query: z.string().max(4_000).optional(),
  qualityProfile: z.enum(["fast", "balanced", "quality", "local"]).optional(),
  deadlineMs: z.number().int().positive().optional(),
  withContext: z.boolean().optional(),
  targetDurationMs: z.number().int().positive().optional(),
});

export async function POST(req: Request) {
  try {
    if (!isOrchestratorConfigured()) {
      // Not an error state: a CUTOS deployment with no AIOS is a valid one.
      return errorResponse(503, "AIOS_UNAVAILABLE", "AIOS orchestration is not configured.");
    }
    const parsed = SubmitSchema.safeParse(await req.json());
    if (!parsed.success) {
      return errorResponse(400, "VALIDATION_FAILED", "Invalid AIOS run request.");
    }
    const { projectId, goal, capability, ...rest } = parsed.data;
    return json(await submitAiosRun({ projectId, goal, capability, ...rest }));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * List this project's AIOS handles, reconciling first.
 *
 * Reconciliation is the crash-recovery path: a handle persisted before the
 * submit call, whose process then died, is resolved by asking AIOS what
 * happened rather than by resubmitting and risking a second run.
 */
export async function GET(req: Request) {
  try {
    const projectId = new URL(req.url).searchParams.get("projectId");
    if (!projectId) return errorResponse(400, "VALIDATION_FAILED", "projectId is required.");
    if (!isOrchestratorConfigured()) return json({ configured: false, runs: [] });
    await reconcileAiosRuns(projectId);
    return json({ configured: true, runs: listAiosRuns(projectId) });
  } catch (error) {
    return handleError(error);
  }
}
