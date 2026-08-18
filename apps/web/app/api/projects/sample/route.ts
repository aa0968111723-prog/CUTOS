import { getProject, importSample } from "../../../../server/editor-service.js";
import { handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a project from a synthesized demo clip (no upload required). */
export async function POST() {
  try {
    const id = await importSample();
    return json(getProject(id), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
