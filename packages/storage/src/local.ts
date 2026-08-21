import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { LocalResumableUpload, stagingPathFor } from "./local-upload.js";
import {
  StorageObjectNotFoundError,
  UploadNotFoundError,
  assertValidKey,
  type ByteRange,
  type PutResult,
  type ResumableUpload,
  type ResumableUploadAdapter,
  type StatResult,
} from "./types.js";

/**
 * Filesystem-backed {@link ResumableUploadAdapter}. Objects live under `root`;
 * the temp workspace lives under `root/.tmp` and in-flight resumable uploads
 * under `root/.uploads`. Keys map directly to relative paths after
 * traversal-safe validation.
 */
export class LocalStorageAdapter implements ResumableUploadAdapter {
  private readonly root: string;
  private readonly tempDir: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.tempDir = join(this.root, ".tmp");
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    const full = resolve(this.root, key);
    // Defense in depth: ensure the resolved path stays under root.
    if (full !== this.root && !full.startsWith(this.root + "/")) {
      throw new StorageObjectNotFoundError(key);
    }
    return full;
  }

  async put(key: string, data: Buffer | Readable): Promise<PutResult> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const hash = createHash("sha256");

    if (Buffer.isBuffer(data)) {
      hash.update(data);
      await writeFile(path, data);
    } else {
      // Hash while streaming to disk (no full-file buffering).
      const ws = createWriteStream(path);
      for await (const chunk of data) {
        const buf = chunk as Buffer;
        hash.update(buf);
        if (!ws.write(buf)) await once(ws, "drain");
      }
      ws.end();
      await once(ws, "finish");
    }

    const { size } = await stat(path);
    return { key, size, checksum: hash.digest("hex") };
  }

  async putFile(key: string, sourcePath: string, opts?: { move?: boolean }): Promise<PutResult> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    const checksum = await checksumFile(sourcePath);
    if (opts?.move) {
      try {
        await rename(sourcePath, path);
      } catch {
        // rename across devices fails; fall back to copy+unlink.
        await copyFile(sourcePath, path);
        await unlink(sourcePath).catch(() => undefined);
      }
    } else {
      await copyFile(sourcePath, path);
    }
    const { size } = await stat(path);
    return { key, size, checksum };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch {
      throw new StorageObjectNotFoundError(key);
    }
  }

  createReadStream(key: string, range?: ByteRange) {
    const path = this.pathFor(key);
    return range
      ? createReadStream(path, { start: range.start, end: range.end })
      : createReadStream(path);
  }

  async stat(key: string): Promise<StatResult> {
    try {
      const s = await stat(this.pathFor(key));
      return { size: s.size };
    } catch {
      throw new StorageObjectNotFoundError(key);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async withLocalFile<T>(key: string, fn: (path: string) => Promise<T>): Promise<T> {
    const path = this.pathFor(key);
    if (!(await this.exists(key))) {
      throw new StorageObjectNotFoundError(key);
    }
    return fn(path);
  }

  // --- resumable uploads ---

  async createUpload(input: { uploadId: string; key: string }): Promise<ResumableUpload> {
    const stagingPath = stagingPathFor(this.root, input.uploadId);
    const finalPath = this.pathFor(input.key);
    await mkdir(dirname(stagingPath), { recursive: true });
    // Create the staging file so `size()` reports 0 rather than "not found":
    // an empty session and a missing session are different states.
    await writeFile(stagingPath, "", { flag: "w" });
    return new LocalResumableUpload(input.uploadId, input.key, stagingPath, finalPath);
  }

  async resumeUpload(input: { uploadId: string; key: string }): Promise<ResumableUpload> {
    const stagingPath = stagingPathFor(this.root, input.uploadId);
    try {
      await stat(stagingPath);
    } catch {
      throw new UploadNotFoundError(input.uploadId);
    }
    return new LocalResumableUpload(input.uploadId, input.key, stagingPath, this.pathFor(input.key));
  }

  tempFile(ext = ""): string {
    const suffix = ext ? (ext.startsWith(".") ? ext : `.${ext}`) : "";
    return join(this.tempDir, `${randomUUID()}${suffix}`);
  }

  async cleanupTemp(): Promise<void> {
    await rm(this.tempDir, { recursive: true, force: true });
  }

  async ensureTempDir(): Promise<string> {
    await mkdir(this.tempDir, { recursive: true });
    return this.tempDir;
  }
}

async function checksumFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
