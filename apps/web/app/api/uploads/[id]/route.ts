import {
  abortUploadSession,
  appendUploadChunk,
  getUploadSession,
} from "../../../../server/upload-service.js";
import { errorResponse, handleError, json } from "../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where a resumed upload asks "how far did I get?".
 *
 * The server's staged byte count is authoritative — a client that lost its
 * connection, or a phone whose tab was frozen in the background, recovers by
 * reading this rather than by guessing or restarting.
 */
export async function GET(_req: Request, ctx: { params: { id: string } }) {
  try {
    return json(getUploadSession(ctx.params.id));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Append one chunk of raw bytes at `?offset=`.
 *
 * The body is `application/octet-stream` and is consumed as a stream: it never
 * becomes a Buffer, a FormData part, or an ArrayBuffer on this side.
 */
export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  try {
    const offset = Number.parseInt(new URL(req.url).searchParams.get("offset") ?? "", 10);
    if (!Number.isInteger(offset)) {
      return errorResponse(400, "UPLOAD_INVALID", "An integer 'offset' query parameter is required.");
    }
    const header = req.headers.get("content-length");
    const contentLength = header === null ? null : Number.parseInt(header, 10);
    const session = await appendUploadChunk({
      uploadId: ctx.params.id,
      offset,
      body: req.body,
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
    });
    return json(session);
  } catch (error) {
    return handleError(error);
  }
}

/** Cancel an in-flight upload and drop its staged bytes. */
export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  try {
    return json(await abortUploadSession(ctx.params.id));
  } catch (error) {
    return handleError(error);
  }
}
