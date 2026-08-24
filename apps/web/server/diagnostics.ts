import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { supportsResumableUpload } from "@cutos/storage";
import { config, effectiveChunkBytes, uploadLimits } from "./config.js";
import { buildInfo, type BuildInfo } from "./build-info.js";
import { logger } from "./logger.js";
import { getRuntime } from "./runtime.js";

/**
 * Subsystem-level truth about a running deployment.
 *
 * The motivating failure was a production site that was "up" — the container
 * ran, the home page rendered, `{ ok: true }` would have been perfectly honest
 * — and yet could not accept a single video, because the media binaries were
 * missing from the image and the data directory did not survive a restart.
 *
 * An aggregate boolean cannot express that, so nothing here returns one. Each
 * subsystem reports its own state and, when it is broken, the specific reason
 * and the remedy. That is the difference between "the site is down" and "the
 * image has no ffprobe, so every probe job fails".
 */

export type CheckStatus = "ok" | "degraded" | "down";

export interface SubsystemCheck {
  name: string;
  status: CheckStatus;
  /** One line, safe to render in the UI. */
  summary: string;
  /** Stable identifier for the failure mode; empty when healthy. */
  reason?: string;
  /** Structured facts — versions, paths, counts. Never secrets. */
  detail?: Record<string, unknown>;
  /** What an operator should actually change. Only set when not ok. */
  remedy?: string;
  durationMs: number;
}

export interface HealthReport {
  status: CheckStatus;
  checkedAt: string;
  uptimeSeconds: number;
  version: BuildInfo;
  checks: SubsystemCheck[];
  /** Names of `down` checks, so a caller need not filter. */
  failing: string[];
  degraded: string[];
}

/** Subsystems without which the app cannot accept a video at all. */
const INGRESS_CRITICAL = ["dataDirWritable", "database", "storage", "uploadSubsystem"] as const;

/** Subsystems without which an accepted video cannot be processed. */
const PROCESSING_CRITICAL = ["ffprobe", "ffmpeg", "jobWorker"] as const;

async function timed(
  name: string,
  fn: () => Promise<Omit<SubsystemCheck, "name" | "durationMs">>,
): Promise<SubsystemCheck> {
  const started = Date.now();
  try {
    const result = await fn();
    return { name, durationMs: Date.now() - started, ...result };
  } catch (error) {
    // A check that throws is itself a finding — never let it take down the
    // whole report, or a single broken subsystem hides all the others.
    return {
      name,
      status: "down",
      summary: "The check itself failed.",
      reason: "CHECK_THREW",
      detail: { error: error instanceof Error ? error.message : String(error) },
      durationMs: Date.now() - started,
    };
  }
}

// ---------------------------------------------------------------------------
// Individual subsystems
// ---------------------------------------------------------------------------

function checkApp(): SubsystemCheck {
  return {
    name: "app",
    status: "ok",
    summary: "The web process is serving requests.",
    detail: {
      pid: process.pid,
      nodeVersion: process.version,
      environment: process.env.NODE_ENV ?? "development",
      uptimeSeconds: Math.round(process.uptime()),
      port: process.env.PORT ?? "3000 (default)",
      memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    durationMs: 0,
  };
}

/**
 * Prove the data directory is real, present, and writable — by writing to it.
 *
 * `existsSync` is not evidence: a read-only mount, an exhausted volume and a
 * directory owned by another uid all pass it and then fail at the exact moment
 * a user's upload lands. So this does the whole round trip, and reports the
 * resolved path so a misconfigured `CUTOS_DATA_DIR` is visible rather than
 * inferred.
 */
export async function checkDataDir(): Promise<SubsystemCheck> {
  return timed("dataDirWritable", async () => {
    const dir = config.dataDir;
    const configured = process.env.CUTOS_DATA_DIR;
    const detail: Record<string, unknown> = {
      path: dir,
      configured: configured ?? null,
      usingDefault: configured === undefined,
    };

    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      return {
        status: "down",
        summary: `Could not create the data directory at ${dir}.`,
        reason: "DATA_DIR_UNCREATABLE",
        detail: { ...detail, error: error instanceof Error ? error.message : String(error) },
        remedy:
          "Set CUTOS_DATA_DIR to a path on a persistent volume the container can write to.",
      };
    }

    // Unique per invocation, not just per process. `/api/health`, `/api/ready`
    // and the startup preflight can all be in flight at once; sharing one probe
    // path made them overwrite and delete each other's file, and the check
    // then reported a perfectly good volume as incoherent. A diagnostic that
    // invents faults is worse than no diagnostic.
    const probe = join(dir, `.cutos-write-probe-${process.pid}-${randomUUID()}`);
    const payload = `cutos ${Date.now()}`;
    try {
      await writeFile(probe, payload, "utf8");
      const readBack = await readFile(probe, "utf8");
      if (readBack !== payload) {
        return {
          status: "down",
          summary: "The data directory did not read back what was written to it.",
          reason: "DATA_DIR_INCOHERENT",
          detail,
          remedy: "Check the volume backing CUTOS_DATA_DIR; it is not durable.",
        };
      }
    } catch (error) {
      return {
        status: "down",
        summary: `The data directory at ${dir} is not writable.`,
        reason: "DATA_DIR_READONLY",
        detail: { ...detail, error: error instanceof Error ? error.message : String(error) },
        remedy:
          "Mount a writable persistent volume and point CUTOS_DATA_DIR at it.",
      };
    } finally {
      await rm(probe, { force: true }).catch(() => undefined);
    }

    // Writable but ephemeral is a real, separate failure: it works during a
    // demo and loses every project on the next restart. Say so rather than
    // reporting a clean bill of health.
    const ephemeral = looksEphemeral(dir);
    if (ephemeral) {
      return {
        status: "degraded",
        summary: `The data directory at ${dir} looks ephemeral; uploads will not survive a restart.`,
        reason: "DATA_DIR_EPHEMERAL",
        detail: { ...detail, ephemeralHint: ephemeral },
        remedy:
          "Attach a persistent volume and set CUTOS_DATA_DIR to its mount path (e.g. /data).",
      };
    }

    return {
      status: "ok",
      summary: `Data directory is writable at ${dir}.`,
      detail,
    };
  });
}

/**
 * Recognise paths that a container runtime throws away on restart.
 *
 * A heuristic, and deliberately conservative — it only flags locations that are
 * ephemeral by definition. Being wrong in the cautious direction costs a banner
 * an operator can dismiss; being wrong the other way costs someone's video.
 */
export function looksEphemeral(dir: string): string | null {
  if (process.env.CUTOS_DATA_DIR_EPHEMERAL === "0") return null;
  if (process.env.CUTOS_DATA_DIR_EPHEMERAL === "1") return "declared via CUTOS_DATA_DIR_EPHEMERAL";
  if (dir === "/tmp" || dir.startsWith("/tmp/")) return "under /tmp";
  if (dir.startsWith("/var/tmp/")) return "under /var/tmp";
  if (dir.startsWith("/dev/shm")) return "under /dev/shm";
  // The default `${cwd}/.data` lives inside the application directory, which in
  // a container image is part of the image layer — wiped on every redeploy.
  if (process.env.CUTOS_DATA_DIR === undefined && process.env.NODE_ENV === "production") {
    return "defaulted to a path inside the application directory";
  }
  return null;
}

/** Open the project database, write, and read back. Nothing is assumed. */
export async function checkDatabase(): Promise<SubsystemCheck> {
  return timed("database", async () => {
    const detail: Record<string, unknown> = {
      mode: config.storeMode,
      projectDb: config.storeMode === "sqlite" ? join(config.dataDir, "cutos.db") : "memory",
      jobDb: config.storeMode === "sqlite" ? join(config.dataDir, "jobs.db") : "memory",
    };

    const { store, jobStore } = getRuntime();
    // Listing exercises the real schema and the real driver; a store that
    // cannot be queried throws here rather than at a user's first upload.
    const projects = store.listProjects();
    const jobs = jobStore.list({});
    detail.projectCount = projects.length;
    detail.jobCount = jobs.length;

    if (config.storeMode === "memory") {
      return {
        status: "degraded",
        summary: "Running on the in-memory store; every project is lost on restart.",
        reason: "STORE_IN_MEMORY",
        detail,
        remedy: "Unset CUTOS_STORE (or set it to 'sqlite') in production.",
      };
    }

    return { status: "ok", summary: "Project and job databases are readable.", detail };
  });
}

/** Verify object storage can create, resume, and seal an upload. */
export async function checkStorage(): Promise<SubsystemCheck> {
  return timed("storage", async () => {
    const { storage } = getRuntime();
    const root = join(config.dataDir, "storage");
    const detail: Record<string, unknown> = { root, adapter: storage.constructor.name };

    if (!supportsResumableUpload(storage)) {
      return {
        status: "down",
        summary: "The storage adapter cannot perform resumable uploads.",
        reason: "STORAGE_NOT_RESUMABLE",
        detail,
        remedy: "Use a storage adapter that implements createUpload/resumeUpload.",
      };
    }

    await mkdir(root, { recursive: true });
    try {
      await access(root, constants.W_OK);
    } catch {
      return {
        status: "down",
        summary: `The storage root at ${root} is not writable.`,
        reason: "STORAGE_READONLY",
        detail,
        remedy: "Ensure CUTOS_DATA_DIR is on a writable volume.",
      };
    }

    // A full round trip through the real adapter: this is what an upload does,
    // minus the user's bytes.
    const key = `.health/probe-${process.pid}-${Date.now()}`;
    const payload = Buffer.from("cutos-storage-probe");
    try {
      const put = await storage.put(key, payload);
      const back = await storage.stat(key);
      detail.roundTripBytes = back.size;
      if (put.size !== payload.length || back.size !== payload.length) {
        return {
          status: "down",
          summary: "Storage did not return the bytes it was given.",
          reason: "STORAGE_INCOHERENT",
          detail,
          remedy: "Inspect the volume backing CUTOS_DATA_DIR.",
        };
      }
    } finally {
      await storage.delete(key).catch(() => undefined);
    }

    return { status: "ok", summary: "Storage accepted a write/read/delete round trip.", detail };
  });
}

/**
 * Run a media binary's `-version` and report what it actually is.
 *
 * The check is an execution, not a `which`: an ffmpeg on PATH that cannot run
 * (wrong architecture, missing shared library) is exactly as useless as no
 * ffmpeg, and only running it tells them apart.
 */
async function checkMediaBinary(
  name: "ffmpeg" | "ffprobe",
  binary: string,
): Promise<SubsystemCheck> {
  return timed(name, async () => {
    const detail: Record<string, unknown> = { binary };
    const result = await runVersion(binary);
    if (!result.ok) {
      return {
        status: "down",
        summary: `${name} is not runnable in this deployment.`,
        reason: result.reason,
        detail: { ...detail, error: result.error },
        remedy:
          `Install ffmpeg in the production image (the Dockerfile does this), ` +
          `or point CUTOS_${name.toUpperCase()}_PATH at a working binary.`,
      };
    }
    return {
      status: "ok",
      summary: `${name} is available: ${result.version}`,
      detail: { ...detail, version: result.version },
    };
  });
}

interface VersionResult {
  ok: boolean;
  version?: string;
  reason?: string;
  error?: string;
}

function runVersion(binary: string, timeoutMs = 5_000): Promise<VersionResult> {
  return new Promise<VersionResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, reason: "SPAWN_FAILED", error: String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: VersionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: "TIMEOUT", error: `No response within ${timeoutMs}ms.` });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (d: Buffer) => {
      // The first line carries the version; the rest is build configuration.
      if (stdout.length < 512) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 512) stderr += d.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason: error.code === "ENOENT" ? "NOT_INSTALLED" : "SPAWN_FAILED",
        error: error.message,
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        const line = (stdout || stderr).split("\n")[0]?.trim() ?? "";
        finish({ ok: true, version: line.slice(0, 160) });
      } else {
        finish({
          ok: false,
          reason: "NON_ZERO_EXIT",
          error: `exit ${code}: ${(stderr || stdout).slice(0, 200)}`,
        });
      }
    });
  });
}

export const checkFfmpeg = () =>
  checkMediaBinary("ffmpeg", process.env.CUTOS_FFMPEG_PATH ?? "ffmpeg");
export const checkFfprobe = () =>
  checkMediaBinary("ffprobe", process.env.CUTOS_FFPROBE_PATH ?? "ffprobe");

/**
 * Whether the background worker is alive and making progress.
 *
 * A worker that has stopped looks identical to an idle one from the outside,
 * so this reports the queue alongside the running flag: jobs piling up in
 * `queued` while nothing runs is the signature of a dead runner.
 */
export async function checkJobWorker(): Promise<SubsystemCheck> {
  return timed("jobWorker", async () => {
    const { runner, jobStore } = getRuntime();
    const jobs = jobStore.list({});
    const counts = jobs.reduce<Record<string, number>>((acc, job) => {
      acc[job.status] = (acc[job.status] ?? 0) + 1;
      return acc;
    }, {});
    const detail: Record<string, unknown> = {
      running: runner.isRunning,
      kinds: runner.kinds,
      queue: counts,
      staleMs: config.jobStaleMs,
    };

    if (!runner.isRunning) {
      return {
        status: "down",
        summary: "The background job worker is not running.",
        reason: "WORKER_STOPPED",
        detail,
        remedy: "Restart the service; the worker starts with the runtime.",
      };
    }

    // Queued work with nothing running is only alarming once it has had time
    // to be picked up; the runner polls, so a momentary queue is normal.
    const queued = counts.queued ?? 0;
    const running = counts.running ?? 0;
    if (queued > 20 && running === 0) {
      return {
        status: "degraded",
        summary: `${queued} jobs are queued with none running.`,
        reason: "WORKER_BACKLOG",
        detail,
        remedy: "Check the service logs for repeated job failures or an OOM loop.",
      };
    }

    return { status: "ok", summary: "Background job worker is running.", detail };
  });
}

/**
 * End-to-end check of the ingress path, up to but not including user bytes.
 *
 * It opens a real resumable upload against the real adapter and aborts it. That
 * is the same code path `POST /api/uploads` takes, so a staging directory that
 * cannot be created is found here rather than by whoever uploads next.
 */
export async function checkUploadSubsystem(): Promise<SubsystemCheck> {
  return timed("uploadSubsystem", async () => {
    const limits = uploadLimits();
    const detail: Record<string, unknown> = {
      ...limits,
      chunkBytes: effectiveChunkBytes(),
      stagingDir: join(config.dataDir, "storage", ".uploads"),
      sessionTtlMs: config.uploadSessionTtlMs,
      protocol: "POST /api/uploads → PATCH /api/uploads/:id → POST /api/uploads/:id/finalize",
    };

    const { storage } = getRuntime();
    if (!supportsResumableUpload(storage)) {
      return {
        status: "down",
        summary: "Storage cannot stage resumable uploads.",
        reason: "STORAGE_NOT_RESUMABLE",
        detail,
        remedy: "Use the local disk adapter or another resumable-capable backend.",
      };
    }

    const uploadId = `health-${process.pid}-${Date.now()}`;
    try {
      const upload = await storage.createUpload({
        uploadId,
        key: `.health/${uploadId}/probe`,
      });
      await upload.abort();
    } catch (error) {
      return {
        status: "down",
        summary: "Could not open an upload staging session.",
        reason: "UPLOAD_STAGING_FAILED",
        detail: { ...detail, error: error instanceof Error ? error.message : String(error) },
        remedy: "Ensure CUTOS_DATA_DIR is writable and has free space.",
      };
    }

    // A chunk larger than the ingress will pass turns every upload into 413s.
    // The clamp in config.ts prevents it; this reports when it had to engage,
    // because the fix is to set CUTOS_UPLOAD_CHUNK_BYTES properly.
    if (config.uploadChunkBytes > config.maxRequestBytes) {
      return {
        status: "degraded",
        summary: "The configured chunk size exceeds the per-request limit and was clamped.",
        reason: "CHUNK_CLAMPED",
        detail,
        remedy:
          "Set CUTOS_UPLOAD_CHUNK_BYTES at or below CUTOS_MAX_REQUEST_BYTES.",
      };
    }

    return {
      status: "ok",
      summary: "Resumable upload staging is operational.",
      detail,
    };
  });
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Spawning the media binaries on every request would let a health check become
 * its own load problem, so their results are memoised briefly. Everything else
 * is a filesystem round trip and runs fresh each time.
 */
const BINARY_CACHE_MS = 30_000;
let binaryCache: { at: number; checks: SubsystemCheck[] } | null = null;

async function mediaBinaryChecks(fresh: boolean): Promise<SubsystemCheck[]> {
  if (!fresh && binaryCache && Date.now() - binaryCache.at < BINARY_CACHE_MS) {
    return binaryCache.checks.map((check) => ({ ...check, detail: { ...check.detail, cached: true } }));
  }
  const checks = await Promise.all([checkFfmpeg(), checkFfprobe()]);
  binaryCache = { at: Date.now(), checks };
  return checks;
}

/** Drop memoised binary results. Tests, and `?fresh=1`. */
export function resetDiagnosticsCache(): void {
  binaryCache = null;
}

function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

/** Run every subsystem check and assemble the report. */
export async function runHealthChecks(opts: { fresh?: boolean } = {}): Promise<HealthReport> {
  const app = checkApp();

  // The runtime is built lazily, and building it is itself a thing that can
  // fail (an unwritable data directory throws inside mkdirSync). Catching it
  // here is what turns a 500 with a stack trace into a diagnosable report.
  let runtimeChecks: SubsystemCheck[];
  try {
    getRuntime();
    runtimeChecks = await Promise.all([
      checkDataDir(),
      checkDatabase(),
      checkStorage(),
      checkJobWorker(),
      checkUploadSubsystem(),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dataDir = await checkDataDir();
    runtimeChecks = [
      dataDir,
      ...(["database", "storage", "jobWorker", "uploadSubsystem"] as const).map((name) => ({
        name,
        status: "down" as const,
        summary: "The server runtime could not be initialised.",
        reason: "RUNTIME_INIT_FAILED",
        detail: { error: message },
        remedy: "Fix the data directory or database configuration reported above, then restart.",
        durationMs: 0,
      })),
    ];
  }

  const checks = [app, ...runtimeChecks, ...(await mediaBinaryChecks(opts.fresh === true))];
  checks.sort((a, b) => CHECK_ORDER.indexOf(a.name) - CHECK_ORDER.indexOf(b.name));

  return {
    status: worst(checks.map((c) => c.status)),
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    version: buildInfo(),
    checks,
    failing: checks.filter((c) => c.status === "down").map((c) => c.name),
    degraded: checks.filter((c) => c.status === "degraded").map((c) => c.name),
  };
}

/** Presentation order: the request path, from front door to media binaries. */
const CHECK_ORDER = [
  "app",
  "dataDirWritable",
  "database",
  "storage",
  "uploadSubsystem",
  "jobWorker",
  "ffprobe",
  "ffmpeg",
];

export interface ReadinessReport {
  ready: boolean;
  /** Can a user start an upload and have the bytes survive? */
  canAcceptUploads: boolean;
  /** Can an accepted upload actually be read and edited? */
  canProcessMedia: boolean;
  status: CheckStatus;
  blocking: string[];
  degraded: string[];
  checkedAt: string;
  version: BuildInfo;
  /** Only the checks that are not ok — a readiness probe wants the problem. */
  problems: SubsystemCheck[];
}

/**
 * Whether this deployment can genuinely do video work.
 *
 * The two capabilities are separated on purpose. Losing ffprobe is bad but the
 * user's bytes are still safe and their workspace still opens; losing the data
 * directory means an upload is destroyed the moment it is accepted. A UI that
 * treats those the same either blocks people needlessly or lets them upload
 * into a void, and both of those are failures this repair is meant to end.
 */
export async function runReadinessCheck(opts: { fresh?: boolean } = {}): Promise<ReadinessReport> {
  const report = await runHealthChecks(opts);
  const byName = new Map(report.checks.map((c) => [c.name, c]));
  const isDown = (name: string) => byName.get(name)?.status === "down";

  const ingressBlocking = INGRESS_CRITICAL.filter(isDown);
  const processingBlocking = PROCESSING_CRITICAL.filter(isDown);

  return {
    ready: ingressBlocking.length === 0 && processingBlocking.length === 0,
    canAcceptUploads: ingressBlocking.length === 0,
    canProcessMedia: processingBlocking.length === 0,
    status: report.status,
    blocking: [...ingressBlocking, ...processingBlocking],
    degraded: report.degraded,
    checkedAt: report.checkedAt,
    version: report.version,
    problems: report.checks.filter((c) => c.status !== "ok"),
  };
}

// ---------------------------------------------------------------------------
// Startup preflight
// ---------------------------------------------------------------------------

let preflightPromise: Promise<HealthReport> | null = null;

/**
 * Validate the deployment at boot and say so, loudly, in the logs.
 *
 * A misconfigured container that starts quietly and fails at a user's first
 * upload is the single most expensive shape this project has hit. So every
 * broken subsystem is logged at error level with its reason and its remedy,
 * once, at startup — before anyone has a chance to try uploading into it.
 *
 * It deliberately does NOT exit the process. A server that refuses to boot
 * cannot serve `/api/health`, which is precisely the tool an operator needs to
 * find out why it will not boot. Reporting beats dying.
 */
export function runStartupPreflight(): Promise<HealthReport> {
  if (preflightPromise) return preflightPromise;
  const log = logger.child({ component: "preflight" });

  preflightPromise = (async () => {
    const report = await runHealthChecks({ fresh: true });
    const version = report.version;

    log.info("CUTOS startup preflight", {
      appVersion: version.appVersion,
      gitSha: version.gitSha ?? "unknown",
      gitBranch: version.gitBranch ?? "unknown",
      buildTime: version.buildTime ?? "unknown",
      uploadProtocolVersion: version.uploadProtocolVersion,
      versionSource: version.source,
      dataDir: config.dataDir,
      storeMode: config.storeMode,
    });

    for (const check of report.checks) {
      if (check.status === "ok") {
        log.info(`preflight ok: ${check.name}`, { summary: check.summary });
      } else if (check.status === "degraded") {
        log.warn(`preflight DEGRADED: ${check.name}`, {
          reason: check.reason,
          summary: check.summary,
          remedy: check.remedy,
          detail: check.detail,
        });
      } else {
        log.error(`preflight FAILED: ${check.name}`, {
          reason: check.reason,
          summary: check.summary,
          remedy: check.remedy,
          detail: check.detail,
        });
      }
    }

    if (report.failing.length > 0) {
      log.error("CUTOS is NOT ready to accept video work", {
        failing: report.failing,
        hint: "GET /api/health for the full report; GET /api/ready for the gate.",
      });
    } else if (report.degraded.length > 0) {
      log.warn("CUTOS started with degraded subsystems", { degraded: report.degraded });
    } else {
      log.info("CUTOS preflight passed; ready to accept video work");
    }

    return report;
  })();

  return preflightPromise;
}

/** Reset memoised preflight state. Tests only. */
export function resetPreflight(): void {
  preflightPromise = null;
  binaryCache = null;
}

/** Best-effort existence check used by the startup log for the data volume. */
export async function dataDirStat(): Promise<{ exists: boolean; isDirectory: boolean }> {
  try {
    const s = await stat(config.dataDir);
    return { exists: true, isDirectory: s.isDirectory() };
  } catch {
    return { exists: false, isDirectory: false };
  }
}
