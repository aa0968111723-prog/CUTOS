import { describe, expect, it } from "vitest";
import { isMediaFailed, isMediaPending, isMediaReady, shouldPollMedia } from "./media-status.js";

/**
 * These predicates decide whether a user can see their own project, so the
 * property that matters most is what they do with a value they do NOT
 * recognise. The workspace gate was previously `mediaStatus === "ready"`, and
 * that strictness is exactly what turned "the probe failed" and "this build
 * doesn't know that status" into "you cannot open your project".
 */
describe("media status predicates", () => {
  it("recognises the states where media genuinely is not usable yet", () => {
    expect(isMediaPending("uploaded")).toBe(true);
    expect(isMediaPending("probing")).toBe(true);
    expect(isMediaPending("ready")).toBe(false);
    expect(isMediaPending("failed")).toBe(false);

    expect(isMediaFailed("failed")).toBe(true);
    expect(isMediaFailed("probing")).toBe(false);
  });

  it("treats a ready project as ready", () => {
    expect(isMediaReady("ready")).toBe(true);
    expect(isMediaReady("uploaded")).toBe(false);
    expect(isMediaReady("probing")).toBe(false);
    expect(isMediaReady("failed")).toBe(false);
  });

  it("FAILS OPEN: anything unrecognised counts as ready", () => {
    // A status this build has never heard of, a field dropped by an older
    // server, a partial deploy, a cached response — none of these may lock a
    // user out of a project whose media is probably fine.
    for (const unknown of [undefined, null, "", "unknown", "READY", "Ready", "transcoding", "0"]) {
      expect(isMediaReady(unknown), `locked out on ${JSON.stringify(unknown)}`).toBe(true);
      expect(isMediaPending(unknown)).toBe(false);
      expect(isMediaFailed(unknown)).toBe(false);
    }
  });

  it("polls only while the probe could still change the answer", () => {
    // Pending resolves on its own, so the UI must keep asking.
    expect(shouldPollMedia("uploaded")).toBe(true);
    expect(shouldPollMedia("probing")).toBe(true);
    // These are terminal until the user acts; polling them would spin forever.
    expect(shouldPollMedia("ready")).toBe(false);
    expect(shouldPollMedia("failed")).toBe(false);
    expect(shouldPollMedia(undefined)).toBe(false);
  });

  it("never reports a status as both pending and ready", () => {
    for (const status of ["uploaded", "probing", "ready", "failed", "weird", undefined]) {
      const flags = [isMediaPending(status), isMediaFailed(status), isMediaReady(status)];
      expect(flags.filter(Boolean), `ambiguous for ${status}`).toHaveLength(1);
    }
  });
});
