"use client";

import type { Deployment } from "../hooks/useDeployment.js";
import { t } from "../i18n/index.js";
import { subsystemLabel } from "../lib/diagnostics-label.js";

/**
 * Tell the user the deployment is broken *before* they pick a file.
 *
 * There are two very different failures here and they must not be shown the
 * same way. A server that cannot store bytes has to stop the user outright:
 * letting them send 300 MB into a read-only volume is the exact experience this
 * repair exists to end. A server that can store bytes but cannot read them is
 * merely degraded — the upload will succeed, the file will be safe, and the
 * workspace will open — so it gets a warning and nothing is taken away.
 *
 * Neither variant shows a stack trace or a subsystem's internals. It says what
 * happened, whose problem it is, and what can be done next.
 */
export function DeploymentBanner({ deployment }: { deployment: Deployment }) {
  const { readiness, blocksUpload, warnsProcessing } = deployment;
  if (!readiness || (!blocksUpload && !warnsProcessing)) return null;

  const names = readiness.blocking.map(subsystemLabel).join("、");

  return (
    <div
      className={`deploy-banner ${blocksUpload ? "deploy-banner-error" : "deploy-banner-warn"}`}
      role="alert"
    >
      <p className="deploy-banner-title">
        {blocksUpload ? t("deploy.configErrorTitle") : t("deploy.degradedTitle")}
      </p>
      <p className="deploy-banner-hint">
        {blocksUpload ? t("deploy.configErrorHint") : t("deploy.degradedHint")}
      </p>
      {names && <p className="muted deploy-banner-names">{t("deploy.affected", { names })}</p>}
      <div className="row deploy-banner-actions">
        <button className="btn btn-sm" onClick={() => void deployment.refresh()}>
          {t("deploy.recheck")}
        </button>
      </div>
    </div>
  );
}
