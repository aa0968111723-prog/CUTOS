"use client";

import type { ProjectDTO } from "../lib/types.js";
import { isMediaFailed } from "../lib/media-status.js";
import { errorMessage, t } from "../i18n/index.js";

/**
 * Media status shown *inside* the workspace, never instead of it.
 *
 * This replaced a full-screen panel that stood in for the workspace whenever
 * `mediaStatus !== "ready"`. That panel had no way forward: a project whose
 * probe failed became unreachable, and a project that was still probing stayed
 * unreachable even after the probe succeeded. A banner keeps the same honest
 * information while leaving the user in their project.
 */
export function MediaStatusBanner({
  project,
  onRetryProbe,
}: {
  project: ProjectDTO;
  onRetryProbe: () => void;
}) {
  const failed = isMediaFailed(project.mediaStatus);

  return (
    <div className={`media-banner ${failed ? "media-banner-failed" : ""}`} role="status" aria-live="polite">
      <div className="media-banner-text">
        {!failed && <span className="spinner" />}
        <div>
          <p className="media-banner-title">
            {failed ? errorMessage(project.mediaError ?? "PROBE_FAILED") : t("media.processingHint")}
          </p>
          {failed && <p className="muted media-banner-hint">{t("upload.assetKept")}</p>}
        </div>
      </div>
      {/* Never gated on `failed`. A probe that died without recording an
          outcome leaves the project reading "probing" forever, and gating the
          only forward action on "failed" is precisely what made that state
          unrecoverable. Re-probing an already-probing project is harmless. */}
      <button
        className={`btn btn-sm ${failed ? "btn-primary" : ""}`}
        onClick={onRetryProbe}
      >
        {t("upload.retryProbe")}
      </button>
    </div>
  );
}
