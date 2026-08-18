import { getRuntime } from "../../../../../server/runtime.js";
import { serveStorageObject } from "../../../../../server/serveFile.js";
import { errorResponse, handleError } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: { id: string } }) {
  try {
    const { store, storage } = getRuntime();
    const asset = store.getAssetByKind(ctx.params.id, "export");
    if (!asset) return errorResponse(404, "EXPORT_FAILED", "No export has been rendered yet.");
    return await serveStorageObject(storage, asset.storageKey, req);
  } catch (error) {
    return handleError(error);
  }
}
