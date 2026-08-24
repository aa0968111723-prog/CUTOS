import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Diagnostics from "./diagnostics.js";
import type * as BuildInfo from "./build-info.js";
import { UPLOAD_PROTOCOL_VERSION } from "../app/lib/upload-protocol.js";

/**
 * The deployment's self-report, tested against the real filesystem and the real
 * runtime — no mocked storage, no stubbed child processes.
 *
 * What these guard is narrower than "the checks work": it is that the checks
 * cannot LIE. A health endpoint that reports green on a broken deployment is
 * worse than none at all, because it redirects the search away from the fault;
 * and one that invents faults on a working deployment burns an operator's time
 * chasing a volume that was fine. Both directions are covered here.
 */
describe("deployment diagnostics", () => {
  let dir = "";
  let diagnostics: typeof Diagnostics;
  let buildInfoMod: typeof BuildInfo;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cutos-diag-"));
    process.env.CUTOS_DATA_DIR = dir;
    process.env.CUTOS_STORE = "sqlite";
    // The heuristic flags a data directory that a container would discard. The
    // test's tmpdir genuinely is under /tmp, so opt out explicitly rather than
    // asserting around a warning that is correct in production.
    process.env.CUTOS_DATA_DIR_EPHEMERAL = "0";
    diagnostics = await import("./diagnostics.js");
    buildInfoMod = await import("./build-info.js");
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Build identity
  // -------------------------------------------------------------------------

  it("reports the upload protocol version the client expects", () => {
    // The whole point of the field: a deployment and the bundle it serves must
    // agree, or the version panel's staleness warning is meaningless.
    expect(buildInfoMod.buildInfo().uploadProtocolVersion).toBe(UPLOAD_PROTOCOL_VERSION);
    expect(UPLOAD_PROTOCOL_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("prefers the platform's commit variable over a baked build stamp", () => {
    const previous = process.env.ZEABUR_GIT_COMMIT_SHA;
    try {
      process.env.ZEABUR_GIT_COMMIT_SHA = "a".repeat(40);
      process.env.ZEABUR_GIT_BRANCH = "main";
      const info = buildInfoMod.buildInfo();
      expect(info.gitSha).toBe("a".repeat(40));
      expect(info.gitShaShort).toBe("aaaaaaa");
      expect(info.gitBranch).toBe("main");
      // Knowing WHERE the sha came from is what makes a wrong one debuggable.
      expect(info.source).toBe("env:ZEABUR_GIT_COMMIT_SHA");
    } finally {
      if (previous === undefined) delete process.env.ZEABUR_GIT_COMMIT_SHA;
      else process.env.ZEABUR_GIT_COMMIT_SHA = previous;
      delete process.env.ZEABUR_GIT_BRANCH;
    }
  });

  it("says the sha is unknown rather than inventing one", () => {
    const saved: Record<string, string | undefined> = {};
    const keys = [
      "ZEABUR_GIT_COMMIT_SHA",
      "CUTOS_GIT_SHA",
      "GIT_COMMIT_SHA",
      "SOURCE_COMMIT",
      "VERCEL_GIT_COMMIT_SHA",
      "RAILWAY_GIT_COMMIT_SHA",
      "GITHUB_SHA",
    ];
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      const info = buildInfoMod.buildInfo();
      // In this repo a build stamp may or may not exist; either way the field
      // must never be a fabricated placeholder that reads like a real commit.
      expect(info.gitSha === null || /^[0-9a-f]{7,40}$/.test(info.gitSha)).toBe(true);
      expect(info.appVersion).toBe("0.1.0");
    } finally {
      for (const key of keys) {
        if (saved[key] !== undefined) process.env[key] = saved[key];
      }
    }
  });

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  it("reports every subsystem the deployment checklist depends on", async () => {
    const report = await diagnostics.runHealthChecks({ fresh: true });
    // Named explicitly rather than snapshotted: dropping one of these silently
    // is exactly how a health endpoint decays back into `{ ok: true }`.
    expect(report.checks.map((c) => c.name)).toEqual([
      "app",
      "dataDirWritable",
      "database",
      "storage",
      "uploadSubsystem",
      "jobWorker",
      "ffprobe",
      "ffmpeg",
    ]);
    for (const check of report.checks) {
      expect(check.summary.length).toBeGreaterThan(0);
      expect(["ok", "degraded", "down"]).toContain(check.status);
      // Anything not healthy has to say what to do about it, or the report is
      // just a nicer-looking failure.
      if (check.status !== "ok") expect(check.reason).toBeTruthy();
    }
  }, 60_000);

  it("passes a genuinely working data directory", async () => {
    const check = await diagnostics.checkDataDir();
    expect(check.status).toBe("ok");
    expect(check.detail?.path).toBe(dir);
  });

  it("survives concurrent checks without inventing a fault", async () => {
    // A regression guard with a real history: the write probe originally used
    // one path per process, so `/api/health`, `/api/ready` and the startup
    // preflight overwrote and deleted each other's file. The check then
    // reported a perfectly good volume as incoherent — a diagnostic that
    // manufactures the very failure it exists to detect.
    const checks = await Promise.all(Array.from({ length: 8 }, () => diagnostics.checkDataDir()));
    for (const check of checks) expect(check.status).toBe("ok");
  }, 30_000);

  it("reports an unwritable data directory as down, with a remedy", async () => {
    const previous = process.env.CUTOS_DATA_DIR;
    // A path whose parent is a file: mkdir fails with ENOTDIR the same way a
    // missing volume mount does.
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "x", "utf8");
    process.env.CUTOS_DATA_DIR = join(blocker, "data");
    try {
      // `config.dataDir` is resolved at module load, so the check has to run
      // against a fresh module instance that sees the new environment.
      vi.resetModules();
      const fresh = (await import("./diagnostics.js")) as typeof Diagnostics;
      const check = await fresh.checkDataDir();
      expect(check.status).toBe("down");
      expect(check.reason).toBe("DATA_DIR_UNCREATABLE");
      expect(check.remedy).toContain("CUTOS_DATA_DIR");
    } finally {
      if (previous === undefined) delete process.env.CUTOS_DATA_DIR;
      else process.env.CUTOS_DATA_DIR = previous;
      await rm(blocker, { force: true });
      vi.resetModules();
    }
  }, 30_000);

  it("recognises an ephemeral data directory even when it is writable", () => {
    const previous = process.env.CUTOS_DATA_DIR_EPHEMERAL;
    delete process.env.CUTOS_DATA_DIR_EPHEMERAL;
    try {
      // Writable but discarded on restart is a real, distinct failure: it works
      // during a demo and loses every project on the next redeploy.
      expect(diagnostics.looksEphemeral("/tmp/cutos")).toBeTruthy();
      expect(diagnostics.looksEphemeral("/dev/shm/cutos")).toBeTruthy();
      expect(diagnostics.looksEphemeral("/data")).toBeNull();
      expect(diagnostics.looksEphemeral("/var/lib/cutos")).toBeNull();
    } finally {
      if (previous !== undefined) process.env.CUTOS_DATA_DIR_EPHEMERAL = previous;
    }
  });

  it("detects a missing media binary by running it, not by looking for it", async () => {
    const previous = process.env.CUTOS_FFPROBE_PATH;
    process.env.CUTOS_FFPROBE_PATH = join(dir, "definitely-not-ffprobe");
    try {
      diagnostics.resetDiagnosticsCache();
      const check = await diagnostics.checkFfprobe();
      expect(check.status).toBe("down");
      // An ffprobe on PATH that cannot execute is as useless as none at all,
      // and only running it tells the two apart.
      expect(["NOT_INSTALLED", "SPAWN_FAILED"]).toContain(check.reason);
      expect(check.remedy).toContain("ffmpeg");
    } finally {
      if (previous === undefined) delete process.env.CUTOS_FFPROBE_PATH;
      else process.env.CUTOS_FFPROBE_PATH = previous;
      diagnostics.resetDiagnosticsCache();
    }
  }, 30_000);

  it("proves the upload staging path by opening a real session", async () => {
    const check = await diagnostics.checkUploadSubsystem();
    expect(check.status).toBe("ok");
    expect(check.detail?.chunkBytes).toBeGreaterThan(0);
    // The clamp that stops every chunk from becoming a 413.
    expect(Number(check.detail?.chunkBytes)).toBeLessThanOrEqual(
      Number(check.detail?.maxRequestBytes),
    );
  }, 30_000);

  it("confirms the job worker is genuinely running", async () => {
    const check = await diagnostics.checkJobWorker();
    expect(check.status).toBe("ok");
    expect(check.detail?.running).toBe(true);
    // A stopped runner and an idle one look identical from outside; the probe
    // worker must be registered or nothing will ever read a user's media.
    expect(check.detail?.kinds).toContain("probe");
  }, 30_000);

  // -------------------------------------------------------------------------
  // Readiness
  // -------------------------------------------------------------------------

  it("separates 'cannot store bytes' from 'cannot read them'", async () => {
    const report = await diagnostics.runReadinessCheck({ fresh: true });
    // Storage is healthy in this test environment, so ingress must be open
    // whatever the media binaries are doing.
    expect(report.canAcceptUploads).toBe(true);
    expect(typeof report.canProcessMedia).toBe("boolean");
    expect(report.ready).toBe(report.canAcceptUploads && report.canProcessMedia);
    // Only the failures are carried, because that is all a readiness probe or
    // a blocked upload button needs to explain itself.
    for (const problem of report.problems) expect(problem.status).not.toBe("ok");
  }, 60_000);

  it("blocks readiness when the media binaries are gone but keeps ingress open", async () => {
    const previousProbe = process.env.CUTOS_FFPROBE_PATH;
    const previousMpeg = process.env.CUTOS_FFMPEG_PATH;
    process.env.CUTOS_FFPROBE_PATH = join(dir, "no-ffprobe");
    process.env.CUTOS_FFMPEG_PATH = join(dir, "no-ffmpeg");
    diagnostics.resetDiagnosticsCache();
    try {
      const report = await diagnostics.runReadinessCheck({ fresh: true });
      expect(report.ready).toBe(false);
      expect(report.canProcessMedia).toBe(false);
      expect(report.blocking).toContain("ffprobe");
      // The distinction that keeps PR #13's promise: the user's bytes are still
      // safe, so the upload button must NOT be taken away.
      expect(report.canAcceptUploads).toBe(true);
    } finally {
      if (previousProbe === undefined) delete process.env.CUTOS_FFPROBE_PATH;
      else process.env.CUTOS_FFPROBE_PATH = previousProbe;
      if (previousMpeg === undefined) delete process.env.CUTOS_FFMPEG_PATH;
      else process.env.CUTOS_FFMPEG_PATH = previousMpeg;
      diagnostics.resetDiagnosticsCache();
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Preflight
  // -------------------------------------------------------------------------

  it("runs the startup preflight once and reports the same result", async () => {
    diagnostics.resetPreflight();
    const [first, second] = await Promise.all([
      diagnostics.runStartupPreflight(),
      diagnostics.runStartupPreflight(),
    ]);
    // Memoised: a second caller must not re-spawn ffmpeg or re-log the report.
    expect(first).toBe(second);
    expect(first.checks.length).toBeGreaterThan(0);
  }, 60_000);
});
