"use client";

import type { Editor } from "../hooks/useEditor.js";
import type { OperationDTO, ProjectDTO } from "../lib/types.js";
import { operationLabel, t, type MessageKey } from "../i18n/index.js";
import { formatMs, formatSeconds } from "../lib/format.js";

function opRange(op: OperationDTO): string {
  if (op.atMs != null && op.startMs == null) return formatMs(op.atMs);
  if (op.startMs != null && op.endMs != null) return `${formatMs(op.startMs)}–${formatMs(op.endMs)}`;
  return "";
}

export function EditReviewPanel({ editor, project }: { editor: Editor; project: ProjectDTO }) {
  const plan = project.pendingPlan;
  if (!plan) return null;
  const disabled = editor.busy !== null;
  const riskKey = `review.risk.${plan.impact.riskLevel}` as MessageKey;

  return (
    <div className="card review-card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{t("review.title")}</strong>
        <span className={`pill risk-${plan.impact.riskLevel}`}>
          {t("review.riskLabel", { level: t(riskKey) })}
        </span>
      </div>

      {plan.stale && <div className="msg error" style={{ maxWidth: "100%" }}>{t("review.stale")}</div>}

      <div className="stat" style={{ marginTop: 6 }}>
        <div>
          <b>{formatSeconds(plan.impact.sourceDurationMs)}</b>
          <span>{t("review.before")}</span>
        </div>
        <div>
          <b>{formatSeconds(plan.impact.estimatedDurationMs)}</b>
          <span>{t("review.after")}</span>
        </div>
        <div>
          <b>{formatSeconds(plan.impact.removedMs)}</b>
          <span>{t("review.removed")}</span>
        </div>
        <div>
          <b>{plan.operations.length}</b>
          <span>{t("review.operations")}</span>
        </div>
      </div>

      <ul className="oplist">
        {plan.operations.map((op) => (
          <li key={op.index} className="op-row">
            <div className="op-main">
              <span className={`pill ${op.supported ? "" : "pill-warn"}`}>{operationLabel(op.type)}</span>
              <span>{opRange(op)}</span>
              {op.speed ? <span className="muted"> · {op.speed}x</span> : null}
              {op.reason ? <span className="muted"> · {op.reason}</span> : null}
            </div>
            <div className="op-actions">
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => void editor.previewOp(op.index)}
                disabled={disabled}
              >
                {t("review.preview")}
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => void editor.rejectOp(op.index)}
                disabled={disabled}
              >
                {t("review.reject")}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn-success" onClick={() => void editor.applyPlan()} disabled={disabled || plan.stale}>
          {t("review.applyAll")}
        </button>
        <button className="btn btn-ghost" onClick={() => void editor.discardPlan()} disabled={disabled}>
          {t("review.rejectAll")}
        </button>
      </div>
    </div>
  );
}
