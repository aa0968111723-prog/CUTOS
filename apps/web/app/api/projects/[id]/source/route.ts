import { store } from "../../../../../server/store.js";
import { serveFile } from "../../../../../server/serveFile.js";
import { handleError } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: { id: string } }) {
  try {
    const project = store.require(ctx.params.id);
    return await serveFile(project.sourcePath, req);
  } catch (error) {
    return handleError(error);
  }
}
