/**
 * The media-ingress contract version — the single source of truth.
 *
 * 1 — the original `POST /api/projects/upload`: one multipart request,
 *     `Request.formData()`, `file.arrayBuffer()`, and ffprobe run inline. No
 *     progress, no resume, no cancel.
 * 2 — `POST /api/uploads` → `PATCH /api/uploads/:id` → `POST …/finalize`:
 *     bounded, streaming, resumable chunks, with the probe moved to a durable
 *     background job.
 *
 * It lives here, free of any Node import, so the browser bundle and the server
 * can both read the same constant. That matters: comparing what the server
 * reports against what this build expects is what lets the 系統狀態 panel say
 * "the deployed server predates the upload fix" without anyone having to reason
 * about commit graphs.
 *
 * Bump it whenever the wire protocol changes in a way a client can observe.
 */
export const UPLOAD_PROTOCOL_VERSION = 2;
