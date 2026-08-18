import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ReadableOptions } from "node:stream";
import { Readable } from "node:stream";

/**
 * Serve a media file with HTTP Range support so the browser <video> element can
 * seek. Source media is served read-only; it is never modified.
 */
export async function serveFile(filePath: string, req: Request): Promise<Response> {
  const stats = await stat(filePath);
  const total = stats.size;
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
      const end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
      const safeEnd = Math.min(end, total - 1);
      const chunkSize = safeEnd - start + 1;
      const stream = createReadStream(filePath, { start, end: safeEnd });
      return new Response(toWebStream(stream), {
        status: 206,
        headers: {
          ...baseHeaders,
          "content-range": `bytes ${start}-${safeEnd}/${total}`,
          "content-length": String(chunkSize),
        },
      });
    }
  }

  const stream = createReadStream(filePath);
  return new Response(toWebStream(stream), {
    status: 200,
    headers: { ...baseHeaders, "content-length": String(total) },
  });
}

function toWebStream(stream: Readable, _opts?: ReadableOptions): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream;
}
