#!/usr/bin/env node
/**
 * Stamp the build with the commit it came from.
 *
 * Runs before `next build` and writes `apps/web/.build-info.json`, which the
 * server reads as a fallback when the platform exposes no commit variable of
 * its own. It is a fallback rather than the primary source on purpose: a layer
 * cache can hand a rebuild an older stamp than the code beside it, whereas a
 * variable injected by the platform doing the deploying cannot be stale.
 *
 * Never fails the build. A build with an unknown SHA is worth having; a build
 * that could not start because git was absent from the image is not.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outPath = join(repoRoot, "apps", "web", ".build-info.json");

/** First non-empty environment variable from the list. */
function env(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    // No git binary, or no .git directory — both are normal inside a build
    // container that received a source tarball rather than a clone.
    return null;
  }
}

const gitSha =
  env([
    "ZEABUR_GIT_COMMIT_SHA",
    "CUTOS_GIT_SHA",
    "GIT_COMMIT_SHA",
    "SOURCE_COMMIT",
    "VERCEL_GIT_COMMIT_SHA",
    "RAILWAY_GIT_COMMIT_SHA",
    "GITHUB_SHA",
  ]) ?? git(["rev-parse", "HEAD"]);

const gitBranch =
  env([
    "ZEABUR_GIT_BRANCH",
    "CUTOS_GIT_BRANCH",
    "GIT_BRANCH",
    "VERCEL_GIT_COMMIT_REF",
    "RAILWAY_GIT_BRANCH",
    "GITHUB_REF_NAME",
  ]) ?? git(["rev-parse", "--abbrev-ref", "HEAD"]);

const info = {
  gitSha,
  gitBranch,
  buildTime: new Date().toISOString(),
  // Recorded so a report can distinguish "the stamp says unknown" from "there
  // was no stamp at all", which are different deployment problems.
  stampedBy: "scripts/write-build-info.mjs",
};

try {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  console.log(
    `[build-info] ${info.gitSha ?? "unknown sha"} (${info.gitBranch ?? "unknown branch"}) at ${info.buildTime}`,
  );
} catch (error) {
  console.warn(`[build-info] could not write ${outPath}: ${error.message}`);
}
