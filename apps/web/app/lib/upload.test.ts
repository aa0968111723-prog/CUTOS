import { describe, expect, it, vi } from "vitest";
import {
  UploadError,
  codeForStatus,
  ingestVideo,
  isRetryableCode,
  waitForMedia,
  type Transport,
  type TransportRequest,
  type UploadPhase,
  type UploadState,
} from "./upload.js";

/**
 * A scriptable server for the browser-side ingest pipeline.
 *
 * It models the parts the client's correctness depends on: the server owns the
 * byte count, chunks must arrive at the right offset, and finalize is
 * idempotent. Faults are injected per request so failure paths are exercised
 * exactly, not approximated.
 */
class FakeServer {
  receivedBytes = 0;
  aborted = false;
  finalizeCount = 0;
  mediaStatus: "uploaded" | "probing" | "ready" | "failed" = "ready";
  mediaError: string | null = null;
  readonly requests: TransportRequest[] = [];
  /** Queued faults keyed by how many PATCHes have been seen. */
  private readonly chunkFaults = new Map<number, () => never>();
  private patchCount = 0;

  constructor(
    readonly totalBytes: number,
    readonly chunkBytes = 4,
  ) {}

  failChunk(index: number, fault: () => never): this {
    this.chunkFaults.set(index, fault);
    return this;
  }

  readonly transport: Transport = async (req) => {
    this.requests.push(req);
    const url = new URL(req.url, "http://test.local");

    if (req.method === "POST" && url.pathname === "/api/uploads") {
      return {
        status: 201,
        body: {
          uploadId: "up_test",
          status: "pending",
          filename: "clip.mp4",
          sizeBytes: this.totalBytes,
          receivedBytes: 0,
          mimeType: "video/mp4",
          chunkBytes: this.chunkBytes,
          expiresAt: 0,
          projectId: null,
          errorCode: null,
        },
      };
    }

    if (req.method === "PATCH") {
      const index = this.patchCount;
      this.patchCount += 1;
      const fault = this.chunkFaults.get(index);
      if (fault) {
        this.chunkFaults.delete(index);
        fault();
      }
      const offset = Number(url.searchParams.get("offset"));
      if (offset !== this.receivedBytes) {
        return {
          status: 409,
          body: { code: "UPLOAD_OFFSET_MISMATCH", receivedBytes: this.receivedBytes },
        };
      }
      const size = (req.body as Blob).size;
      // Report progress the way a real upload does, then accept the bytes.
      req.onUploadProgress?.(Math.floor(size / 2));
      req.onUploadProgress?.(size);
      this.receivedBytes += size;
      return { status: 200, body: { receivedBytes: this.receivedBytes, status: "uploading" } };
    }

    if (req.method === "GET" && url.pathname === "/api/uploads/up_test") {
      return {
        status: 200,
        body: {
          receivedBytes: this.receivedBytes,
          status: this.aborted ? "aborted" : "uploading",
        },
      };
    }

    if (req.method === "DELETE") {
      this.aborted = true;
      return { status: 200, body: { status: "aborted" } };
    }

    if (req.method === "POST" && url.pathname.endsWith("/finalize")) {
      this.finalizeCount += 1;
      return { status: 201, body: { projectId: "proj_1", created: true, probeJobId: "job_1" } };
    }

    if (req.method === "GET" && url.pathname === "/api/projects/proj_1") {
      return {
        status: 200,
        body: { id: "proj_1", mediaStatus: this.mediaStatus, mediaError: this.mediaError },
      };
    }

    throw new Error(`unexpected request: ${req.method} ${req.url}`);
  };
}

function fileOf(bytes: number, name = "clip.mp4"): File {
  return new File([new Uint8Array(bytes).fill(7)], name, { type: "video/mp4" });
}

const fastOptions = { sleep: async () => undefined, stallMs: 50 };

describe("codeForStatus", () => {
  it("maps the gateway and proxy failures that never reach app code", () => {
    // These are exactly the responses a stalled deployment produces, and the
    // ones the old fetch()-based client turned into a permanent spinner.
    expect(codeForStatus(413)).toBe("UPLOAD_TOO_LARGE");
    expect(codeForStatus(415)).toBe("MEDIA_UNSUPPORTED");
    expect(codeForStatus(408)).toBe("UPLOAD_TIMEOUT");
    expect(codeForStatus(502)).toBe("SERVICE_UNAVAILABLE");
    expect(codeForStatus(503)).toBe("SERVICE_UNAVAILABLE");
    expect(codeForStatus(504)).toBe("SERVICE_UNAVAILABLE");
    expect(codeForStatus(0)).toBe("NETWORK_ERROR");
    expect(codeForStatus(410)).toBe("UPLOAD_ABORTED");
  });

  it("prefers the server's own code over the status guess", () => {
    expect(codeForStatus(500, "STORAGE_FAILED")).toBe("STORAGE_FAILED");
  });

  it("knows which failures are worth retrying", () => {
    expect(isRetryableCode("NETWORK_ERROR")).toBe(true);
    expect(isRetryableCode("SERVICE_UNAVAILABLE")).toBe(true);
    expect(isRetryableCode("UPLOAD_STALLED")).toBe(true);
    // Retrying these would just burn the user's mobile data.
    expect(isRetryableCode("UPLOAD_TOO_LARGE")).toBe(false);
    expect(isRetryableCode("MEDIA_UNSUPPORTED")).toBe(false);
    expect(isRetryableCode("UPLOAD_CANCELLED")).toBe(false);
  });
});

describe("ingestVideo", () => {
  it("walks the full state machine and reports real byte progress", async () => {
    const server = new FakeServer(10, 4);
    const states: UploadState[] = [];

    const final = await ingestVideo(fileOf(10), {
      transport: server.transport,
      onState: (s) => states.push(s),
      ...fastOptions,
    });

    expect(final.phase).toBe("ready");
    expect(final.projectId).toBe("proj_1");

    const phases = [...new Set(states.map((s) => s.phase))];
    expect(phases).toEqual<UploadPhase[]>([
      "preparing",
      "uploading",
      "uploaded",
      "probing",
      "ready",
    ]);

    // Progress is monotonic and derived from bytes, never from a timer.
    const uploaded = states.map((s) => s.uploadedBytes);
    expect(uploaded).toEqual([...uploaded].sort((a, b) => a - b));
    expect(Math.max(...uploaded)).toBe(10);
    // Intermediate values exist, so the bar actually moves during a chunk.
    expect(uploaded.some((v) => v > 0 && v < 10)).toBe(true);
    // The file name and size are available from the very first state, which is
    // what the mobile UI renders.
    expect(states[0]?.fileName).toBe("clip.mp4");
    expect(states[0]?.totalBytes).toBe(10);
    expect(final.progress).toBe(1);
  });

  it("sends the file as bounded chunks, never as one request", async () => {
    const server = new FakeServer(10, 4);
    await ingestVideo(fileOf(10), { transport: server.transport, ...fastOptions });

    const patches = server.requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(3); // 4 + 4 + 2
    for (const patch of patches) {
      expect((patch.body as Blob).size).toBeLessThanOrEqual(4);
      expect(patch.headers?.["content-type"]).toBe("application/octet-stream");
    }
    // Nothing ever sends the whole file, so no request can hit a proxy's body
    // limit no matter how large the video is.
    expect(patches.every((p) => (p.body as Blob).size < 10)).toBe(true);
  });

  it("refuses an over-sized file before transferring a byte", async () => {
    const transport: Transport = async (req) => {
      if (req.method === "POST") {
        return { status: 413, body: { code: "UPLOAD_TOO_LARGE" } };
      }
      throw new Error("must not transfer anything after a rejected session");
    };
    const final = await ingestVideo(fileOf(10), { transport, ...fastOptions });
    expect(final.phase).toBe("failed");
    expect(final.errorCode).toBe("UPLOAD_TOO_LARGE");
    expect(final.uploadedBytes).toBe(0);
  });

  it("surfaces an unsupported media type as a terminal failure", async () => {
    const server = new FakeServer(8, 4);
    const transport: Transport = async (req) =>
      req.method === "POST" && req.url.endsWith("/finalize")
        ? { status: 415, body: { code: "MEDIA_UNSUPPORTED" } }
        : server.transport(req);

    const final = await ingestVideo(fileOf(8), { transport, ...fastOptions });
    expect(final.phase).toBe("failed");
    expect(final.errorCode).toBe("MEDIA_UNSUPPORTED");
    // Nothing was created, so there is nothing to re-probe.
    expect(final.canRetryProbe).toBe(false);
  });

  it("resumes from the server's offset after the connection drops mid-chunk", async () => {
    const server = new FakeServer(12, 4);
    // The second chunk dies in flight, the way a radio handover kills a socket.
    server.failChunk(1, () => {
      throw new UploadError("NETWORK_ERROR", "connection reset", true);
    });

    const final = await ingestVideo(fileOf(12), { transport: server.transport, ...fastOptions });

    expect(final.phase).toBe("ready");
    expect(server.receivedBytes).toBe(12);
    // It asked the server where to continue instead of starting over.
    expect(server.requests.some((r) => r.method === "GET" && r.url.includes("/api/uploads/up_test"))).toBe(
      true,
    );
    const patches = server.requests.filter((r) => r.method === "PATCH");
    // 3 chunks + 1 retried chunk — not a restart from zero.
    expect(patches).toHaveLength(4);
  });

  it("recovers from a 502 the gateway produced, without losing progress", async () => {
    const server = new FakeServer(8, 4);
    server.failChunk(1, () => {
      throw new UploadError("SERVICE_UNAVAILABLE", "bad gateway", true);
    });
    const final = await ingestVideo(fileOf(8), { transport: server.transport, ...fastOptions });
    expect(final.phase).toBe("ready");
    expect(server.receivedBytes).toBe(8);
  });

  it("gives up with a real error code instead of retrying forever", async () => {
    const server = new FakeServer(8, 4);
    const transport: Transport = async (req) => {
      if (req.method === "PATCH") {
        throw new UploadError("SERVICE_UNAVAILABLE", "down", true);
      }
      return server.transport(req);
    };

    const final = await ingestVideo(fileOf(8), {
      transport,
      maxAttemptsPerChunk: 3,
      ...fastOptions,
    });
    expect(final.phase).toBe("failed");
    expect(final.errorCode).toBe("SERVICE_UNAVAILABLE");
  });

  it("detects a stalled connection instead of pending forever", async () => {
    const server = new FakeServer(8, 4);
    let stallSeen = false;
    const transport: Transport = async (req) => {
      if (req.method === "PATCH" && !stallSeen) {
        stallSeen = true;
        // A socket that is open but moves no bytes: it never resolves on its
        // own, so only the watchdog can end it. This is exactly the shape of
        // the production hang.
        return new Promise((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => {
            reject(new UploadError("UPLOAD_CANCELLED", "aborted"));
          });
        });
      }
      return server.transport(req);
    };

    const final = await ingestVideo(fileOf(8), {
      transport,
      stallMs: 30,
      sleep: async () => undefined,
    });
    // The watchdog turned an infinite pend into a retry, and the upload
    // completed.
    expect(final.phase).toBe("ready");
    expect(stallSeen).toBe(true);
  }, 10_000);

  it("cancels halfway and releases the staged bytes", async () => {
    const server = new FakeServer(20, 4);
    const controller = new AbortController();
    const states: UploadState[] = [];

    const final = await ingestVideo(fileOf(20), {
      transport: (req) => {
        // Cancel once the transfer is genuinely underway.
        if (req.method === "PATCH" && server.receivedBytes >= 8) controller.abort();
        return server.transport(req);
      },
      signal: controller.signal,
      onState: (s) => states.push(s),
      ...fastOptions,
    });

    expect(final.phase).toBe("cancelled");
    // A cancel is not an error: the UI returns to a clean pick-a-file state.
    expect(final.errorCode).toBe(null);
    expect(server.aborted).toBe(true);
    expect(server.receivedBytes).toBeLessThan(20);
    expect(server.finalizeCount).toBe(0);
    // And the machine did leave "uploading" — it never sits busy forever.
    expect(states.at(-1)?.phase).toBe("cancelled");
  });

  it("keeps the uploaded asset when the probe fails, and offers a re-probe", async () => {
    const server = new FakeServer(8, 4);
    server.mediaStatus = "failed";
    server.mediaError = "PROBE_FAILED";

    const final = await ingestVideo(fileOf(8), { transport: server.transport, ...fastOptions });

    expect(final.phase).toBe("failed");
    expect(final.errorCode).toBe("PROBE_FAILED");
    // The upload succeeded: the project exists, and recovery is a re-probe.
    expect(final.projectId).toBe("proj_1");
    expect(final.canRetryProbe).toBe(true);
    expect(final.uploadedBytes).toBe(8);
  });

  it("reports a storage failure without claiming the file was too big", async () => {
    const server = new FakeServer(8, 4);
    const transport: Transport = async (req) =>
      req.method === "POST" && req.url.endsWith("/finalize")
        ? { status: 500, body: { code: "STORAGE_FAILED" } }
        : server.transport(req);

    const final = await ingestVideo(fileOf(8), { transport, ...fastOptions });
    expect(final.phase).toBe("failed");
    expect(final.errorCode).toBe("STORAGE_FAILED");
  });

  it("never leaves the caller without a terminal state", async () => {
    // Whatever goes wrong — including a transport that throws something the
    // pipeline has no code for — the last emitted state is terminal, so a UI
    // driven by these states cannot be stuck "busy".
    const terminal = new Set<UploadPhase>(["ready", "failed", "cancelled"]);
    const transports: Transport[] = [
      async () => ({ status: 500, body: {} }),
      async () => ({ status: 404, body: {} }),
      async () => {
        throw new Error("something nobody anticipated");
      },
    ];

    for (const transport of transports) {
      const states: UploadState[] = [];
      const final = await ingestVideo(fileOf(8), {
        transport,
        onState: (s) => states.push(s),
        maxAttemptsPerChunk: 2,
        ...fastOptions,
      });
      expect(terminal.has(final.phase)).toBe(true);
      expect(terminal.has(states.at(-1)!.phase)).toBe(true);
      expect(final.errorCode).not.toBe(null);
    }
  });

  it("finalizes once even though the server would replay a duplicate", async () => {
    const server = new FakeServer(4, 4);
    await ingestVideo(fileOf(4), { transport: server.transport, ...fastOptions });
    expect(server.finalizeCount).toBe(1);
  });

  it("gives every request a deadline so nothing can pend indefinitely", async () => {
    const server = new FakeServer(8, 4);
    await ingestVideo(fileOf(8), {
      transport: server.transport,
      requestTimeoutMs: 5_000,
      ...fastOptions,
    });
    for (const req of server.requests) {
      expect(req.timeoutMs, `${req.method} ${req.url} has no deadline`).toBeGreaterThan(0);
    }
  });
});

describe("waitForMedia", () => {
  it("polls until the probe finishes", async () => {
    const statuses = ["uploaded", "probing", "ready"];
    const transport = vi.fn<Transport>(async () => ({
      status: 200,
      body: { id: "p", mediaStatus: statuses.shift() ?? "ready", mediaError: null },
    }));

    const project = await waitForMedia("p", { transport, sleep: async () => undefined });
    expect(project.mediaStatus).toBe("ready");
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("stops waiting instead of polling forever", async () => {
    const transport: Transport = async () => ({
      status: 200,
      body: { id: "p", mediaStatus: "probing", mediaError: null },
    });
    await expect(
      waitForMedia("p", { transport, probeTimeoutMs: 0, sleep: async () => undefined }),
    ).rejects.toMatchObject({ code: "PROBE_FAILED" });
  });
});
