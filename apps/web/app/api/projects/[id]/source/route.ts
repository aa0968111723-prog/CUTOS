import { getRuntime } from "../../../../../server/runtime.js";
import { serveStorageObject } from "../../../../../server/serveFile.js";
import { errorResponse, handleError } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: { id: string } }) {
  try {
    const { store, storage } = getRuntime();
    const asset = store.getAssetByKind(ctx.params.id, "original");
    if (!asset) return errorResponse(404, "MEDIA_MISSING", "No source media.");
    return await serveStorageObject(storage, asset.storageKey, req, asset.mimeType);
  } catch (error) {
    return handleError(error);
  }
}
