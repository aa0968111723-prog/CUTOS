import { listProjects } from "../../../server/editor-service.js";
import { handleError, json } from "../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ projects: listProjects() });
  } catch (error) {
    return handleError(error);
  }
}
