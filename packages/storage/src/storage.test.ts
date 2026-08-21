import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "./local.js";
import { InvalidStorageKeyError, assertValidKey } from "./types.js";

describe("assertValidKey", () => {
  it("accepts nested relative keys", () => {
    expect(assertValidKey("sources/abc/original.mp4")).toBe("sources/abc/original.mp4");
  });

  it("rejects traversal and absolute keys", () => {
    for (const bad of ["../secret", "/etc/passwd", "a/../../b", "", "a\\b", "a/./b"]) {
      expect(() => assertValidKey(bad)).toThrow(InvalidStorageKeyError);
    }
  });
});

describe("LocalStorageAdapter", () => {
  let dir = "";
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cutos-storage-"));
    storage = new LocalStorageAdapter(dir);
  });
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("puts and gets a buffer with a stable checksum", async () => {
    const res = await storage.put("a/hello.txt", Buffer.from("hello"));
    expect(res.size).toBe(5);
    // sha256("hello")
    expect(res.checksum).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect((await storage.get("a/hello.txt")).toString()).toBe("hello");
    expect(await storage.exists("a/hello.txt")).toBe(true);
  });

  it("puts from a stream", async () => {
    await storage.put("s/data.bin", Readable.from([Buffer.from("ab"), Buffer.from("cd")]));
    expect((await storage.get("s/data.bin")).toString()).toBe("abcd");
    expect((await storage.stat("s/data.bin")).size).toBe(4);
  });

  it("imports a file by move and provides a local path", async () => {
    const src = join(dir, "src.txt");
    await writeFile(src, "payload");
    const res = await storage.putFile("imports/x.txt", src, { move: true });
    expect(res.size).toBe(7);
    const seen = await storage.withLocalFile("imports/x.txt", async (p) => {
      expect(p).toContain("imports/x.txt");
      return "ok";
    });
    expect(seen).toBe("ok");
  });

  it("supports byte-range reads", async () => {
    await storage.put("r/range.txt", Buffer.from("0123456789"));
    const stream = storage.createReadStream("r/range.txt", { start: 2, end: 5 });
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("2345");
  });

  it("deletes objects and rejects traversal keys", async () => {
    await storage.put("d/gone.txt", Buffer.from("x"));
    await storage.delete("d/gone.txt");
    expect(await storage.exists("d/gone.txt")).toBe(false);
    await expect(storage.get("../escape")).rejects.toBeTruthy();
  });

  it("allocates and cleans temp files", async () => {
    const p = storage.tempFile("mp4");
    expect(p.endsWith(".mp4")).toBe(true);
    await storage.ensureTempDir();
    await storage.cleanupTemp();
    expect(await storage.exists(".tmp")).toBe(false);
  });
});

describe("LocalStorageAdapter resumable uploads", () => {
  let dir = "";
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cutos-upload-"));
    storage = new LocalStorageAdapter(dir);
  });
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const id = "11111111-2222-3333-4444-555555555555";

  it("stages chunks in order and seals them into one object", async () => {
    const upload = await storage.createUpload({ uploadId: id, key: "sources/p/original.mp4" });
    expect(await upload.size()).toBe(0);

    expect((await upload.append(0, Readable.from([Buffer.from("hel")]))).receivedBytes).toBe(3);
    expect((await upload.append(3, Buffer.from("lo"))).receivedBytes).toBe(5);

    const result = await upload.complete();
    expect(result.size).toBe(5);
    // Same checksum a single-shot put would produce: sha256("hello").
    expect(result.checksum).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect((await storage.get("sources/p/original.mp4")).toString()).toBe("hello");
  });

  it("resumes from the staged offset after an interrupted chunk", async () => {
    const upload = await storage.createUpload({ uploadId: id, key: "sources/p/original.mp4" });
    await upload.append(0, Buffer.from("abcd"));

    // A new process (or a reconnect) resumes with nothing but the id.
    const resumed = await storage.resumeUpload({ uploadId: id, key: "sources/p/original.mp4" });
    expect(await resumed.size()).toBe(4);
    await resumed.append(4, Buffer.from("efgh"));
    expect((await resumed.complete()).size).toBe(8);
    expect((await storage.get("sources/p/original.mp4")).toString()).toBe("abcdefgh");
  });

  it("rejects a chunk sent at the wrong offset and reports where to resume", async () => {
    const upload = await storage.createUpload({ uploadId: id, key: "k/a.bin" });
    await upload.append(0, Buffer.from("abcd"));
    await expect(upload.append(99, Buffer.from("x"))).rejects.toMatchObject({
      name: "UploadOffsetMismatchError",
      receivedBytes: 4,
    });
    // The staged prefix is untouched by the rejected chunk.
    expect(await upload.size()).toBe(4);
  });

  it("refuses to stage more than the declared size, mid-stream", async () => {
    const upload = await storage.createUpload({ uploadId: id, key: "k/a.bin" });
    const chunks = [Buffer.alloc(4, 1), Buffer.alloc(4, 2), Buffer.alloc(4, 3)];
    await expect(
      upload.append(0, Readable.from(chunks), { maxTotalBytes: 6 }),
    ).rejects.toMatchObject({ name: "UploadTooLargeError" });
    // It stopped before writing the offending chunk rather than draining it.
    expect(await upload.size()).toBeLessThanOrEqual(6);
  });

  it("aborting discards the staged bytes and leaves no object behind", async () => {
    const upload = await storage.createUpload({ uploadId: id, key: "k/a.bin" });
    await upload.append(0, Buffer.from("abcd"));
    await upload.abort();
    expect(await storage.exists("k/a.bin")).toBe(false);
    await expect(storage.resumeUpload({ uploadId: id, key: "k/a.bin" })).rejects.toMatchObject({
      name: "UploadNotFoundError",
    });
    // Abort is idempotent — a cancel that races a retry must not throw.
    await expect(upload.abort()).resolves.toBeUndefined();
  });

  it("rejects an upload id that is not a server-issued token", async () => {
    for (const bad of ["../../etc", "a/b", "short", ""]) {
      await expect(storage.createUpload({ uploadId: bad, key: "k/a.bin" })).rejects.toMatchObject({
        name: "UploadNotFoundError",
      });
    }
  });

  it("stages a large file without ever holding it in the heap", async () => {
    const upload = await storage.createUpload({ uploadId: id, key: "k/big.bin" });
    const chunkBytes = 1 << 20;
    const chunk = Buffer.alloc(chunkBytes, 7);
    const chunkCount = 48; // 48 MB — far above any plausible per-request buffer.

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < chunkCount; i += 1) {
      await upload.append(i * chunkBytes, Readable.from([chunk]));
    }
    const result = await upload.complete();
    global.gc?.();
    const grew = process.memoryUsage().heapUsed - before;

    expect(result.size).toBe(chunkBytes * chunkCount);
    expect((await storage.stat("k/big.bin")).size).toBe(chunkBytes * chunkCount);
    // Whole-file buffering would show up here as ~48 MB of retained heap.
    expect(grew).toBeLessThan(chunkBytes * 8);
  }, 60_000);
});
