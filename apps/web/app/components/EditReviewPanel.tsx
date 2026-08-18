"use client";

import type { Editor } from "../hooks/useEditor.js";
import type { OperationDTO, ProjectDTO } from "../lib/types.js";
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

  return (
    <div className="card review-card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Proposed Edit Plan</strong>
        <span className={`pill risk-${plan.impact.riskLevel}`}>risk: {plan.impact.riskLevel}</span>
      </div>

      {plan.stale && (
        <div className="msg error" style={{ maxWidth: "100%" }}>
          This plan is stale — the timeline changed since it was created. Re-run the request.
        </div>
      )}

      <div className="stat" style={{ marginTop: 6 }}>
        <div>
          <b>{formatSeconds(plan.impact.sourceDurationMs)}</b>
          <span>before</span>
        </div>
        <div>
          <b>{formatSeconds(plan.impact.estimatedDurationMs)}</b>
          <span>after (est.)</span>
        </div>
        <div>
          <b>{formatSeconds(plan.impact.removedMs)}</b>
          <span>removed</span>
        </div>
        <div>
          <b>{plan.operations.length}</b>
          <span>operations</span>
        </div>
      </div>

      <ul className="oplist">
        {plan.operations.map((op) => (
          <li key={op.index} className="op-row">
            <div className="op-main">
              <span className={`pill ${op.supported ? "" : "pill-warn"}`}>{op.type}</span>
              <span>{opRange(op)}</span>
              {op.speed ? <span className="muted"> · {op.speed}x</span> : null}
              {op.reason ? <span className="muted"> · {op.reason}</span> : null}
            </div>
            <div className="op-actions">
              {editor.previews[op.index] && (
                <span className="muted" style={{ fontSize: 12 }}>
                  −{formatSeconds(editor.previews[op.index]!.removedMs)}
                </span>
              )}
              <button className="btn btn-sm btn-ghost" onClick={() => void editor.previewOp(op.index)} disabled={disabled}>
                Preview
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => void editor.rejectOp(op.index)} disabled={disabled}>
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>

      {plan.requiresApproval && <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>{plan.approvalReason}</p>}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn-success" onClick={() => void editor.applyPlan()} disabled={disabled || plan.stale}>
          Accept all &amp; apply
        </button>
        <button className="btn btn-ghost" onClick={() => void editor.discardPlan()} disabled={disabled}>
          Reject all
        </button>
      </div>
    </div>
  );
}
