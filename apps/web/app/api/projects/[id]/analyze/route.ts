import { z } from "zod";
import { enqueueAnalyze } from "../../../../../server/editor-service.js";
import { handleError, json } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z
  .object({ thresholdDb: z.number().optional(), minSilenceMs: z.number().int().positive().optional() })
  .optional();

export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const body = BodySchema.parse(await req.json().catch(() => ({})));
    const jobId = enqueueAnalyze(ctx.params.id, body);
    return json({ jobId }, { status: 202 });
  } catch (error) {
    return handleError(error);
  }
}
