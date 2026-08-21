import { once } from "node:events";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
  UploadNotFoundError,
  UploadOffsetMismatchError,
  UploadTooLargeError,
  type AppendResult,
  type PutResult,
  type ResumableUpload,
} from "./types.js";

/**
 * A resumable upload staged on local disk as a single append-only file.
 *
 * The staged file IS the state: its size is the resume offset, so a process
 * restart between chunks costs nothing and needs no separate bookkeeping. The
 * file is sealed by renaming it into the final key, which on one filesystem is
 * atomic — a reader therefore never observes a half-written object under the
 * real key.
 */
export class LocalResumableUpload implements ResumableUpload {
  constructor(
    readonly uploadId: string,
    readonly key: string,
    private readonly stagingPath: string,
    private readonly finalPath: string,
  ) {}

  async size(): Promise<number> {
    try {
      return (await stat(this.stagingPath)).size;
    } catch {
      throw new UploadNotFoundError(this.uploadId);
    }
  }

  async append(
    offset: number,
    data: Readable | Buffer,
    opts: { maxTotalBytes?: number } = {},
  ): Promise<AppendResult> {
    const current = await this.size();
    if (offset !== current) throw new UploadOffsetMismatchError(current, offset);

    const max = opts.maxTotalBytes ?? Number.POSITIVE_INFINITY;
    if (current > max) throw new UploadTooLargeError(max, current);

    if (Buffer.isBuffer(data)) {
      if (current + data.byteLength > max) throw new UploadTooLargeError(max, current);
      const handle = await open(this.stagingPath, "a");
      try {
        await handle.appendFile(data);
      } finally {
        await handle.close();
      }
      return { receivedBytes: current + data.byteLength, writtenBytes: data.byteLength };
    }

    // Streamed body: bytes go straight from the socket to disk. Nothing larger
    // than one chunk of the stream is ever resident, which is the whole point.
    const ws = createWriteStream(this.stagingPath, { flags: "a" });
    let written = 0;
    try {
      for await (const chunk of data) {
        const buf = chunk as Buffer;
        if (current + written + buf.byteLength > max) {
          // Stop before the offending bytes land; the caller reverts the
          // session. Draining the rest would mean accepting the overage.
          throw new UploadTooLargeError(max, current + written);
        }
        if (!ws.write(buf)) await once(ws, "drain");
        written += buf.byteLength;
      }
      ws.end();
      await once(ws, "finish");
    } catch (error) {
      // A dropped connection leaves a valid prefix; report how far it got so
      // the client resumes there instead of restarting from zero.
      await closeQuietly(ws);
      if (error instanceof UploadTooLargeError) throw error;
      throw Object.assign(error as Error, { receivedBytes: current + written });
    }
    return { receivedBytes: current + written, writtenBytes: written };
  }

  async complete(): Promise<PutResult> {
    const size = await this.size();
    // Hash by streaming the staged file — a disk read, never a heap copy.
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(this.stagingPath)) {
      hash.update(chunk as Buffer);
    }
    await mkdir(dirname(this.finalPath), { recursive: true });
    await rename(this.stagingPath, this.finalPath);
    await rm(dirname(this.stagingPath), { recursive: true, force: true });
    return { key: this.key, size, checksum: hash.digest("hex") };
  }

  async abort(): Promise<void> {
    await rm(dirname(this.stagingPath), { recursive: true, force: true });
  }
}

async function closeQuietly(ws: ReturnType<typeof createWriteStream>): Promise<void> {
  if (ws.closed) return;
  ws.end();
  await once(ws, "close").catch(() => undefined);
}

/** Staging location for an upload id, under the adapter's private temp area. */
export function stagingPathFor(root: string, uploadId: string): string {
  // The id is server-issued (a UUID); reject anything else outright rather
  // than letting a caller-supplied string reach a path join.
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(uploadId)) {
    throw new UploadNotFoundError(uploadId);
  }
  return join(root, ".uploads", uploadId, "blob");
}
