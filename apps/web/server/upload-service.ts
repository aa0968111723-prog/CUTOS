import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { SNIFF_BYTES, sniffContainer } from "@cutos/media";
import {
  UploadNotFoundError,
  UploadOffsetMismatchError,
  UploadTooLargeError,
  supportsResumableUpload,
  type ResumableUpload,
} from "@cutos/storage";
import type { UploadSessionRecord } from "@cutos/project-store";
import { config, effectiveChunkBytes, isAllowedMime, uploadLimits } from "./config.js";
import { adoptUploadedAsset, enqueueProbe } from "./editor-service.js";
import { HttpError } from "./errors.js";
import { logger } from "./logger.js";
import { getRuntime } from "./runtime.js";

/**
 * Streaming, resumable media ingress.
 *
 * The previous path read `Request.formData()`, took `file.arrayBuffer()`, and
 * then wrote a `Buffer` — three full copies of the video in the Node heap, plus
 * an ffprobe run, all inside one HTTP request. A phone uploading a 300 MB clip
 * over mobile data therefore held a request open for minutes against a proxy
 * that would time it out, while the server sat on ~1 GB of heap.
 *
 * Here the file arrives as a series of bounded chunks. Each chunk request
 * streams from the socket to disk and is answered in milliseconds; the browser
 * knows exactly how many bytes have landed; a dropped connection resumes at the
 * next byte; and `finalize` returns a project as soon as the bytes are sealed,
 * leaving ffprobe and analysis to durable jobs.
 *
 * Every limit is enforced server-side against the recorded session, never
 * against a client-supplied header.
 */

const uploadLog = logger.child({ component: "upload" });

export interface UploadSessionDTO {
  uploadId: string;
  status: UploadSessionRecord["status"];
  filename: string;
  sizeBytes: number;
  receivedBytes: number;
  mimeType: string;
  /** Chunk size the client should use; derived from the deployment's limits. */
  chunkBytes: number;
  expiresAt: number;
  projectId: string | null;
  errorCode: string | null;
}

/**
 * Project a session for the client.
 *
 * `storageKey` is deliberately absent: the browser has no business knowing
 * where bytes live on the server, and leaking it would hand a caller the raw
 * material for a traversal attempt.
 */
function toDTO(record: UploadSessionRecord): UploadSessionDTO {
  return {
    uploadId: record.id,
    status: record.status,
    filename: record.filename,
    sizeBytes: record.declaredBytes,
    receivedBytes: record.receivedBytes,
    mimeType: record.declaredMime,
    chunkBytes: effectiveChunkBytes(),
    expiresAt: record.expiresAt,
    projectId: record.projectId,
    errorCode: record.errorCode,
  };
}

/**
 * Strip a client-supplied filename down to a display label.
 *
 * It is never used to build a path — the storage key comes from the server's
 * own upload id — but it is rendered in the UI and stored, so separators,
 * control characters and unbounded length all have to go.
 */
export function sanitizeFilename(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[/\\]+/g, " ")
    // eslint-disable-next-line no-control-regex -- stripping C0/C1 controls is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    // Drop traversal tokens outright. They cannot reach a path from here, but
    // a label reading ".. .. etc passwd" is noise the user never typed.
    .replace(/(^|\s)\.+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function requireResumableStorage() {
  const { storage } = getRuntime();
  if (!supportsResumableUpload(storage)) {
    throw new HttpError(
      500,
      "STORAGE_FAILED",
      "The configured storage backend does not support resumable uploads.",
    );
  }
  return storage;
}

/**
 * Where a session's bytes are staged AND where they end up.
 *
 * The upload id doubles as the project id, so the resumable upload can be
 * sealed straight into its final key: no post-upload copy or move of a
 * half-gigabyte file, and a retried finalize resolves to the same project
 * before the idempotency claim even runs.
 *
 * The key is derived entirely from a server-issued UUID — no part of it comes
 * from the client, so there is nothing here for a traversal attempt to bend.
 */
function sourceKeyFor(uploadId: string): string {
  return `sources/${uploadId}/original`;
}

export interface CreateUploadInput {
  filename?: unknown;
  sizeBytes?: unknown;
  mimeType?: unknown;
}

/**
 * Open an upload session.
 *
 * Size and type are checked here, before a single byte is transferred: telling
 * someone on mobile data that their file is too big after 200 MB of upload is
 * indistinguishable from the bug this replaces.
 */
export async function createUploadSession(input: CreateUploadInput): Promise<UploadSessionDTO> {
  // Opening a session is the natural moment to reclaim space from uploads
  // nobody finished; throttled so a burst of picks does not sweep repeatedly.
  await maybeSweep();

  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isFinite(sizeBytes) || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new HttpError(400, "UPLOAD_INVALID", "A positive integer 'sizeBytes' is required.");
  }
  if (sizeBytes > config.maxUploadBytes) {
    throw new HttpError(
      413,
      "UPLOAD_TOO_LARGE",
      `File exceeds the ${Math.round(config.maxUploadBytes / 1024 / 1024)}MB limit.`,
      { maxUploadBytes: config.maxUploadBytes },
    );
  }
  const mimeType = typeof input.mimeType === "string" ? input.mimeType : "";
  // An empty type is common on Android pickers; the finalize-time sniff is the
  // real gate, so only an explicit, wrong type is refused up front.
  if (mimeType && !isAllowedMime(mimeType)) {
    throw new HttpError(415, "MEDIA_UNSUPPORTED", `Unsupported media type: ${mimeType}`);
  }

  const storage = requireResumableStorage();
  const uploadId = randomUUID();
  const storageKey = sourceKeyFor(uploadId);
  await storage.createUpload({ uploadId, key: storageKey });

  const now = Date.now();
  const { store } = getRuntime();
  const record = store.uploads.create({
    id: uploadId,
    status: "pending",
    filename: sanitizeFilename(input.filename),
    declaredBytes: sizeBytes,
    declaredMime: mimeType,
    receivedBytes: 0,
    storageKey,
    checksum: null,
    projectId: null,
    assetId: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + config.uploadSessionTtlMs,
  });
  uploadLog.info("upload session opened", { uploadId, sizeBytes, mimeType });
  return toDTO(record);
}

function requireSession(uploadId: string): UploadSessionRecord {
  const { store } = getRuntime();
  const record = store.uploads.get(uploadId);
  if (!record) throw new HttpError(404, "UPLOAD_NOT_FOUND", "Upload session not found.");
  return record;
}

/** Read-only status; this is what a resuming or returning client asks for. */
export function getUploadSession(uploadId: string): UploadSessionDTO {
  return toDTO(requireSession(uploadId));
}

function assertAppendable(record: UploadSessionRecord): void {
  if (record.status === "aborted") {
    throw new HttpError(410, "UPLOAD_ABORTED", "This upload was cancelled.");
  }
  if (record.status === "finalized") {
    throw new HttpError(409, "UPLOAD_INCOMPLETE", "This upload has already been finalized.");
  }
  if (record.expiresAt <= Date.now()) {
    throw new HttpError(410, "UPLOAD_ABORTED", "This upload session expired.");
  }
}

export interface AppendChunkInput {
  uploadId: string;
  offset: number;
  /** The raw request body. Consumed as a stream — never buffered. */
  body: Readable | ReadableStream<Uint8Array> | null;
  /** Declared body length, when the transport provides one. */
  contentLength?: number | null;
}

/**
 * Append one chunk at `offset`.
 *
 * The offset is authoritative: a chunk that does not start exactly where the
 * staged object ends is refused with the real offset attached, so the client
 * resyncs instead of silently corrupting the file.
 */
export async function appendUploadChunk(input: AppendChunkInput): Promise<UploadSessionDTO> {
  const record = requireSession(input.uploadId);
  assertAppendable(record);

  if (!Number.isInteger(input.offset) || input.offset < 0) {
    throw new HttpError(400, "UPLOAD_INVALID", "A non-negative integer offset is required.");
  }
  if (input.offset !== record.receivedBytes) {
    throw new HttpError(409, "UPLOAD_OFFSET_MISMATCH", "Chunk offset does not match the session.", {
      receivedBytes: record.receivedBytes,
    });
  }
  // Reject an over-sized chunk on its declared length before reading a byte.
  const declared = input.contentLength ?? null;
  if (declared !== null && declared > config.maxRequestBytes) {
    throw new HttpError(413, "UPLOAD_TOO_LARGE", "Chunk exceeds the per-request limit.", {
      maxRequestBytes: config.maxRequestBytes,
    });
  }
  if (declared !== null && record.receivedBytes + declared > record.declaredBytes) {
    throw new HttpError(413, "UPLOAD_TOO_LARGE", "Chunk would exceed the declared file size.");
  }

  const storage = requireResumableStorage();
  const { store } = getRuntime();
  let upload: ResumableUpload;
  try {
    upload = await storage.resumeUpload({ uploadId: record.id, key: record.storageKey });
  } catch (error) {
    if (error instanceof UploadNotFoundError || (error as Error).name === "UploadNotFoundError") {
      // The staged bytes are gone but the row survived (swept, or a wiped
      // volume). Say so plainly instead of accepting bytes into nothing.
      store.uploads.update(record.id, { status: "aborted", errorCode: "UPLOAD_ABORTED" });
      throw new HttpError(410, "UPLOAD_ABORTED", "The staged upload is no longer available.");
    }
    throw error;
  }

  const stream = toNodeStream(input.body);
  try {
    const result = await upload.append(input.offset, stream, {
      // Two ceilings at once: this file's declaration, and the deployment's.
      maxTotalBytes: Math.min(record.declaredBytes, config.maxUploadBytes),
    });
    const receivedBytes = result.receivedBytes;
    const updated = store.uploads.update(record.id, {
      status: receivedBytes >= record.declaredBytes ? "complete" : "uploading",
      receivedBytes,
    });
    return toDTO(updated);
  } catch (error) {
    // Persist however far the bytes actually got, so a resume starts there and
    // not from zero — that is the whole point of staging.
    const staged = await upload.size().catch(() => record.receivedBytes);
    store.uploads.update(record.id, { receivedBytes: staged, status: "uploading" });

    if (error instanceof UploadTooLargeError || (error as Error).name === "UploadTooLargeError") {
      throw new HttpError(413, "UPLOAD_TOO_LARGE", "Upload exceeds the declared file size.", {
        receivedBytes: staged,
      });
    }
    if (
      error instanceof UploadOffsetMismatchError ||
      (error as Error).name === "UploadOffsetMismatchError"
    ) {
      throw new HttpError(409, "UPLOAD_OFFSET_MISMATCH", "Chunk offset does not match the session.", {
        receivedBytes: staged,
      });
    }
    uploadLog.error("chunk append failed", {
      uploadId: record.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new HttpError(500, "STORAGE_FAILED", "Could not store the uploaded chunk.", {
      receivedBytes: staged,
    });
  }
}

/** Cancel a session and drop its staged bytes. Idempotent. */
export async function abortUploadSession(uploadId: string): Promise<UploadSessionDTO> {
  const record = requireSession(uploadId);
  if (record.status === "finalized") {
    // Cancelling after the project exists would orphan it; deleting the
    // project is a separate, explicit action.
    throw new HttpError(409, "UPLOAD_INCOMPLETE", "This upload has already been finalized.");
  }
  const storage = requireResumableStorage();
  await storage
    .resumeUpload({ uploadId: record.id, key: record.storageKey })
    .then((upload) => upload.abort())
    .catch(() => undefined);
  const { store } = getRuntime();
  const updated = store.uploads.update(record.id, {
    status: "aborted",
    errorCode: "UPLOAD_CANCELLED",
  });
  uploadLog.info("upload cancelled", { uploadId, receivedBytes: record.receivedBytes });
  return toDTO(updated);
}

export interface FinalizeResult {
  projectId: string;
  /** True when this call created the project; false when it replayed one. */
  created: boolean;
  /** Job that will read the media's real metadata. */
  probeJobId: string | null;
}

/**
 * Seal an upload into a project.
 *
 * Deliberately fast: it verifies the bytes, stores them immutably, creates the
 * project, and enqueues the probe. It does NOT run ffprobe, analysis, waveform
 * or transcription — those are durable jobs, because a phone must not hold an
 * HTTP request open while a server transcodes.
 *
 * Idempotent. A retried finalize returns the project the first call created.
 */
export async function finalizeUpload(uploadId: string): Promise<FinalizeResult> {
  const record = requireSession(uploadId);
  const { store } = getRuntime();

  if (record.status === "finalized") {
    if (!record.projectId) {
      throw new HttpError(500, "INTERNAL", "Finalized session has no project.");
    }
    return { projectId: record.projectId, created: false, probeJobId: null };
  }
  if (record.status === "aborted") {
    throw new HttpError(410, "UPLOAD_ABORTED", "This upload was cancelled.");
  }

  const storage = requireResumableStorage();
  const upload = await storage
    .resumeUpload({ uploadId: record.id, key: record.storageKey })
    .catch(() => {
      throw new HttpError(410, "UPLOAD_ABORTED", "The staged upload is no longer available.");
    });

  const staged = await upload.size();
  if (staged !== record.declaredBytes) {
    // An incomplete upload must never become a real media asset.
    store.uploads.update(record.id, { receivedBytes: staged });
    throw new HttpError(409, "UPLOAD_INCOMPLETE", "Not every declared byte has arrived.", {
      receivedBytes: staged,
      sizeBytes: record.declaredBytes,
    });
  }

  const sealed = await upload.complete().catch((error: unknown) => {
    uploadLog.error("sealing upload failed", {
      uploadId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new HttpError(500, "STORAGE_FAILED", "Could not store the uploaded file.");
  });

  // Sniff the real container. A declared content-type is client-supplied and
  // therefore not evidence; this is what stops a renamed script from being
  // registered as project media.
  const head = await readHead(record.storageKey, SNIFF_BYTES);
  if (!sniffContainer(head).looksLikeMedia) {
    await storage.delete(record.storageKey).catch(() => undefined);
    store.uploads.update(record.id, { status: "aborted", errorCode: "MEDIA_UNSUPPORTED" });
    throw new HttpError(415, "MEDIA_UNSUPPORTED", "The uploaded bytes are not a media container.");
  }

  const projectId = record.id;
  const assetId = `original_${projectId}`;
  // Claim BEFORE creating the project: whoever wins the claim creates it, and
  // a loser (retry, double-tap) replays instead of making a second project.
  const claim = store.uploads.claimFinalize(
    record.id,
    projectId,
    assetId,
    sealed.checksum,
    Date.now(),
  );
  if (!claim.claimed) {
    const winner = store.uploads.get(record.id)?.projectId;
    if (!winner) throw new HttpError(500, "INTERNAL", "Finalized session has no project.");
    return { projectId: winner, created: false, probeJobId: null };
  }

  adoptUploadedAsset({
    projectId,
    assetId,
    name: record.filename || "Imported video",
    storageKey: record.storageKey,
    sizeBytes: sealed.size,
    checksum: sealed.checksum,
    mimeType: record.declaredMime || "video/mp4",
  });

  const probeJobId = enqueueProbe(projectId);
  uploadLog.info("upload finalized", { uploadId, projectId, sizeBytes: sealed.size });
  return { projectId, created: true, probeJobId };
}

const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

async function maybeSweep(): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  await sweepExpiredUploads(now).catch(() => undefined);
}

/** Drop staged bytes for sessions nobody finished. Safe to call repeatedly. */
export async function sweepExpiredUploads(now = Date.now()): Promise<number> {
  const { store, storage } = getRuntime();
  if (!supportsResumableUpload(storage)) return 0;
  const expired = store.uploads.listExpired(now).filter((r) => r.status !== "aborted");
  for (const record of expired) {
    await storage
      .resumeUpload({ uploadId: record.id, key: record.storageKey })
      .then((upload) => upload.abort())
      .catch(() => undefined);
    store.uploads.update(record.id, { status: "aborted", errorCode: "UPLOAD_ABORTED" });
  }
  if (expired.length > 0) uploadLog.info("swept expired uploads", { count: expired.length });
  return expired.length;
}

export { uploadLimits };

async function readHead(key: string, bytes: number): Promise<Uint8Array> {
  const { storage } = getRuntime();
  const { size } = await storage.stat(key);
  if (size === 0) return new Uint8Array(0);
  const stream = storage.createReadStream(key, { start: 0, end: Math.min(bytes, size) - 1 });
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * Adapt whatever the runtime hands us as a request body into a Node stream.
 *
 * Both branches stay streaming: a `Readable.fromWeb` bridge does not buffer,
 * so the socket → disk path holds one chunk at a time regardless of which
 * server (Next.js route handler, plain `node:http`) produced the body.
 */
function toNodeStream(body: AppendChunkInput["body"]): Readable {
  if (!body) return Readable.from([]);
  if (body instanceof Readable) return body;
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}
