import { detectSilence } from "@cutos/media";
import { store } from "../../../../../server/store.js";
import { jobs } from "../../../../../server/jobs.js";
import { handleError, json } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AnalyzeBody {
  thresholdDb?: number;
  minSilenceMs?: number;
}

/** Kick off silence analysis as a background job. */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const project = store.require(ctx.params.id);
    const body = (await req.json().catch(() => ({}))) as AnalyzeBody;
    const thresholdDb = body.thresholdDb ?? -30;
    const minSilenceMs = body.minSilenceMs ?? 700;

    const job = jobs.start("analyze", async () => {
      const silences = await detectSilence(project.sourcePath, {
        thresholdDb,
        minSilenceMs,
        sourceDurationMs: project.source.durationMs,
      });
      project.analysis = { thresholdDb, minSilenceMs, silences };
    });

    return json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    return handleError(error);
  }
}
