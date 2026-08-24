/**
 * The one module `instrumentation.ts` pulls in at boot.
 *
 * It exists as its own file purely so the build can target it: Next compiles
 * `instrumentation.ts` for the edge runtime as well as Node, and webpack
 * follows a dynamic import into the edge bundle regardless of the
 * `NEXT_RUNTIME` guard around it. Node built-ins (`node:fs`,
 * `node:child_process`) do not exist there, so the build fails.
 *
 * `next.config.mjs` aliases *this specific path* away in the edge build. Keeping
 * that surface down to a single file is what makes the alias precise instead of
 * a blanket rule that could silently swallow a real import.
 */
import { runStartupPreflight } from "./diagnostics.js";
import { logger } from "./logger.js";

/**
 * Validate the deployment, bounded, without ever blocking the boot.
 *
 * A check that hangs must not stop the server from starting: `/api/health` is
 * the tool an operator needs in order to find out why a deployment is broken,
 * and it can only help if the process is actually listening.
 */
export async function preflight(): Promise<void> {
  try {
    await Promise.race([
      runStartupPreflight(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          logger.warn("startup preflight is taking unusually long; continuing to boot", {
            hint: "GET /api/health once the server is up for the completed report.",
          });
          resolve();
        }, 15_000);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    logger.error("startup preflight crashed; continuing to boot", {
      error: error instanceof Error ? error.message : String(error),
      hint: "GET /api/health for the full report.",
    });
  }
}
