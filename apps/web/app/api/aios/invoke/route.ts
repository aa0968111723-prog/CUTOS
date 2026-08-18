import { z } from "zod";
import { invokeAiosCapability } from "../../../../server/aios-bridge.js";
import { errorResponse, handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});

/** Single validated entrypoint for an AIOS agent to invoke a CUTOS capability. */
export async function POST(req: Request) {
  try {
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return errorResponse(400, "VALIDATION_FAILED", "name is required.");
    return json(await invokeAiosCapability(parsed.data.name, parsed.data.args ?? {}));
  } catch (error) {
    return handleError(error);
  }
}
