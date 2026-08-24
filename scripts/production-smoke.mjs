#!/usr/bin/env node
/**
 * Production smoke test — the real thing, over real HTTP, with a real video.
 *
 * Point it at any CUTOS deployment:
 *
 *   node scripts/production-smoke.mjs https://your-app.zeabur.app
 *   node scripts/production-smoke.mjs            # defaults to localhost:3000
 *
 * It uploads an actual 2-second H.264 file in chunks through the resumable
 * ingress, finalizes it, waits for the probe job, opens the project the
 * workspace would open, and asks the source endpoint for a byte range the way a
 * <video> element does. Nothing is mocked or stubbed; if this passes against a
 * URL, a person can upload a video to that URL and start editing.
 *
 * It also answers the question that started this: WHICH BUILD IS THAT. A
 * deployment serving code from before the streaming-upload fix fails at
 * `version` with an explicit diagnosis rather than somewhere deep in the upload.
 *
 * Exits 0 when every required step passes, 1 otherwise.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "..", "apps", "web", "server", "fixtures", "tiny.mp4");

const baseUrl = (process.argv[2] ?? process.env.CUTOS_SMOKE_URL ?? "http://127.0.0.1:3000")
  .replace(/\/+$/, "");

/** The ingress contract this script speaks. Must match app/lib/upload-protocol.ts. */
const EXPECTED_UPLOAD_PROTOCOL = 2;

const results = [];
let failed = 0;

function record(name, ok, detail, { required = true } = {}) {
  results.push({ name, ok, detail, required });
  if (!ok && required) failed += 1;
  const mark = ok ? "PASS" : required ? "FAIL" : "WARN";
  console.log(`${mark.padEnd(4)}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function step(name, fn, { required = true } = {}) {
  try {
    const detail = await fn();
    record(name, true, detail, { required });
    return true;
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error), { required });
    return false;
  }
}

async function req(method, path, { body, headers = {}, timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      body,
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected JSON, got ${res.status}: ${text.slice(0, 200)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log(`\nCUTOS production smoke test\ntarget: ${baseUrl}\n${"-".repeat(60)}`);

// ---------------------------------------------------------------------------
// 1. Home page
// ---------------------------------------------------------------------------
await step("home page renders", async () => {
  const res = await req("GET", "/");
  assert(res.ok, `GET / returned ${res.status}`);
  const html = await res.text();
  assert(html.length > 0, "GET / returned an empty body");
  // The exact string the old build showed on a phone, deleted by the upload
  // fix. Seeing it here is proof the deployment predates that commit — and it
  // is worth catching at step 1 rather than after a failed upload.
  assert(
    !html.includes("正在上傳並讀取影片"),
    "the page still contains the pre-fix upload copy — this deployment is a STALE BUILD",
  );
  return `${res.status}, ${html.length} bytes`;
});

// ---------------------------------------------------------------------------
// 2. Which build is this
// ---------------------------------------------------------------------------
let version = null;
await step("version endpoint identifies the build", async () => {
  const res = await req("GET", "/api/version");
  assert(
    res.status !== 404,
    "/api/version does not exist — this deployment predates the production-repair build",
  );
  assert(res.ok, `GET /api/version returned ${res.status}`);
  version = await json(res);
  assert(
    version.uploadProtocolVersion >= EXPECTED_UPLOAD_PROTOCOL,
    `uploadProtocolVersion is ${version.uploadProtocolVersion}, expected >= ${EXPECTED_UPLOAD_PROTOCOL} — STALE BUILD without the streaming upload path`,
  );
  return [
    `sha=${version.gitShaShort ?? "unknown"}`,
    `branch=${version.gitBranch ?? "unknown"}`,
    `built=${version.buildTime ?? "unknown"}`,
    `uploadProtocol=v${version.uploadProtocolVersion}`,
  ].join(" ");
});

// ---------------------------------------------------------------------------
// 3. Health, per subsystem
// ---------------------------------------------------------------------------
let health = null;
await step("health reports every subsystem", async () => {
  const res = await req("GET", "/api/health");
  assert(res.status !== 404, "/api/health does not exist — STALE BUILD");
  health = await json(res);
  assert(Array.isArray(health.checks), "health did not return a per-subsystem `checks` array");
  const expected = [
    "app",
    "dataDirWritable",
    "database",
    "storage",
    "uploadSubsystem",
    "jobWorker",
    "ffprobe",
    "ffmpeg",
  ];
  const present = new Set(health.checks.map((c) => c.name));
  const missing = expected.filter((name) => !present.has(name));
  assert(missing.length === 0, `health omits subsystems: ${missing.join(", ")}`);
  return `status=${health.status}${health.failing.length ? ` failing=[${health.failing.join(", ")}]` : ""}`;
});

// Each subsystem is reported individually so a run's output is a diagnosis and
// not just a verdict. These are warnings, not failures: the steps that follow
// are what decide whether the deployment actually works.
if (health) {
  for (const check of health.checks) {
    record(
      `  subsystem: ${check.name}`,
      check.status === "ok",
      check.status === "ok" ? check.summary : `${check.status}: ${check.summary}${check.remedy ? ` → ${check.remedy}` : ""}`,
      { required: false },
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Readiness
// ---------------------------------------------------------------------------
await step(
  "readiness gate",
  async () => {
    const res = await req("GET", "/api/ready");
    assert(res.status !== 404, "/api/ready does not exist — STALE BUILD");
    const ready = await json(res);
    assert(
      ready.ready === true,
      `not ready (HTTP ${res.status}); blocking: ${(ready.blocking ?? []).join(", ") || "unknown"}`,
    );
    return `HTTP ${res.status}, canAcceptUploads=${ready.canAcceptUploads}, canProcessMedia=${ready.canProcessMedia}`;
  },
  // Not required: a deployment missing ffmpeg is not ready, but the upload flow
  // below still proves how far it does get, and that is worth measuring.
  { required: false },
);

// ---------------------------------------------------------------------------
// 5. The legacy upload path must be gone
// ---------------------------------------------------------------------------
await step("legacy /api/projects/upload is gone", async () => {
  const res = await req("POST", "/api/projects/upload", { body: new Uint8Array(0) });
  assert(
    res.status === 404 || res.status === 405,
    `the buffering upload endpoint still answers with ${res.status} — STALE BUILD`,
  );
  return `HTTP ${res.status}`;
});

// ---------------------------------------------------------------------------
// 6. The real upload, in chunks
// ---------------------------------------------------------------------------
const video = await readFile(FIXTURE);
console.log(`\nuploading ${FIXTURE} (${video.byteLength} bytes)\n`);

let limits = null;
await step("upload limits are advertised", async () => {
  const res = await req("GET", "/api/uploads");
  assert(res.ok, `GET /api/uploads returned ${res.status}`);
  limits = await json(res);
  assert(limits.chunkBytes > 0, "chunkBytes must be positive");
  assert(
    limits.chunkBytes <= limits.maxRequestBytes,
    `chunkBytes (${limits.chunkBytes}) exceeds maxRequestBytes (${limits.maxRequestBytes}) — every chunk would 413`,
  );
  return `chunk=${limits.chunkBytes} maxRequest=${limits.maxRequestBytes} maxUpload=${limits.maxUploadBytes}`;
});

let session = null;
await step("create upload session", async () => {
  const res = await req("POST", "/api/uploads", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: "cutos-smoke.mp4",
      sizeBytes: video.byteLength,
      mimeType: "video/mp4",
    }),
  });
  assert(res.status === 201, `expected 201, got ${res.status}`);
  session = await json(res);
  assert(typeof session.uploadId === "string" && session.uploadId, "no uploadId returned");
  assert(session.receivedBytes === 0, "a new session must start at zero bytes");
  return `uploadId=${session.uploadId} chunkBytes=${session.chunkBytes}`;
});

if (session) {
  // Deliberately smaller than the server's advertised chunk so this really is a
  // multi-request upload even for a 16 KB file — the point is to exercise the
  // offset bookkeeping, not to move bytes quickly.
  const chunk = Math.min(session.chunkBytes || 4096, 4096);
  await step("upload the file in bounded chunks", async () => {
    let offset = 0;
    let requests = 0;
    while (offset < video.byteLength) {
      const end = Math.min(offset + chunk, video.byteLength);
      const slice = video.subarray(offset, end);
      const res = await req("PATCH", `/api/uploads/${session.uploadId}?offset=${offset}`, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(slice.byteLength),
        },
        body: slice,
      });
      if (!res.ok) {
        // Read the body only on failure: a template literal in the assert
        // message would consume the stream on every successful chunk too, and
        // the JSON parse below would then fail on an already-read body.
        throw new Error(`chunk at ${offset} returned ${res.status}: ${(await res.text()).slice(0, 160)}`);
      }
      const updated = await json(res);
      assert(
        updated.receivedBytes === end,
        `server reports ${updated.receivedBytes} bytes after sending ${end}`,
      );
      offset = updated.receivedBytes;
      requests += 1;
    }
    assert(requests > 1, "the file went in a single request; chunking is not happening");
    return `${requests} chunk requests, ${offset} bytes`;
  });

  await step("resume reports the server's byte count", async () => {
    const res = await req("GET", `/api/uploads/${session.uploadId}`);
    assert(res.ok, `GET session returned ${res.status}`);
    const state = await json(res);
    assert(
      state.receivedBytes === video.byteLength,
      `session says ${state.receivedBytes}, expected ${video.byteLength}`,
    );
    return `status=${state.status} received=${state.receivedBytes}`;
  });

  let projectId = null;
  await step("finalize creates a project", async () => {
    const res = await req("POST", `/api/uploads/${session.uploadId}/finalize`);
    if (!res.ok) {
      throw new Error(`finalize returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const result = await json(res);
    assert(typeof result.projectId === "string" && result.projectId, "no projectId returned");
    projectId = result.projectId;
    return `projectId=${projectId} created=${result.created} probeJob=${result.probeJobId ?? "none"}`;
  });

  await step("finalize is idempotent", async () => {
    const res = await req("POST", `/api/uploads/${session.uploadId}/finalize`);
    assert(res.ok, `replayed finalize returned ${res.status}`);
    const again = await json(res);
    assert(
      again.projectId === projectId,
      `replay produced a different project (${again.projectId} vs ${projectId})`,
    );
    assert(again.created === false, "replay claimed to have created a second project");
    return "same project, not duplicated";
  });

  if (projectId) {
    let project = null;
    let probeOk = false;
    await step(
      "probe job reads the media",
      async () => {
        const deadline = Date.now() + 120_000;
        for (;;) {
          const res = await req("GET", `/api/projects/${projectId}`);
          assert(res.ok, `GET project returned ${res.status}`);
          project = await json(res);
          if (project.mediaStatus === "ready") {
            probeOk = true;
            return `duration=${project.source.durationMs}ms ${project.source.width}x${project.source.height}`;
          }
          if (project.mediaStatus === "failed") {
            throw new Error(
              `probe failed: ${project.mediaError} — the bytes are stored but ffprobe could not read them (is ffprobe installed?)`,
            );
          }
          assert(Date.now() < deadline, `probe never settled (last status: ${project.mediaStatus})`);
          await new Promise((r) => setTimeout(r, 500));
        }
      },
      // A probe failure is a real defect, but it must not stop the run: the
      // whole point of the workspace fix is that the user still gets in, and
      // the steps below verify exactly that.
      { required: false },
    );

    await step("workspace can open the project", async () => {
      const res = await req("GET", `/api/projects/${projectId}`);
      assert(res.ok, `GET project returned ${res.status}`);
      project = await json(res);
      // This is the PR #13 guarantee: a project is reachable and renderable
      // whatever its media status. A failed probe must not lock the user out.
      assert(project.id === projectId, "project id mismatch");
      assert(project.timeline !== undefined, "project has no timeline");
      assert(project.preview !== undefined, "project has no preview manifest");
      return `mediaStatus=${project.mediaStatus} (workspace reachable either way)`;
    });

    await step("source honours a Range request", async () => {
      const res = await req("GET", `/api/projects/${projectId}/source`, {
        headers: { range: "bytes=0-1023" },
      });
      assert(res.status === 206, `expected 206 Partial Content, got ${res.status}`);
      assert(
        res.headers.get("accept-ranges") === "bytes",
        "missing `accept-ranges: bytes`; seeking will not work",
      );
      const range = res.headers.get("content-range");
      assert(
        range === `bytes 0-1023/${video.byteLength}`,
        `unexpected content-range: ${range}`,
      );
      const body = Buffer.from(await res.arrayBuffer());
      assert(body.byteLength === 1024, `expected 1024 bytes, got ${body.byteLength}`);
      assert(
        body.equals(video.subarray(0, 1024)),
        "the bytes served are not the bytes uploaded",
      );
      return `206, ${range}, bytes verified identical`;
    });

    await step(
      "preview manifest is playable",
      async () => {
        assert(probeOk, "skipped: the probe did not succeed, so there is no real duration yet");
        assert(
          Array.isArray(project.preview.segments) && project.preview.segments.length > 0,
          "preview manifest has no segments",
        );
        assert(project.preview.durationMs > 0, "preview duration is zero");
        assert(
          project.timeline.durationMs === project.source.durationMs,
          `timeline (${project.timeline.durationMs}ms) does not cover the source (${project.source.durationMs}ms)`,
        );
        return `${project.preview.segments.length} segment(s), ${project.preview.durationMs}ms`;
      },
      { required: probeOk },
    );

    // Leave nothing behind on a real deployment.
    await step(
      "clean up the smoke-test project",
      async () => {
        const res = await req("DELETE", `/api/projects/${projectId}`);
        assert(res.ok || res.status === 404, `delete returned ${res.status}`);
        return `HTTP ${res.status}`;
      },
      { required: false },
    );
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log(`\n${"-".repeat(60)}`);
const warnings = results.filter((r) => !r.ok && !r.required);
if (failed === 0) {
  console.log(`SMOKE TEST PASSED — ${results.filter((r) => r.ok).length} checks`);
  if (warnings.length > 0) {
    console.log(`${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  - ${w.name}: ${w.detail}`);
  }
  console.log(
    `\nA user can upload a video to ${baseUrl} and reach the workspace.` +
      (warnings.length ? " Some subsystems are degraded — see warnings above." : ""),
  );
} else {
  console.log(`SMOKE TEST FAILED — ${failed} required check(s) failed:`);
  for (const r of results.filter((x) => !x.ok && x.required)) {
    console.log(`  - ${r.name}: ${r.detail}`);
  }
}
if (version) {
  console.log(
    `\nbuild under test: ${version.gitSha ?? "unknown sha"} (${version.gitBranch ?? "unknown branch"}), ` +
      `upload protocol v${version.uploadProtocolVersion}, built ${version.buildTime ?? "unknown"}`,
  );
}
process.exit(failed === 0 ? 0 : 1);
