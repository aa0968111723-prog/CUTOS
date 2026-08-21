"use client";

import type { UploadState } from "../lib/upload.js";
import { formatBytes } from "../lib/format.js";
import { errorMessage, t, type MessageKey } from "../i18n/index.js";

/**
 * Live upload status: file name, real byte counts, a real percentage, and a
 * cancel button that actually stops the transfer.
 *
 * Everything shown here is derived from bytes the server has confirmed or the
 * browser has genuinely sent. There is no timer-driven animation, because a
 * progress bar that keeps moving while the network is dead is exactly what
 * made a stuck upload indistinguishable from a working one.
 */
export function UploadProgress({
  upload,
  onCancel,
  onRetryProbe,
  onPickAnother,
}: {
  upload: UploadState;
  onCancel: () => void;
  onRetryProbe: (projectId: string) => void;
  onPickAnother: () => void;
}) {
  if (upload.phase === "idle") return null;

  const percent = Math.round(upload.progress * 100);
  const transferring = upload.phase === "uploading";
  const working =
    upload.phase === "preparing" ||
    upload.phase === "uploading" ||
    upload.phase === "uploaded" ||
    upload.phase === "probing";

  return (
    <div className="upload-card" role="status" aria-live="polite">
      <div className="upload-head">
        <span className="upload-name" title={upload.fileName}>
          {upload.fileName || t("upload.untitledFile")}
        </span>
        <span className="muted upload-size">{formatBytes(upload.totalBytes)}</span>
      </div>

      <p className="muted upload-phase">
        {working && <span className="spinner" />}
        {t(`upload.phase.${upload.phase}` as MessageKey)}
      </p>

      {(transferring || upload.phase === "uploaded") && (
        <>
          <div
            className="upload-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t("upload.progressLabel")}
          >
            <div className="upload-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="muted upload-numbers">
            {t("upload.transferred", {
              done: formatBytes(upload.uploadedBytes),
              total: formatBytes(upload.totalBytes),
              percent,
            })}
          </p>
        </>
      )}

      {upload.phase === "failed" && (
        <p className="upload-error">{errorMessage(upload.errorCode ?? "UNKNOWN")}</p>
      )}

      <div className="row upload-actions">
        {working && (
          <button className="btn btn-sm" onClick={onCancel}>
            {t("upload.cancel")}
          </button>
        )}
        {upload.phase === "failed" && upload.canRetryProbe && upload.projectId && (
          <button
            className="btn btn-sm btn-primary"
            onClick={() => onRetryProbe(upload.projectId as string)}
          >
            {t("upload.retryProbe")}
          </button>
        )}
        {upload.phase === "failed" && (
          <button className="btn btn-sm" onClick={onPickAnother}>
            {t("upload.pickAnother")}
          </button>
        )}
      </div>

      {upload.phase === "failed" && upload.canRetryProbe && (
        <p className="muted upload-hint">{t("upload.assetKept")}</p>
      )}
    </div>
  );
}
