import { deleteProject, getProject } from "../../../../server/editor-service.js";
import { handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  try {
    return json(getProject(ctx.params.id));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  try {
    await deleteProject(ctx.params.id);
    return json({ ok: true });
  } catch (error) {
    return handleError(error);
  }
}
