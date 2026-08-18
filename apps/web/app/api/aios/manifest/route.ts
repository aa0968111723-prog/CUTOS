import { getAiosManifest } from "../../../../server/aios-bridge.js";
import { handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Capability manifest an AIOS agent can register/consume to drive CUTOS. */
export async function GET() {
  try {
    return json(getAiosManifest());
  } catch (error) {
    return handleError(error);
  }
}
