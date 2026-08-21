import { handleInvokeBody } from "../../../../server/aios-bridge.js";
import { credentialFromHeaders } from "../../../../server/aios-auth.js";
import { handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Single validated entrypoint for an AIOS agent to invoke a CUTOS capability.
 *
 * Accepts both the cutos.agent.v2 envelope (capability + correlation) and the
 * legacy v1 shape ({ name, args }); the response mirrors whichever was sent.
 * A v2 governance failure is a 200 with `ok:false` so the caller can read the
 * typed error code, approval request and correlation without parsing HTTP.
 *
 * Requires `CUTOS_API_KEY` (presented as `Authorization: Bearer` or
 * `x-api-key`). The check is enforced inside `handleInvokeBody`, not here, so
 * no transport can accidentally skip it.
 */
export async function POST(req: Request) {
  try {
    const dispatched = await handleInvokeBody(
      await req.json().catch(() => ({})),
      credentialFromHeaders(req.headers),
    );
    return json(dispatched.response);
  } catch (error) {
    return handleError(error);
  }
}
