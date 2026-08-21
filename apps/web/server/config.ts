import { join } from "node:path";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MiB = 1024 * 1024;

/** Runtime configuration + safety limits, overridable via environment. */
export const config = {
  dataDir: process.env.CUTOS_DATA_DIR ?? join(process.cwd(), ".data"),
  storeMode: (process.env.CUTOS_STORE ?? "sqlite") as "sqlite" | "memory",
  /**
   * Largest media file a user may upload in total (default 500 MB).
   *
   * This is a CUTOS policy limit, NOT a promise that the deployment's ingress
   * will pass a 500 MB request — nothing does. It is enforceable only because
   * uploads are chunked: see {@link maxRequestBytes}.
   */
  maxUploadBytes: intFromEnv("CUTOS_MAX_UPLOAD_BYTES", 500 * MiB),
  /**
   * Largest body a single HTTP request may carry (default 8 MB).
   *
   * This is the number that must stay under the platform's real limit — the
   * reverse proxy / ingress in front of the app server (Zeabur, nginx,
   * Cloudflare, …). Decoupling it from {@link maxUploadBytes} is what lets a
   * 500 MB video through a deployment that would reject a 500 MB request.
   */
  maxRequestBytes: intFromEnv("CUTOS_MAX_REQUEST_BYTES", 8 * MiB),
  /** Chunk size handed to the browser; clamped to {@link maxRequestBytes}. */
  uploadChunkBytes: intFromEnv("CUTOS_UPLOAD_CHUNK_BYTES", 5 * MiB),
  /** How long an unfinished upload session may sit before it is swept. */
  uploadSessionTtlMs: intFromEnv("CUTOS_UPLOAD_SESSION_TTL_MS", 6 * 60 * 60 * 1000),
  /** Accepted upload mime prefixes. */
  allowedMimePrefixes: ["video/", "audio/"],
  /** Stale-job recovery threshold. */
  jobStaleMs: intFromEnv("CUTOS_JOB_STALE_MS", 60_000),
};

export function isAllowedMime(mime: string): boolean {
  return config.allowedMimePrefixes.some((p) => mime.startsWith(p));
}

/**
 * The chunk size actually advertised to clients.
 *
 * A chunk larger than what the ingress accepts turns every upload into a wall
 * of 413s, so the clamp is a correctness guard, not a nicety.
 */
export function effectiveChunkBytes(): number {
  return Math.max(64 * 1024, Math.min(config.uploadChunkBytes, config.maxRequestBytes));
}

/**
 * What the client needs to plan an upload. Deliberately free of any server
 * path: the browser never learns where bytes land on disk.
 */
export interface UploadLimits {
  maxUploadBytes: number;
  maxRequestBytes: number;
  chunkBytes: number;
  allowedMimePrefixes: string[];
}

export function uploadLimits(): UploadLimits {
  return {
    maxUploadBytes: config.maxUploadBytes,
    maxRequestBytes: config.maxRequestBytes,
    chunkBytes: effectiveChunkBytes(),
    allowedMimePrefixes: [...config.allowedMimePrefixes],
  };
}
