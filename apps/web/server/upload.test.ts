import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, synthesizeSample } from "@cutos/media";
import type * as EditorService from "./editor-service.js";
import type * as UploadService from "./upload-service.js";
import type * as Runtime from "./runtime.js";

/**
 * Server-side ingest tests against the real wiring: durable SQLite store, real
 * local storage adapter, real job worker, real ffprobe.
 *
 * The invariant under test throughout is that no code path here ever holds the
 * whole file — chunks are streamed to disk and the request answers immediately.
 */
describe("streaming upload ingress", () => {
  let dir = "";
  let ffmpegAvailable = false;
  let uploads: typeof UploadService;
  let editor: typeof EditorService;
  let runtime: typeof Runtime;
  let sampleBytes: Buffer;

  beforeAll(async () => {
    try {
      await run("ffmpeg", ["-version"]);
      ffmpegAvailable = true;
    } catch {
      ffmpegAvailable = false;
    }
    dir = await mkdtemp(join(tmpdir(), "cutos-upload-svc-"));
    process.env.CUTOS_DATA_DIR = dir;
    process.env.CUTOS_STORE = "sqlite";
    // A small chunk size makes the multi-chunk paths real rather than notional.
    process.env.CUTOS_UPLOAD_CHUNK_BYTES = String(64 * 1024);
    process.env.CUTOS_MAX_REQUEST_BYTES = String(256 * 1024);

    uploads = await import("./upload-service.js");
    editor = await import("./editor-service.js");
    runtime = await import("./runtime.js");

    if (ffmpegAvailable) {
      const samplePath = join(dir, "sample.mp4");
      await synthesizeSample(samplePath);
      const { readFile } = await import("node:fs/promises");
      sampleBytes = await readFile(samplePath);
    } else {
      sampleBytes = Buffer.alloc(0);
    }
  }, 120_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Push `data` through the chunked endpoints exactly as the browser does. */
  async function uploadBytes(
    data: Buffer,
    opts: { filename?: string; mimeType?: string; chunkBytes?: number } = {},
  ) {
    const session = await uploads.createUploadSession({
      filename: opts.filename ?? "clip.mp4",
      sizeBytes: data.byteLength,
      mimeType: opts.mimeType ?? "video/mp4",
    });
    const chunkBytes = opts.chunkBytes ?? session.chunkBytes;
    let offset = 0;
    while (offset < data.byteLength) {
      const end = Math.min(offset + chunkBytes, data.byteLength);
      const slice = data.subarray(offset, end);
      const updated = await uploads.appendUploadChunk({
        uploadId: session.uploadId,
        offset,
        body: Readable.from([slice]),
        contentLength: slice.byteLength,
      });
      offset = updated.receivedBytes;
    }
    return session;
  }

  async function waitForJob(jobId: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = editor.getJob(jobId);
      if (job.status === "succeeded") return;
      if (job.status === "failed" || job.status === "cancelled") {
        throw new Error(`job ${jobId} ${job.status}: ${job.error}`);
      }
      if (Date.now() > deadline) throw new Error("job did not finish in time");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function waitForMediaStatus(projectId: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const project = editor.getProject(projectId);
      if (project.mediaStatus === "ready" || project.mediaStatus === "failed") return project;
      if (Date.now() > deadline) throw new Error("media never settled");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("ingests a small mp4 and returns a project before any probing happens", async () => {
    if (!ffmpegAvailable) return;
    const session = await uploadBytes(sampleBytes);

    const started = Date.now();
    const result = await uploads.finalizeUpload(session.uploadId);
    const elapsed = Date.now() - started;

    expect(result.created).toBe(true);
    expect(result.probeJobId).toBeTruthy();
    // Finalize must not wait on ffprobe. Probing this clip takes hundreds of
    // milliseconds; the request has to be far quicker than that.
    expect(elapsed).toBeLessThan(1_500);

    // The project exists immediately, in a processing state rather than a
    // blocking one — this is what keeps the home screen usable.
    const immediately = editor.getProject(result.projectId);
    expect(["uploaded", "probing"]).toContain(immediately.mediaStatus);

    const ready = await waitForMediaStatus(result.projectId);
    expect(ready.mediaStatus).toBe("ready");
    expect(ready.source.durationMs).toBeGreaterThan(11_000);
    expect(ready.source.width).toBe(640);
    // The timeline now covers the real clip, not the zero-length placeholder.
    expect(ready.timeline.durationMs).toBeGreaterThan(11_000);
    expect(ready.preview.segments.length).toBeGreaterThan(0);
  }, 120_000);

  it("never exposes a server path to the client", async () => {
    const session = await uploads.createUploadSession({
      filename: "clip.mp4",
      sizeBytes: 16,
      mimeType: "video/mp4",
    });
    // The DTO must carry nothing that reveals where bytes live on the server:
    // no data directory, no storage key, no absolute path in any value.
    expect(JSON.stringify(session)).not.toContain(dir);
    expect(Object.keys(session)).not.toContain("storageKey");
    for (const [key, value] of Object.entries(session)) {
      if (typeof value !== "string") continue;
      expect(value.startsWith("/"), `${key} looks like an absolute path`).toBe(false);
      expect(value, `${key} leaks the staging layout`).not.toContain("uploads/");
      expect(value, `${key} leaks the storage layout`).not.toContain("sources/");
    }
    await uploads.abortUploadSession(session.uploadId);
  });

  it("streams a large file to disk without buffering it in the heap", async () => {
    // 24 MB in 64 KB chunks: whole-file buffering would be unmistakable here.
    const total = 24 * 1024 * 1024;
    const chunk = randomBytes(64 * 1024);
    const session = await uploads.createUploadSession({
      filename: "big.mp4",
      sizeBytes: total,
      mimeType: "video/mp4",
    });

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let offset = 0;
    while (offset < total) {
      const updated = await uploads.appendUploadChunk({
        uploadId: session.uploadId,
        offset,
        body: Readable.from([chunk]),
        contentLength: chunk.byteLength,
      });
      offset = updated.receivedBytes;
    }
    global.gc?.();
    const grew = process.memoryUsage().heapUsed - before;

    expect(offset).toBe(total);
    const status = uploads.getUploadSession(session.uploadId);
    expect(status.receivedBytes).toBe(total);
    expect(status.status).toBe("complete");
    // Retaining even a fraction of the file would blow through this.
    expect(grew).toBeLessThan(8 * 1024 * 1024);

    await uploads.abortUploadSession(session.uploadId);
  }, 120_000);

  it("rejects an unsupported mime up front, before a byte is transferred", async () => {
    await expect(
      uploads.createUploadSession({
        filename: "notes.pdf",
        sizeBytes: 1024,
        mimeType: "application/pdf",
      }),
    ).rejects.toMatchObject({ status: 415, code: "MEDIA_UNSUPPORTED" });
  });

  it("rejects a file larger than the policy limit without staging anything", async () => {
    await expect(
      uploads.createUploadSession({
        filename: "huge.mp4",
        sizeBytes: 900 * 1024 * 1024,
        mimeType: "video/mp4",
      }),
    ).rejects.toMatchObject({ status: 413, code: "UPLOAD_TOO_LARGE" });
  });

  it("refuses bytes beyond the declared size", async () => {
    const session = await uploads.createUploadSession({
      filename: "clip.mp4",
      sizeBytes: 10,
      mimeType: "video/mp4",
    });
    await expect(
      uploads.appendUploadChunk({
        uploadId: session.uploadId,
        offset: 0,
        body: Readable.from([randomBytes(64)]),
        contentLength: 64,
      }),
    ).rejects.toMatchObject({ status: 413, code: "UPLOAD_TOO_LARGE" });

    // A lying Content-Length does not get through either: the limit is
    // enforced against the bytes, not the header.
    await expect(
      uploads.appendUploadChunk({
        uploadId: session.uploadId,
        offset: 0,
        body: Readable.from([randomBytes(64)]),
        contentLength: 4,
      }),
    ).rejects.toMatchObject({ status: 413, code: "UPLOAD_TOO_LARGE" });

    await uploads.abortUploadSession(session.uploadId);
  });

  it("refuses a chunk at the wrong offset and reports where to resume", async () => {
    const session = await uploads.createUploadSession({
      filename: "clip.mp4",
      sizeBytes: 32,
      mimeType: "video/mp4",
    });
    await uploads.appendUploadChunk({
      uploadId: session.uploadId,
      offset: 0,
      body: Readable.from([randomBytes(16)]),
      contentLength: 16,
    });
    await expect(
      uploads.appendUploadChunk({
        uploadId: session.uploadId,
        offset: 999,
        body: Readable.from([randomBytes(16)]),
        contentLength: 16,
      }),
    ).rejects.toMatchObject({ status: 409, code: "UPLOAD_OFFSET_MISMATCH" });
    expect(uploads.getUploadSession(session.uploadId).receivedBytes).toBe(16);
    await uploads.abortUploadSession(session.uploadId);
  });

  it("resumes after a chunk dies mid-stream, keeping the bytes that arrived", async () => {
    const payload = randomBytes(48);
    const session = await uploads.createUploadSession({
      filename: "clip.mp4",
      sizeBytes: payload.byteLength,
      mimeType: "video/mp4",
    });

    // A body that yields half its bytes and then errors, like a dropped socket.
    const brokenBody = new Readable({
      read() {
        this.push(payload.subarray(0, 16));
        this.destroy(new Error("socket hang up"));
      },
    });
    await expect(
      uploads.appendUploadChunk({ uploadId: session.uploadId, offset: 0, body: brokenBody }),
    ).rejects.toMatchObject({ code: "STORAGE_FAILED" });

    // The prefix survived, so the client continues rather than starting over.
    const after = uploads.getUploadSession(session.uploadId);
    expect(after.receivedBytes).toBe(16);
    await uploads.appendUploadChunk({
      uploadId: session.uploadId,
      offset: 16,
      body: Readable.from([payload.subarray(16)]),
      contentLength: 32,
    });
    expect(uploads.getUploadSession(session.uploadId).receivedBytes).toBe(payload.byteLength);
    await uploads.abortUploadSession(session.uploadId);
  });

  it("refuses to finalize an upload that is not complete", async () => {
    const session = await uploads.createUploadSession({
      filename: "clip.mp4",
      sizeBytes: 64,
      mimeType: "video/mp4",
    });
    await uploads.appendUploadChunk({
      uploadId: session.uploadId,
      offset: 0,
      body: Readable.from([randomBytes(32)]),
      contentLength: 32,
    });
    // A half-uploaded file must never become project media.
    await expect(uploads.finalizeUpload(session.uploadId)).rejects.toMatchObject({
      status: 409,
      code: "UPLOAD_INCOMPLETE",
    });
    await uploads.abortUploadSession(session.uploadId);
  });

  it("rejects a forged mime: bytes that are not a media container", async () => {
    const disguised = Buffer.from("#!/bin/sh\necho pwned\n".padEnd(4096, " "));
    const session = await uploadBytes(disguised, { filename: "movie.mp4" });
    await expect(uploads.finalizeUpload(session.uploadId)).rejects.toMatchObject({
      status: 415,
      code: "MEDIA_UNSUPPORTED",
    });
    // Nothing was left behind for a later job to pick up.
    expect(uploads.getUploadSession(session.uploadId).status).toBe("aborted");
  });

  it("cancelling halfway releases the staged bytes", async () => {
    const session = await uploads.createUploadSession({
      filename: "clip.mp4",
      sizeBytes: 128,
      mimeType: "video/mp4",
    });
    await uploads.appendUploadChunk({
      uploadId: session.uploadId,
      offset: 0,
      body: Readable.from([randomBytes(64)]),
      contentLength: 64,
    });
    const cancelled = await uploads.abortUploadSession(session.uploadId);
    expect(cancelled.status).toBe("aborted");

    // The staging directory is gone, not merely marked.
    await expect(stat(join(dir, "storage", ".uploads", session.uploadId))).rejects.toThrow();
    // And a late chunk from an in-flight request cannot resurrect it.
    await expect(
      uploads.appendUploadChunk({
        uploadId: session.uploadId,
        offset: 64,
        body: Readable.from([randomBytes(64)]),
        contentLength: 64,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_ABORTED" });
  });

  it("finalizing twice yields one project, not two", async () => {
    if (!ffmpegAvailable) return;
    const session = await uploadBytes(sampleBytes);
    const first = await uploads.finalizeUpload(session.uploadId);
    const second = await uploads.finalizeUpload(session.uploadId);

    expect(second.created).toBe(false);
    expect(second.projectId).toBe(first.projectId);
    // Concurrent duplicates (a double tap, a retried request) behave the same.
    const [a, b] = await Promise.all([
      uploads.finalizeUpload(session.uploadId),
      uploads.finalizeUpload(session.uploadId),
    ]);
    expect(a.projectId).toBe(first.projectId);
    expect(b.projectId).toBe(first.projectId);
    expect(editor.listProjects().filter((p) => p.id === first.projectId)).toHaveLength(1);
  }, 120_000);

  it("keeps the asset when the probe fails, and re-probes without a re-upload", async () => {
    if (!ffmpegAvailable) return;
    // Bytes that pass the container sniff but that ffprobe cannot decode: a
    // truncated mp4 header. This is the real-world "phone produced something
    // odd" case, and it must not cost the user their upload.
    const truncated = Buffer.concat([
      sampleBytes.subarray(0, 8),
      Buffer.alloc(4096, 0),
    ]);
    const session = await uploadBytes(truncated);
    const { projectId, probeJobId } = await uploads.finalizeUpload(session.uploadId);

    await expect(waitForJob(probeJobId as string)).rejects.toThrow();
    const failed = editor.getProject(projectId);
    expect(failed.mediaStatus).toBe("failed");
    expect(["PROBE_FAILED", "MEDIA_UNSUPPORTED"]).toContain(failed.mediaError);

    // The uploaded bytes are still there, byte for byte.
    const { store, storage } = runtime.getRuntime();
    const asset = store.getAssetByKind(projectId, "original");
    expect(asset).toBeDefined();
    expect((await storage.stat(asset!.storageKey)).size).toBe(truncated.byteLength);

    // Retrying costs a metadata read, not another upload.
    const retry = editor.retryProbe(projectId);
    expect(retry.jobId).toBeTruthy();
    expect(editor.getProject(projectId).mediaStatus).toBe("probing");
    const settled = await waitForMediaStatus(projectId);
    // It fails again (the bytes really are broken) — but the asset survived
    // both attempts, which is the guarantee that matters.
    expect(settled.mediaStatus).toBe("failed");
    expect(store.getAssetByKind(projectId, "original")).toBeDefined();
  }, 120_000);

  it("sweeps abandoned sessions instead of leaking their bytes", async () => {
    const session = await uploads.createUploadSession({
      filename: "clip.mp4",
      sizeBytes: 64,
      mimeType: "video/mp4",
    });
    await uploads.appendUploadChunk({
      uploadId: session.uploadId,
      offset: 0,
      body: Readable.from([randomBytes(32)]),
      contentLength: 32,
    });
    const swept = await uploads.sweepExpiredUploads(session.expiresAt + 1);
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(uploads.getUploadSession(session.uploadId).status).toBe("aborted");
    await expect(stat(join(dir, "storage", ".uploads", session.uploadId))).rejects.toThrow();
  });

  it("sanitizes a filename down to a label that can never be a path", () => {
    expect(uploads.sanitizeFilename("../../etc/passwd")).toBe("etc passwd");
    expect(uploads.sanitizeFilename("..\\..\\windows\\system32")).toBe("windows system32");
    expect(uploads.sanitizeFilename("a bc")).toBe("abc");
    expect(uploads.sanitizeFilename("x".repeat(500))).toHaveLength(200);
    expect(uploads.sanitizeFilename(undefined)).toBe("");
    // A perfectly ordinary name survives intact, including CJK.
    expect(uploads.sanitizeFilename("我的影片.mp4")).toBe("我的影片.mp4");
  });

  it("repairs a project whose probe died without recording an outcome", async () => {
    if (!ffmpegAvailable) return;
    // The lockout this guards against: the probe worker writes mediaStatus
    // "failed" from its own catch, but a job can reach a terminal state without
    // that catch ever running — the process is killed mid-ffprobe and the
    // store's stale-recovery fails the job on its behalf. The project then
    // reads "probing" forever, and because the re-probe affordance is offered
    // for "failed", nothing in the UI can move it forward.
    const session = await uploadBytes(sampleBytes);
    const { projectId } = await uploads.finalizeUpload(session.uploadId);
    const { store, jobStore } = runtime.getRuntime();

    // Simulate the dead process: every probe job terminal, project still probing.
    for (const job of jobStore.list({ kind: "probe", projectId })) {
      jobStore.cancel(job.id);
      if (jobStore.get(job.id)?.status === "running") jobStore.fail(job.id, "process died");
    }
    store.updateProject(projectId, { mediaStatus: "probing", mediaError: null });
    expect(editor.getProject(projectId).mediaStatus).toBe("probing");

    // Nothing is queued or running, so this project would never change again.
    const active = jobStore
      .list({ kind: "probe", projectId })
      .filter((j) => j.status === "queued" || j.status === "running");
    expect(active).toHaveLength(0);

    // Reconciliation (startup + interval in production) turns the permanent
    // lockout into a retryable failure. `now` is pushed past the grace period.
    const repaired = runtime.getRuntime().reconcileStuckProbes(Date.now() + 120_000);
    expect(repaired).toBeGreaterThanOrEqual(1);
    const reconciled = editor.getProject(projectId);
    expect(reconciled.mediaStatus).toBe("failed");
    expect(reconciled.mediaError).toBe("PROBE_FAILED");

    // And it is genuinely recoverable from there, with the asset still present.
    expect(store.getAssetByKind(projectId, "original")).toBeDefined();
    expect(editor.retryProbe(projectId).jobId).toBeTruthy();
    const settled = await waitForMediaStatus(projectId);
    expect(settled.mediaStatus).toBe("ready");
    expect(settled.source.durationMs).toBeGreaterThan(11_000);
  }, 120_000);

  it("leaves a probe that is genuinely still running alone", async () => {
    if (!ffmpegAvailable) return;
    const session = await uploadBytes(sampleBytes);
    const { projectId } = await uploads.finalizeUpload(session.uploadId);
    // Within the grace period, a brand-new project must never be marked failed
    // just because its probe has not been claimed yet.
    expect(runtime.getRuntime().reconcileStuckProbes(Date.now())).toBe(0);
    const settled = await waitForMediaStatus(projectId);
    expect(settled.mediaStatus).toBe("ready");
  }, 120_000);
});
