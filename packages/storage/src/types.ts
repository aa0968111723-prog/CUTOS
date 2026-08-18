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
