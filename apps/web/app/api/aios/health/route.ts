import { checkAiosHealth } from "../../../../server/aios-bridge.js";
import { handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Connectivity probe for the configured AIOS kernel (inbound integration). */
export async function GET() {
  try {
    return json(await checkAiosHealth());
  } catch (error) {
    return handleError(error);
  }
}
