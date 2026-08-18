import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { probe } from "@cutos/media";
import { ensureDataDirs, paths } from "../../../../server/paths.js";
import { store } from "../../../../server/store.js";
import { toProjectDTO } from "../../../../server/dto.js";
import { errorResponse, handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Import a video by upload. The uploaded file is stored immutably and probed. */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return errorResponse(400, "Expected a 'file' field containing a video.");
    }

    await ensureDataDirs();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "upload.mp4";
    const storedName = `${randomUUID()}-${safeName}`;
    const destPath = join(paths.sources, storedName);
    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(destPath, bytes);

    const info = await probe(destPath);
    if (!info.hasVideo) {
      return errorResponse(400, "Uploaded file does not contain a video stream.");
    }

    const project = store.create({
      name: file.name || "Imported video",
      source: {
        id: storedName,
        uri: destPath,
        durationMs: info.durationMs,
        hasAudio: info.hasAudio,
      },
      sourcePath: destPath,
      width: info.width,
      height: info.height,
    });

    return json(toProjectDTO(project), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
