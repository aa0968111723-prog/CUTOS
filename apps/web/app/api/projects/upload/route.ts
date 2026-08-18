import { getProject, importUpload } from "../../../../server/editor-service.js";
import { errorResponse, handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Import a video by upload; validated for size/mime and stored immutably. */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return errorResponse(400, "Expected a 'file' field containing a video.");
    }
    const id = await importUpload(file);
    return json(getProject(id), { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
