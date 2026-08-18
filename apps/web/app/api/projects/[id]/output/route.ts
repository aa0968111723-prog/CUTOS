import { store } from "../../../../../server/store.js";
import { serveFile } from "../../../../../server/serveFile.js";
import { errorResponse, handleError } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: { id: string } }) {
  try {
    const project = store.require(ctx.params.id);
    if (!project.output) {
      return errorResponse(404, "No export has been rendered yet.");
    }
    return await serveFile(project.output.path, req);
  } catch (error) {
    return handleError(error);
  }
}
