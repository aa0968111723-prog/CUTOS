/**
 * Chunked, resumable, cancellable media ingest — the browser half.
 *
 * The old client was `fetch(..., { body: FormData })`: no progress, no timeout,
 * no abort, no resume. When the network, the proxy or the server stalled, that
 * promise simply never settled, and the UI's single `busy` string stayed on
 * screen forever. Everything here exists to make that state unreachable:
 *
 *  - progress comes from real `upload.onprogress` bytes, never a fake animation;
 *  - every request has a deadline AND a stall watchdog, so nothing pends forever;
 *  - the user can abort at any moment, and staged bytes are released;
 *  - a dropped chunk resumes from the server's byte count instead of from zero;
 *  - every terminal path — success, failure, cancellation — emits a state, so a
 *    caller cannot be left "busy" with nothing in flight.
 *
 * It is transport-injectable so the whole state machine is testable without a
 * browser; `xhrTransport` is the real one (XHR, because `fetch` still cannot
 * report upload progress).
 */

import type {
  ProjectDTO,
  UploadFinalizeDTO,
  UploadLimitsDTO,
  UploadSessionDTO,
} from "./types.js";

/** Every state the ingest pipeline can be in. Replaces the old `busy` string. */
export type UploadPhase =
  | "idle"
  | "preparing"
  | "uploading"
  | "uploaded"
  | "probing"
  | "ready"
  | "failed"
  | "cancelled";

export interface UploadState {
  phase: UploadPhase;
  fileName: string;
  /** Total size of the chosen file, in bytes. */
  totalBytes: number;
  /** Bytes the server has confirmed, plus bytes in flight for the live chunk. */
  uploadedBytes: number;
  /** 0..1, derived from real byte counts. */
  progress: number;
  uploadId: string | null;
  projectId: string | null;
  /** Stable app error code; the UI maps it to zh-TW copy. */
  errorCode: string | null;
  /**
   * True when the bytes are stored but their metadata could not be read. The
   * fix is another probe, never another upload.
   */
  canRetryProbe: boolean;
}

export const IDLE_UPLOAD_STATE: UploadState = {
  phase: "idle",
  fileName: "",
  totalBytes: 0,
  uploadedBytes: 0,
  progress: 0,
  uploadId: null,
  projectId: null,
  errorCode: null,
  canRetryProbe: false,
};

/** An error carrying a stable app error code the UI can localize. */
export class UploadError extends Error {
  constructor(
    readonly code: string,
    message?: string,
    /** Whether retrying the same chunk could plausibly succeed. */
    readonly retryable = false,
  ) {
    super(message ?? code);
    this.name = "UploadError";
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface TransportRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: Blob | string | null;
  signal?: AbortSignal;
  /** Hard deadline for the whole request. */
  timeoutMs?: number;
  /** Called with cumulative bytes sent. This is where real progress comes from. */
  onUploadProgress?: (loadedBytes: number) => void;
}

export interface TransportResponse {
  status: number;
  body: unknown;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/**
 * XMLHttpRequest transport.
 *
 * `fetch` cannot report upload progress in any shipping browser — a request
 * body stream would need duplex support Android Chrome does not have — so the
 * choice here is XHR or a progress bar that lies. It is XHR.
 */
export const xhrTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(req.method, req.url, true);
    xhr.responseType = "text";
    if (req.timeoutMs) xhr.timeout = req.timeoutMs;
    for (const [key, value] of Object.entries(req.headers ?? {})) {
      xhr.setRequestHeader(key, value);
    }

    const onAbort = () => xhr.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => req.signal?.removeEventListener("abort", onAbort);

    if (req.onUploadProgress) {
      xhr.upload.onprogress = (event: ProgressEvent) => req.onUploadProgress?.(event.loaded);
    }
    xhr.onload = () => {
      cleanup();
      resolve({ status: xhr.status, body: parseBody(xhr.responseText) });
    };
    xhr.onerror = () => {
      cleanup();
      // XHR deliberately hides the cause (CORS, reset, DNS, radio handover);
      // all of them are "the transport died", which is retryable.
      reject(new UploadError("NETWORK_ERROR", "The network request failed.", true));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new UploadError("UPLOAD_TIMEOUT", "The request timed out.", true));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new UploadError("UPLOAD_CANCELLED", "The upload was cancelled.", false));
    };

    xhr.send(req.body ?? null);
  });

function parseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

/**
 * Map an HTTP status onto a stable app error code.
 *
 * The server's own `code` wins when it sends one; this covers the responses
 * that never reach application code — a proxy's 413, an ingress 502, a
 * gateway 504 — which is exactly the set that used to surface as a hang.
 */
export function codeForStatus(status: number, bodyCode?: string): string {
  if (bodyCode) return bodyCode;
  switch (status) {
    case 408:
      return "UPLOAD_TIMEOUT";
    case 409:
      return "UPLOAD_OFFSET_MISMATCH";
    case 410:
      return "UPLOAD_ABORTED";
    case 413:
      return "UPLOAD_TOO_LARGE";
    case 415:
      return "MEDIA_UNSUPPORTED";
    case 502:
    case 503:
    case 504:
      return "SERVICE_UNAVAILABLE";
    default:
      break;
  }
  if (status === 0) return "NETWORK_ERROR";
  if (status >= 500) return "INTERNAL";
  if (status === 404) return "UPLOAD_NOT_FOUND";
  return "UNKNOWN";
}

/** Codes where retrying the same chunk is worth doing. */
const RETRYABLE_CODES = new Set([
  "NETWORK_ERROR",
  "UPLOAD_TIMEOUT",
  "UPLOAD_STALLED",
  "SERVICE_UNAVAILABLE",
  "STORAGE_FAILED",
  "INTERNAL",
  // Not a failure so much as a desync: re-read the offset and continue.
  "UPLOAD_OFFSET_MISMATCH",
]);

export function isRetryableCode(code: string): boolean {
  return RETRYABLE_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Ingest pipeline
// ---------------------------------------------------------------------------

export interface IngestOptions {
  transport?: Transport;
  /** User cancellation. Aborting releases the server's staged bytes. */
  signal?: AbortSignal;
  onState?: (state: UploadState) => void;
  /** Deadline for a single chunk request. */
  requestTimeoutMs?: number;
  /**
   * How long a chunk may make no progress before it is treated as stalled.
   *
   * This is the guard the old code lacked entirely: a socket that is open but
   * moving no bytes looks identical to a working upload until you time it.
   */
  stallMs?: number;
  /** Attempts per chunk before the upload fails. */
  maxAttemptsPerChunk?: number;
  /** Overall ceiling on waiting for the background probe. */
  probeTimeoutMs?: number;
  /** Base path of the API; overridable for tests and embedding. */
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

interface ResolvedOptions extends Required<Omit<IngestOptions, "signal" | "onState">> {
  signal?: AbortSignal;
  onState?: (state: UploadState) => void;
}

function resolveOptions(opts: IngestOptions): ResolvedOptions {
  return {
    transport: opts.transport ?? xhrTransport,
    signal: opts.signal,
    onState: opts.onState,
    requestTimeoutMs: opts.requestTimeoutMs ?? 120_000,
    stallMs: opts.stallMs ?? 30_000,
    maxAttemptsPerChunk: opts.maxAttemptsPerChunk ?? 4,
    probeTimeoutMs: opts.probeTimeoutMs ?? 180_000,
    baseUrl: opts.baseUrl ?? "",
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

class Emitter {
  private state: UploadState;
  constructor(
    initial: UploadState,
    private readonly onState?: (state: UploadState) => void,
  ) {
    this.state = initial;
  }
  get current(): UploadState {
    return this.state;
  }
  set(patch: Partial<UploadState>): UploadState {
    const next = { ...this.state, ...patch };
    next.progress = next.totalBytes > 0 ? Math.min(1, next.uploadedBytes / next.totalBytes) : 0;
    this.state = next;
    this.onState?.(next);
    return next;
  }
}

/**
 * Run the whole ingest: session → chunks → finalize → probe.
 *
 * Never rejects for an expected outcome. Cancellation and failure both resolve
 * with a terminal state, because a caller that has to remember a `finally` to
 * clear its spinner will eventually forget one — which is the bug being fixed.
 */
export async function ingestVideo(file: File, options: IngestOptions = {}): Promise<UploadState> {
  const opts = resolveOptions(options);
  const emitter = new Emitter(
    {
      ...IDLE_UPLOAD_STATE,
      phase: "preparing",
      fileName: file.name,
      totalBytes: file.size,
    },
    opts.onState,
  );
  emitter.set({});

  let uploadId: string | null = null;
  try {
    const session = await createSession(file, opts);
    uploadId = session.uploadId;
    emitter.set({ phase: "uploading", uploadId, uploadedBytes: session.receivedBytes });

    await sendChunks(file, session, opts, emitter);

    const finalized = await finalize(session.uploadId, opts);
    emitter.set({
      phase: "uploaded",
      projectId: finalized.projectId,
      uploadedBytes: file.size,
    });

    // The bytes are safe from here on. Anything that goes wrong below is a
    // metadata problem, and must never be reported as "upload failed".
    emitter.set({ phase: "probing" });
    const project = await waitForMedia(finalized.projectId, opts);
    if (project.mediaStatus === "failed") {
      return emitter.set({
        phase: "failed",
        errorCode: project.mediaError ?? "PROBE_FAILED",
        canRetryProbe: true,
      });
    }
    return emitter.set({ phase: "ready" });
  } catch (error) {
    const code = toCode(error);
    if (code === "UPLOAD_CANCELLED") {
      // Release the server's staged bytes; best-effort, and never allowed to
      // turn a clean cancel into an error.
      if (uploadId) await abortSession(uploadId, opts).catch(() => undefined);
      return emitter.set({ phase: "cancelled", errorCode: null });
    }
    // A probe that timed out or failed leaves the asset intact and retryable.
    const afterUpload = emitter.current.projectId !== null;
    return emitter.set({
      phase: "failed",
      errorCode: code,
      canRetryProbe: afterUpload,
    });
  }
}

/**
 * Read the app error code off a thrown value.
 *
 * Matched by `name` rather than `instanceof`, the way the server's error
 * handler does: a bundler can produce two copies of this module, and an
 * `instanceof` that silently fails would downgrade a precise, retryable code
 * into an unretryable "UNKNOWN".
 */
function toCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { name?: unknown; code?: unknown };
    if (candidate.name === "UploadError" && typeof candidate.code === "string") {
      return candidate.code;
    }
    if (candidate.name === "AbortError") return "UPLOAD_CANCELLED";
  }
  return "UNKNOWN";
}

async function request(
  opts: ResolvedOptions,
  req: Omit<TransportRequest, "signal" | "timeoutMs"> & { timeoutMs?: number },
): Promise<unknown> {
  throwIfAborted(opts.signal);
  const response = await opts.transport({
    ...req,
    signal: opts.signal,
    timeoutMs: req.timeoutMs ?? opts.requestTimeoutMs,
  });
  return unwrap(response);
}

function unwrap(response: TransportResponse): unknown {
  if (response.status >= 200 && response.status < 300) return response.body;
  const body = (response.body ?? {}) as { code?: string; message?: string };
  const code = codeForStatus(response.status, body.code);
  throw new UploadError(code, body.message ?? `HTTP ${response.status}`, isRetryableCode(code));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UploadError("UPLOAD_CANCELLED", "The upload was cancelled.");
}

async function createSession(file: File, opts: ResolvedOptions): Promise<UploadSessionDTO> {
  return (await request(opts, {
    method: "POST",
    url: `${opts.baseUrl}/api/uploads`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      sizeBytes: file.size,
      mimeType: file.type,
    }),
  })) as UploadSessionDTO;
}

async function readSession(uploadId: string, opts: ResolvedOptions): Promise<UploadSessionDTO> {
  return (await request(opts, {
    method: "GET",
    url: `${opts.baseUrl}/api/uploads/${uploadId}`,
  })) as UploadSessionDTO;
}

async function abortSession(uploadId: string, opts: ResolvedOptions): Promise<void> {
  // Cancellation must reach the server even though the user's signal is
  // already aborted, so this call deliberately carries no signal.
  await opts
    .transport({
      method: "DELETE",
      url: `${opts.baseUrl}/api/uploads/${uploadId}`,
      timeoutMs: 10_000,
    })
    .catch(() => undefined);
}

async function finalize(uploadId: string, opts: ResolvedOptions): Promise<UploadFinalizeDTO> {
  return (await request(opts, {
    method: "POST",
    url: `${opts.baseUrl}/api/uploads/${uploadId}/finalize`,
  })) as UploadFinalizeDTO;
}

/**
 * Send the file one bounded chunk at a time.
 *
 * The server's `receivedBytes` — not the client's optimism — drives the loop,
 * so a chunk that half-arrived before the connection dropped is continued, not
 * repeated, and a desynced client resyncs instead of corrupting the object.
 */
async function sendChunks(
  file: File,
  session: UploadSessionDTO,
  opts: ResolvedOptions,
  emitter: Emitter,
): Promise<void> {
  // The server decides the chunk size — it is the side that knows the
  // deployment's request limit. Only a nonsensical value is overridden.
  const chunkBytes = session.chunkBytes > 0 ? session.chunkBytes : 5 * 1024 * 1024;
  let offset = session.receivedBytes;
  let attempt = 0;

  while (offset < file.size) {
    throwIfAborted(opts.signal);
    const end = Math.min(offset + chunkBytes, file.size);
    const confirmed = offset;
    try {
      const updated = await sendChunk(file.slice(offset, end), session.uploadId, offset, opts, {
        onProgress: (loaded) => emitter.set({ uploadedBytes: confirmed + loaded }),
      });
      offset = updated.receivedBytes;
      emitter.set({ uploadedBytes: offset });
      attempt = 0;
    } catch (error) {
      const code = toCode(error);
      if (code === "UPLOAD_CANCELLED") throw error;
      if (!isRetryableCode(code)) throw error;

      attempt += 1;
      if (attempt >= opts.maxAttemptsPerChunk) {
        throw new UploadError(code, `Giving up after ${attempt} attempts.`, false);
      }
      // Ask the server where it actually got to. This is what makes a dropped
      // connection cost the remainder of one chunk instead of the whole file.
      await opts.sleep(backoffMs(attempt));
      throwIfAborted(opts.signal);
      const fresh = await readSession(session.uploadId, opts);
      if (fresh.status === "aborted") {
        throw new UploadError("UPLOAD_ABORTED", "The upload session was cancelled.", false);
      }
      offset = fresh.receivedBytes;
      emitter.set({ uploadedBytes: offset });
    }
  }
}

/** Exponential backoff, capped so a phone on a bad train line still recovers. */
function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1));
}

async function sendChunk(
  blob: Blob,
  uploadId: string,
  offset: number,
  opts: ResolvedOptions,
  hooks: { onProgress: (loaded: number) => void },
): Promise<UploadSessionDTO> {
  const stall = new StallWatchdog(opts.stallMs, opts.signal);
  try {
    const response = await opts.transport({
      method: "PATCH",
      url: `${opts.baseUrl}/api/uploads/${uploadId}?offset=${offset}`,
      headers: { "content-type": "application/octet-stream" },
      body: blob,
      signal: stall.signal,
      timeoutMs: opts.requestTimeoutMs,
      onUploadProgress: (loaded) => {
        stall.beat();
        hooks.onProgress(loaded);
      },
    });
    return unwrap(response) as UploadSessionDTO;
  } catch (error) {
    // The watchdog aborts the request, so the transport reports a cancellation;
    // translate it back into the reason it actually happened.
    if (stall.stalled && toCode(error) === "UPLOAD_CANCELLED") {
      throw new UploadError("UPLOAD_STALLED", "The upload stopped making progress.", true);
    }
    throw error;
  } finally {
    stall.dispose();
  }
}

/**
 * Aborts a request that stops moving bytes.
 *
 * A stalled-but-open socket is the failure mode that produced the permanent
 * spinner: nothing errors, nothing completes. Bounding it is what turns that
 * into a retry.
 */
class StallWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly controller = new AbortController();
  private readonly onUserAbort = () => this.controller.abort();
  private readonly userSignal?: AbortSignal;
  stalled = false;

  constructor(
    private readonly stallMs: number,
    userSignal?: AbortSignal,
  ) {
    this.userSignal = userSignal;
    if (userSignal?.aborted) this.controller.abort();
    userSignal?.addEventListener("abort", this.onUserAbort, { once: true });
    this.beat();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  beat(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.stalled = true;
      this.controller.abort();
    }, this.stallMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.userSignal?.removeEventListener("abort", this.onUserAbort);
  }
}

/**
 * Poll the project until its media has been probed.
 *
 * Bounded: an unbounded poll is the same never-settling failure in a different
 * shape. Timing out here reports a probe problem on a project that already
 * exists, never a lost upload.
 */
export async function waitForMedia(
  projectId: string,
  options: IngestOptions = {},
): Promise<ProjectDTO> {
  const opts = resolveOptions(options);
  const deadline = Date.now() + opts.probeTimeoutMs;
  let delay = 400;
  for (;;) {
    throwIfAborted(opts.signal);
    const project = (await request(opts, {
      method: "GET",
      url: `${opts.baseUrl}/api/projects/${projectId}`,
    })) as ProjectDTO;
    if (project.mediaStatus === "ready" || project.mediaStatus === "failed") return project;
    if (Date.now() >= deadline) {
      throw new UploadError("PROBE_FAILED", "Timed out waiting for the media probe.", true);
    }
    await opts.sleep(delay);
    delay = Math.min(2_000, Math.round(delay * 1.4));
  }
}

/** Ask the server to read the media again, without re-uploading it. */
export async function retryProbe(
  projectId: string,
  options: IngestOptions = {},
): Promise<{ jobId: string }> {
  const opts = resolveOptions(options);
  return (await request(opts, {
    method: "POST",
    url: `${opts.baseUrl}/api/projects/${projectId}/probe`,
  })) as { jobId: string };
}

/** Read the deployment's real upload limits (max size, chunk size). */
export async function fetchUploadLimits(options: IngestOptions = {}): Promise<UploadLimitsDTO> {
  const opts = resolveOptions(options);
  return (await request(opts, {
    method: "GET",
    url: `${opts.baseUrl}/api/uploads`,
  })) as UploadLimitsDTO;
}
