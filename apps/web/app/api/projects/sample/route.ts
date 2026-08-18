import { join } from "node:path";
import { probe, synthesizeSample } from "@cutos/media";
import { ensureDataDirs, paths } from "../../../../server/paths.js";
import { store } from "../../../../server/store.js";
import { toProjectDTO } from "../../../../server/dto.js";
import { handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a project from a synthesized demo clip (no upload required). */
export async function POST() {
  try {
    await ensureDataDirs();
    const samplePath = join(paths.samples, "demo-12s.mp4");
    await synthesizeSample(samplePath);

    const info = await probe(samplePath);
    const project = store.create({
      name: "Demo clip (12s)",
      source: {
        id: "sample",
        uri: samplePath,
        durationMs: info.durationMs,
        hasAudio: info.hasAudio,
      },
      sourcePath: samplePath,
      width: info.width,
      height: info.height,
    });

    return json(toProjectDTO(project), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
