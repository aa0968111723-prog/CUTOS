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
