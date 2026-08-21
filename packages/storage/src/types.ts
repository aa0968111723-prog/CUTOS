import type { Readable } from "node:stream";

export interface PutResult {
  key: string;
  size: number;
  /** Lowercase hex SHA-256 of the stored bytes, used for cache keys/integrity. */
  checksum: string;
}

export interface StatResult {
  size: number;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Object-storage abstraction. The core domain references media by opaque
 * `storageKey`s, never by absolute local paths, so the backend (local disk
 * today; S3/R2/GCS later) can change without touching domain code.
 *
 * Keys are POSIX-style relative paths (e.g. `sources/<id>/original.mp4`).
 * Implementations MUST reject path traversal.
 */
export interface StorageAdapter {
  put(key: string, data: Buffer | Readable): Promise<PutResult>;
  /** Import an existing file into storage (optionally moving it). */
  putFile(key: string, sourcePath: string, opts?: { move?: boolean }): Promise<PutResult>;
  get(key: string): Promise<Buffer>;
  createReadStream(key: string, range?: ByteRange): Readable;
  stat(key: string): Promise<StatResult>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /**
   * Run `fn` with a real local filesystem path for the object (required by
   * FFmpeg). Local backends pass their real path; remote backends would
   * materialize to a temp file and clean it up afterwards.
   */
  withLocalFile<T>(key: string, fn: (path: string) => Promise<T>): Promise<T>;
  /** Allocate a path inside the temp workspace (the file is not yet created). */
  tempFile(ext?: string): string;
  /** Remove everything in the temp workspace. */
  cleanupTemp(): Promise<void>;
}

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${JSON.stringify(key)}`);
    this.name = "InvalidStorageKeyError";
  }
}

export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = "StorageObjectNotFoundError";
  }
}

/**
 * Validate and normalize a storage key. Rejects absolute paths, `..` segments,
 * backslashes and empty keys to prevent path traversal.
 */
export function assertValidKey(key: string): string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) {
    throw new InvalidStorageKeyError(key);
  }
  if (key.includes("\\") || key.includes("\0")) {
    throw new InvalidStorageKeyError(key);
  }
  const segments = key.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new InvalidStorageKeyError(key);
  }
  if (key.startsWith("/")) {
    throw new InvalidStorageKeyError(key);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Resumable (chunked) uploads
//
// A browser must be able to hand CUTOS a 500 MB video without any single HTTP
// request carrying it, and without the file ever existing as a Buffer in the
// server's heap. That means the transport is a sequence of bounded, ordered
// byte ranges appended to one staged object which is sealed once, and which
// survives a dropped connection so the client resumes at the byte it reached
// instead of at zero.
// ---------------------------------------------------------------------------

/** A staged, append-only object that is not yet a real storage object. */
export interface ResumableUpload {
  /** Server-issued id; also the staging location, so resume needs nothing else. */
  readonly uploadId: string;
  /** The key the object takes once {@link complete} seals it. */
  readonly key: string;
  /** Bytes durably staged so far — the offset the next append must start at. */
  size(): Promise<number>;
  /**
   * Append `data` at `offset`. `offset` MUST equal the current staged size;
   * a mismatch throws {@link UploadOffsetMismatchError} carrying the real
   * offset so the caller can resume rather than restart.
   *
   * A partial append (connection dropped mid-body) is not rolled back: the
   * staged bytes remain a byte-exact prefix of the file, which is precisely
   * what makes resume possible. The thrown error still reports the new size.
   */
  append(
    offset: number,
    data: Readable | Buffer,
    opts?: { maxTotalBytes?: number },
  ): Promise<AppendResult>;
  /** Seal the staged bytes into `key`, returning size + checksum. */
  complete(): Promise<PutResult>;
  /** Discard the staged bytes. Safe to call on an already-discarded upload. */
  abort(): Promise<void>;
}

export interface AppendResult {
  /** Total bytes staged after this append. */
  receivedBytes: number;
  /** Bytes written by this call. */
  writtenBytes: number;
}

/**
 * A {@link StorageAdapter} that can stage an object across many requests.
 *
 * Kept separate from {@link StorageAdapter} so a backend can be added without
 * resumability; call {@link supportsResumableUpload} to branch. The local disk
 * backend implements it fully — a remote backend would map `createUpload` to
 * S3 `CreateMultipartUpload` (or a GCS resumable session) and `complete` to
 * `CompleteMultipartUpload`.
 */
export interface ResumableUploadAdapter extends StorageAdapter {
  createUpload(input: { uploadId: string; key: string }): Promise<ResumableUpload>;
  resumeUpload(input: { uploadId: string; key: string }): Promise<ResumableUpload>;
}

export function supportsResumableUpload(
  adapter: StorageAdapter,
): adapter is ResumableUploadAdapter {
  const candidate = adapter as Partial<ResumableUploadAdapter>;
  return typeof candidate.createUpload === "function" && typeof candidate.resumeUpload === "function";
}

export class UploadNotFoundError extends Error {
  constructor(uploadId: string) {
    super(`Upload not found: ${uploadId}`);
    this.name = "UploadNotFoundError";
  }
}

/**
 * The client sent bytes for the wrong position. `receivedBytes` is the offset
 * it must resume from — a client that dropped mid-chunk sees this instead of
 * silently producing a corrupt file.
 */
export class UploadOffsetMismatchError extends Error {
  constructor(
    public readonly receivedBytes: number,
    public readonly attemptedOffset: number,
  ) {
    super(`Upload offset mismatch: expected ${receivedBytes}, got ${attemptedOffset}`);
    this.name = "UploadOffsetMismatchError";
  }
}

/** More bytes arrived than the session declared (or than the deployment allows). */
export class UploadTooLargeError extends Error {
  constructor(
    public readonly maxTotalBytes: number,
    public readonly receivedBytes: number,
  ) {
    super(`Upload exceeds ${maxTotalBytes} bytes (staged ${receivedBytes})`);
    this.name = "UploadTooLargeError";
  }
}
