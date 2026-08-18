import { join } from "node:path";
import { exportTimeline } from "@cutos/media";
import { timelineDurationMs } from "@cutos/timeline";
import { ensureDataDirs, paths } from "../../../../../server/paths.js";
import { store } from "../../../../../server/store.js";
import { jobs } from "../../../../../server/jobs.js";
import { errorResponse, handleError, json } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Render the current timeline to a file via FFmpeg as a background job. */
export async function POST(_req: Request, ctx: { params: { id: string } }) {
  try {
    const project = store.require(ctx.params.id);
    const timeline = project.history.current;
    if (timelineDurationMs(timeline) <= 0) {
      return errorResponse(409, "Timeline is empty; nothing to export.");
    }

    await ensureDataDirs();
    const outputPath = join(paths.exports, `${project.id}.mp4`);

    const job = jobs.start("export", async () => {
      const result = await exportTimeline({
        inputPath: project.sourcePath,
        timeline,
        outputPath,
      });
      project.output = {
        path: result.outputPath,
        durationMs: result.durationMs,
        createdAtMs: Date.now(),
      };
    });

    return json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    return handleError(error);
  }
}
