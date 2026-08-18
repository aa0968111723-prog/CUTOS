import { Readable } from "node:stream";
import type { StorageAdapter } from "@cutos/storage";

/**
 * Serve a storage object with HTTP Range support so the browser <video> element
 * can seek. Objects are served read-only via the storage adapter (never a raw
 * absolute path from the client).
 */
export async function serveStorageObject(
  storage: StorageAdapter,
  key: string,
  req: Request,
): Promise<Response> {
  const { size } = await storage.stat(key);
  const range = req.headers.get("range");

  const baseHeaders: Record<string, string> = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };

  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const start = Number.parseInt(match[1] ?? "0", 10);
      const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
      const safeEnd = Math.min(end, size - 1);
      const stream = storage.createReadStream(key, { start, end: safeEnd });
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...baseHeaders,
          "content-range": `bytes ${start}-${safeEnd}/${size}`,
          "content-length": String(safeEnd - start + 1),
        },
      });
    }
  }

  const stream = storage.createReadStream(key);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, "content-length": String(size) },
  });
}
