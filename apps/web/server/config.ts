import { join } from "node:path";

/** Runtime configuration + safety limits, overridable via environment. */
export const config = {
  dataDir: process.env.CUTOS_DATA_DIR ?? join(process.cwd(), ".data"),
  storeMode: (process.env.CUTOS_STORE ?? "sqlite") as "sqlite" | "memory",
  /** Max upload size in bytes (default 500 MB). */
  maxUploadBytes: Number.parseInt(process.env.CUTOS_MAX_UPLOAD_BYTES ?? String(500 * 1024 * 1024), 10),
  /** Accepted upload mime prefixes. */
  allowedMimePrefixes: ["video/", "audio/"],
  /** Stale-job recovery threshold. */
  jobStaleMs: 60_000,
};

export function isAllowedMime(mime: string): boolean {
  return config.allowedMimePrefixes.some((p) => mime.startsWith(p));
}
