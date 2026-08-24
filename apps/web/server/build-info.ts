import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UPLOAD_PROTOCOL_VERSION } from "../app/lib/upload-protocol.js";

/**
 * What build is actually running.
 *
 * This module exists because of a specific, expensive failure: the production
 * site kept serving a build from before the streaming-upload fix, and there was
 * no way to tell. The deployed app looked like the repository, the repository
 * looked correct, and the only symptom was a user on a phone watching a
 * spinner that a merged commit had already deleted.
 *
 * So the running process has to be able to say what it is. Nothing here is
 * decorative: `gitSha` answers "is production on main?", and
 * {@link UPLOAD_PROTOCOL_VERSION} answers "does this build have the new upload
 * path?" without anyone having to reason about commit graphs.
 */

/**
 * Re-exported from the browser-safe module so the server and the client bundle
 * cannot drift. A deployment reporting anything below the current value — or no
 * version at all — is running code from before the streaming-upload fix,
 * whatever its dashboard claims.
 */
export { UPLOAD_PROTOCOL_VERSION };

export interface BuildInfo {
  /** Commit the running code was built from, or null when unknowable. */
  gitSha: string | null;
  /** First 7 characters of {@link gitSha}, for display. */
  gitShaShort: string | null;
  /** Branch the build came from, when the platform exposes it. */
  gitBranch: string | null;
  /** ISO-8601 build timestamp, or null when the build did not record one. */
  buildTime: string | null;
  /** Version from the web app's package.json. */
  appVersion: string;
  uploadProtocolVersion: number;
  /** Where `gitSha` came from — invaluable when it is wrong or missing. */
  source: string;
  /** NODE_ENV of the running process. */
  environment: string;
  nodeVersion: string;
}

/**
 * Environment variables that may carry the commit, most trustworthy first.
 *
 * Zeabur's own variables lead because they are injected by the platform doing
 * the deploying — they cannot be stale relative to the running container the
 * way a value baked at image-build time can. The rest let the same code report
 * honestly under Docker, Vercel, Railway, or a plain CI build.
 */
const SHA_ENV_KEYS = [
  "ZEABUR_GIT_COMMIT_SHA",
  "CUTOS_GIT_SHA",
  "GIT_COMMIT_SHA",
  "SOURCE_COMMIT",
  "VERCEL_GIT_COMMIT_SHA",
  "RAILWAY_GIT_COMMIT_SHA",
  "GITHUB_SHA",
] as const;

const BRANCH_ENV_KEYS = [
  "ZEABUR_GIT_BRANCH",
  "CUTOS_GIT_BRANCH",
  "GIT_BRANCH",
  "VERCEL_GIT_COMMIT_REF",
  "RAILWAY_GIT_BRANCH",
  "GITHUB_REF_NAME",
] as const;

function fromEnv(keys: readonly string[]): { value: string; key: string } | null {
  for (const key of keys) {
    const raw = process.env[key];
    if (typeof raw === "string" && raw.trim() !== "") {
      return { value: raw.trim(), key };
    }
  }
  return null;
}

interface StampedBuildInfo {
  gitSha?: unknown;
  gitBranch?: unknown;
  buildTime?: unknown;
}

/**
 * Read the stamp `scripts/write-build-info.mjs` leaves next to the build.
 *
 * It is the fallback, not the primary source: an image can be rebuilt from a
 * cached layer whose stamp is older than the code around it. Read lazily and
 * cached, because a missing file is the normal case in development and must
 * cost nothing.
 */
let stampCache: StampedBuildInfo | null | undefined;

function readStamp(): StampedBuildInfo | null {
  if (stampCache !== undefined) return stampCache;
  const path = join(process.cwd(), ".build-info.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    stampCache = typeof parsed === "object" && parsed !== null ? (parsed as StampedBuildInfo) : null;
  } catch {
    // No stamp is a legitimate state (dev server, `next start` from source).
    stampCache = null;
  }
  return stampCache;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Resolve the running build's identity. Cheap enough to call per request. */
export function buildInfo(): BuildInfo {
  const stamp = readStamp();

  const shaEnv = fromEnv(SHA_ENV_KEYS);
  const stampSha = stringOrNull(stamp?.gitSha);
  const gitSha = shaEnv?.value ?? stampSha;
  const source = shaEnv ? `env:${shaEnv.key}` : stampSha ? "build-stamp" : "unknown";

  const branchEnv = fromEnv(BRANCH_ENV_KEYS);
  const gitBranch = branchEnv?.value ?? stringOrNull(stamp?.gitBranch);

  const buildTime =
    stringOrNull(process.env.CUTOS_BUILD_TIME) ?? stringOrNull(stamp?.buildTime);

  return {
    gitSha,
    gitShaShort: gitSha ? gitSha.slice(0, 7) : null,
    gitBranch,
    buildTime,
    appVersion: process.env.CUTOS_APP_VERSION ?? APP_VERSION,
    uploadProtocolVersion: UPLOAD_PROTOCOL_VERSION,
    source,
    environment: process.env.NODE_ENV ?? "development",
    nodeVersion: process.version,
  };
}

/**
 * Kept as a literal rather than imported from package.json: a JSON import would
 * pull the manifest into the client bundle under some Next configurations, and
 * this value is checked by a test that fails if the two ever drift.
 */
export const APP_VERSION = "0.1.0";

/** Reset the memoised stamp. Tests only. */
export function resetBuildInfoCache(): void {
  stampCache = undefined;
}
