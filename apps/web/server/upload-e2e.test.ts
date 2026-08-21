import { createServer, request as httpRequest, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, synthesizeSample } from "@cutos/media";
import {
  ingestVideo,
  type Transport,
  type UploadPhase,
  type UploadState,
} from "../app/lib/upload.js";

/**
 * End-to-end media ingress over real HTTP.
 *
 * This wires the ACTUAL Next.js route handlers into a `node:http` server and
 * drives them with the ACTUAL browser-side uploader — the same module the
 * client bundle ships. Only the two ends the browser owns are substituted:
 * `XMLHttpRequest` becomes a node http request that reports genuine
 * `bytesWritten` progress, and `File` comes from the filesystem.
 *
 * That means everything in between is production code: chunked PATCH bodies
 * streamed off a socket, the durable upload session, the container sniff,
 * finalize, the probe job, and Range-served playback.
 */
describe("upload E2E (real HTTP routes + real client uploader)", () => {
  let dir = "";
  let ffmpegAvailable = false;
  let server: Server;
  let baseUrl = "";
  let samplePath = "";
  let sampleBytes: Buffer;

  beforeAll(async () => {
    try {
      await run("ffmpeg", ["-version"]);
      ffmpegAvailable = true;
    } catch {
      ffmpegAvailable = false;
    }
    dir = await mkdtemp(join(tmpdir(), "cutos-upload-e2e-"));
    process.env.CUTOS_DATA_DIR = dir;
    process.env.CUTOS_STORE = "sqlite";
    // Small chunks so a 12s clip really is a multi-chunk, multi-request upload.
    process.env.CUTOS_UPLOAD_CHUNK_BYTES = String(96 * 1024);
    process.env.CUTOS_MAX_REQUEST_BYTES = String(256 * 1024);

    const routes = await loadRoutes();
    server = createServer((req, res) => void handle(routes, req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    if (ffmpegAvailable) {
      samplePath = join(dir, "sample.mp4");
      await synthesizeSample(samplePath);
      sampleBytes = await readFile(samplePath);
    } else {
      sampleBytes = Buffer.alloc(0);
    }
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const nodeTransport: Transport = (req) =>
    new Promise((resolve, reject) => {
      const url = new URL(req.url, baseUrl);
      const outgoing = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: req.method,
          headers: req.headers ?? {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = {};
            try {
              body = text ? JSON.parse(text) : {};
            } catch {
              body = { message: text };
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      if (req.timeoutMs) outgoing.setTimeout(req.timeoutMs, () => outgoing.destroy());
      req.signal?.addEventListener("abort", () => outgoing.destroy(new AbortError()), {
        once: true,
      });
      outgoing.on("error", (error: Error) => {
        reject(
          error.name === "AbortError"
            ? Object.assign(new Error("cancelled"), {
                name: "UploadError",
                code: "UPLOAD_CANCELLED",
              })
            : Object.assign(new Error(error.message), {
                name: "UploadError",
                code: "NETWORK_ERROR",
                retryable: true,
              }),
        );
      });

      void (async () => {
        const body = req.body;
        if (!body) {
          outgoing.end();
          return;
        }
        if (typeof body === "string") {
          outgoing.end(body);
          return;
        }
        // Write the blob in slices and report real bytes written — this is the
        // node stand-in for `xhr.upload.onprogress`.
        const bytes = Buffer.from(await body.arrayBuffer());
        const step = 16 * 1024;
        for (let at = 0; at < bytes.byteLength; at += step) {
          if (outgoing.destroyed) return;
          outgoing.write(bytes.subarray(at, Math.min(at + step, bytes.byteLength)));
          req.onUploadProgress?.(Math.min(at + step, bytes.byteLength));
        }
        outgoing.end();
      })();
    });

  function fileFrom(bytes: Buffer, name = "clip.mp4", type = "video/mp4"): File {
    return new File([new Uint8Array(bytes)], name, { type });
  }

  it("takes a picked file all the way to a playable project", async () => {
    if (!ffmpegAvailable) return;
    const states: UploadState[] = [];

    const final = await ingestVideo(fileFrom(sampleBytes), {
      transport: nodeTransport,
      baseUrl,
      onState: (s) => states.push(s),
    });

    // 1. The pipeline reached a ready project.
    expect(final.phase).toBe("ready");
    expect(final.projectId).toBeTruthy();

    // 2. Progress was real: monotonic byte counts that ended at the file size,
    //    with intermediate values (so the bar moved during the transfer).
    const uploading = states.filter((s) => s.phase === "uploading");
    expect(uploading.length).toBeGreaterThan(3);
    const bytes = uploading.map((s) => s.uploadedBytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
    expect(bytes.some((b) => b > 0 && b < sampleBytes.byteLength)).toBe(true);
    expect(final.uploadedBytes).toBe(sampleBytes.byteLength);

    // 3. Every state the UI needs, in order.
    expect([...new Set(states.map((s) => s.phase))]).toEqual<UploadPhase[]>([
      "preparing",
      "uploading",
      "uploaded",
      "probing",
      "ready",
    ]);

    // 4. The project the workspace would open is complete and consistent.
    const project = (await getJson(`/api/projects/${final.projectId}`)) as {
      mediaStatus: string;
      source: { durationMs: number; width: number | null };
      timeline: { durationMs: number };
      preview: { segments: unknown[] };
    };
    expect(project.mediaStatus).toBe("ready");
    expect(project.source.durationMs).toBeGreaterThan(11_000);
    expect(project.source.width).toBe(640);
    expect(project.timeline.durationMs).toBe(project.source.durationMs);
    expect(project.preview.segments.length).toBeGreaterThan(0);

    // 5. The preview is genuinely playable: the source endpoint honours Range
    //    with a 206 and the right content type, which is what the <video>
    //    element needs to start and to seek.
    const ranged = await rawRequest("GET", `/api/projects/${final.projectId}/source`, {
      range: "bytes=0-1023",
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-type"]).toBe("video/mp4");
    expect(ranged.headers["accept-ranges"]).toBe("bytes");
    expect(ranged.headers["content-range"]).toBe(`bytes 0-1023/${sampleBytes.byteLength}`);
    expect(ranged.body.byteLength).toBe(1024);
    // The bytes served are the bytes uploaded — the original is untouched.
    expect(ranged.body.equals(sampleBytes.subarray(0, 1024))).toBe(true);
  }, 180_000);

  it("uploads in bounded requests, so no single body can hit a proxy limit", async () => {
    if (!ffmpegAvailable) return;
    const sizes: number[] = [];
    const transport: Transport = async (req) => {
      if (req.method === "PATCH" && req.body && typeof req.body !== "string") {
        sizes.push(req.body.size);
      }
      return nodeTransport(req);
    };

    const final = await ingestVideo(fileFrom(sampleBytes), { transport, baseUrl });
    expect(final.phase).toBe("ready");
    expect(sizes.length).toBeGreaterThan(1);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(96 * 1024);
  }, 180_000);

  it("cancelling mid-upload returns the UI to a usable state and frees the bytes", async () => {
    if (!ffmpegAvailable) return;
    const controller = new AbortController();
    let seenUploadId: string | null = null;
    const states: UploadState[] = [];

    const final = await ingestVideo(fileFrom(sampleBytes, "cancel-me.mp4"), {
      transport: nodeTransport,
      baseUrl,
      signal: controller.signal,
      onState: (state) => {
        states.push(state);
        seenUploadId = state.uploadId ?? seenUploadId;
        // Cancel once the transfer is genuinely under way.
        if (state.phase === "uploading" && state.uploadedBytes > 0) controller.abort();
      },
    });

    expect(final.phase).toBe("cancelled");
    // A cancel is not an error — nothing to apologize for, nothing to retry.
    expect(final.errorCode).toBe(null);
    expect(states.at(-1)?.phase).toBe("cancelled");
    expect(final.projectId).toBe(null);

    // The server released the session, so its staged bytes are gone.
    const session = (await getJson(`/api/uploads/${seenUploadId}`)) as { status: string };
    expect(session.status).toBe("aborted");

    // And no half-project was left in the list for the user to trip over.
    const { projects } = (await getJson("/api/projects")) as {
      projects: { name: string }[];
    };
    expect(projects.some((p) => p.name === "cancel-me.mp4")).toBe(false);
  }, 180_000);

  it("keeps the asset when the probe fails, and recovers with a re-probe", async () => {
    if (!ffmpegAvailable) return;
    // Container magic that passes the sniff over bytes ffprobe cannot decode.
    const broken = Buffer.concat([sampleBytes.subarray(0, 12), Buffer.alloc(200 * 1024, 0)]);

    const final = await ingestVideo(fileFrom(broken, "broken.mp4"), {
      transport: nodeTransport,
      baseUrl,
      probeTimeoutMs: 30_000,
    });

    expect(final.phase).toBe("failed");
    // The upload itself succeeded: there is a project, and the offered fix is
    // re-reading the media, never re-sending it.
    expect(final.projectId).toBeTruthy();
    expect(final.canRetryProbe).toBe(true);
    expect(final.uploadedBytes).toBe(broken.byteLength);

    const projectId = final.projectId as string;
    const failed = (await getJson(`/api/projects/${projectId}`)) as {
      mediaStatus: string;
      mediaError: string | null;
    };
    expect(failed.mediaStatus).toBe("failed");
    expect(failed.mediaError).toBeTruthy();

    // The stored asset is intact — byte for byte — so nothing was lost.
    const whole = await rawRequest("GET", `/api/projects/${projectId}/source`);
    expect(whole.status).toBe(200);
    expect(whole.body.byteLength).toBe(broken.byteLength);

    // Re-probing is a plain request against the existing asset.
    const retried = await rawRequest("POST", `/api/projects/${projectId}/probe`);
    expect(retried.status).toBe(202);
    const settled = await pollMedia(projectId);
    // These bytes are genuinely undecodable, so it fails again — but the asset
    // survived both attempts, which is the guarantee that matters.
    expect(settled.mediaStatus).toBe("failed");
    const still = await rawRequest("GET", `/api/projects/${projectId}/source`);
    expect(still.body.byteLength).toBe(broken.byteLength);
  }, 180_000);

  it("refuses a renamed non-media file over the wire", async () => {
    const disguised = Buffer.from("<!doctype html><h1>not a video</h1>".padEnd(8192, " "));
    const final = await ingestVideo(fileFrom(disguised, "movie.mp4"), {
      transport: nodeTransport,
      baseUrl,
    });
    expect(final.phase).toBe("failed");
    expect(final.errorCode).toBe("MEDIA_UNSUPPORTED");
    expect(final.projectId).toBe(null);
  }, 60_000);

  // --- helpers -------------------------------------------------------------

  async function getJson(path: string): Promise<unknown> {
    const res = await rawRequest("GET", path);
    return JSON.parse(res.body.toString("utf8")) as unknown;
  }

  async function pollMedia(projectId: string): Promise<{ mediaStatus: string }> {
    for (let i = 0; i < 200; i += 1) {
      const project = (await getJson(`/api/projects/${projectId}`)) as { mediaStatus: string };
      if (project.mediaStatus === "ready" || project.mediaStatus === "failed") return project;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("media never settled");
  }

  function rawRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = httpRequest(
        { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string>,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
});

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

/**
 * The shape every mounted route handler shares.
 *
 * Routes without a path parameter simply ignore `ctx`, so one signature covers
 * the whole table and no casting is needed at the call site.
 */
type RouteHandler = (
  req: Request,
  ctx: { params: { id: string } },
) => Promise<Response> | Response;

interface RouteTable {
  match(method: string, pathname: string): { handler: RouteHandler; id: string } | null;
}

/**
 * Mount the real route modules.
 *
 * Imported after the environment is configured so the runtime they build uses
 * the test's data directory.
 */
async function loadRoutes(): Promise<RouteTable> {
  const uploads = await import("../app/api/uploads/route.js");
  const upload = await import("../app/api/uploads/[id]/route.js");
  const finalize = await import("../app/api/uploads/[id]/finalize/route.js");
  const project = await import("../app/api/projects/[id]/route.js");
  const projects = await import("../app/api/projects/route.js");
  const source = await import("../app/api/projects/[id]/source/route.js");
  const probe = await import("../app/api/projects/[id]/probe/route.js");

  const table: { method: string; pattern: RegExp; handler: RouteHandler }[] = [
    { method: "GET", pattern: /^\/api\/uploads$/, handler: uploads.GET },
    { method: "POST", pattern: /^\/api\/uploads$/, handler: uploads.POST },
    { method: "POST", pattern: /^\/api\/uploads\/([^/]+)\/finalize$/, handler: finalize.POST },
    { method: "GET", pattern: /^\/api\/uploads\/([^/]+)$/, handler: upload.GET },
    { method: "PATCH", pattern: /^\/api\/uploads\/([^/]+)$/, handler: upload.PATCH },
    { method: "DELETE", pattern: /^\/api\/uploads\/([^/]+)$/, handler: upload.DELETE },
    { method: "GET", pattern: /^\/api\/projects$/, handler: projects.GET },
    { method: "POST", pattern: /^\/api\/projects\/([^/]+)\/probe$/, handler: probe.POST },
    { method: "GET", pattern: /^\/api\/projects\/([^/]+)\/source$/, handler: source.GET },
    { method: "GET", pattern: /^\/api\/projects\/([^/]+)$/, handler: project.GET },
  ];

  return {
    match(method, pathname) {
      for (const route of table) {
        if (route.method !== method) continue;
        const found = route.pattern.exec(pathname);
        if (!found) continue;
        return { handler: route.handler, id: decodeURIComponent(found[1] ?? "") };
      }
      return null;
    },
  };
}

/**
 * Bridge node's req/res to the web `Request`/`Response` a route handler speaks.
 *
 * The request body is passed through as a stream (`duplex: "half"`), which is
 * the point: the route must be able to consume a chunk without the runtime
 * having buffered it first.
 */
async function handle(
  routes: RouteTable,
  incoming: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
  const route = routes.match(incoming.method ?? "GET", url.pathname);
  if (!route) {
    res.writeHead(404).end();
    return;
  }

  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
  const request = new Request(url, {
    method: incoming.method,
    headers: incoming.headers as HeadersInit,
    body: hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : undefined,
    // @ts-expect-error -- node's fetch requires this for a streamed body
    duplex: "half",
  });

  try {
    const response = await route.handler(request, { params: { id: route.id } });
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      body.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
}
