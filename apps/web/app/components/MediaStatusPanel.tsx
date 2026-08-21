"use client";

import type { ProjectDTO } from "../lib/types.js";
import { errorMessage, t } from "../i18n/index.js";

/**
 * What the workspace shows while a project's media is still being read, or
 * when reading it failed.
 *
 * The distinction that matters here is that a failed probe is not a failed
 * upload: the file is stored, immutable, and complete. So the primary action
 * is "read it again", and re-uploading is never demanded.
 */
export function MediaStatusPanel({
  project,
  onRetryProbe,
  onBack,
}: {
  project: ProjectDTO;
  onRetryProbe: () => void;
  onBack: () => void;
}) {
  const failed = project.mediaStatus === "failed";

  return (
    <section className="card">
      <h2>{project.name}</h2>
      {failed ? (
        <>
          <p className="upload-error">{errorMessage(project.mediaError ?? "PROBE_FAILED")}</p>
          <p className="muted">{t("upload.assetKept")}</p>
        </>
      ) : (
        <p className="muted">
          <span className="spinner" />
          {t("media.processingHint")}
        </p>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        {failed && (
          <button className="btn btn-primary" onClick={onRetryProbe}>
            {t("upload.retryProbe")}
          </button>
        )}
        <button className="btn" onClick={onBack}>
          {t("media.backHome")}
        </button>
      </div>
    </section>
  );
}
