/**
 * Boot-time validation of the deployment.
 *
 * Next calls `register()` once, before the server accepts its first request.
 * That is the only hook that runs without a user, which makes it the only place
 * a misconfigured container can announce itself *before* somebody discovers it
 * by losing an upload. Without it the checks fire on the first request that
 * touches the runtime — and the home page does not, so a broken deployment
 * could sit there logging nothing at all.
 */
export async function register(): Promise<void> {
  // Edge has no filesystem and no child processes; the checks are meaningless
  // there. `next.config.mjs` also aliases the import below out of that bundle,
  // because webpack follows it regardless of this guard.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `next build` evaluates this too. Probing the build machine's disk and
  // binaries says nothing about production.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.CUTOS_SKIP_PREFLIGHT === "1") return;

  const { preflight } = await import("./server/preflight-entry.js");
  await preflight();
}
