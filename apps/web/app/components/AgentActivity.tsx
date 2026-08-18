"use client";

import type { AgentStepDTO, ProjectDTO } from "../lib/types.js";
import { activityLabel, t, type MessageKey } from "../i18n/index.js";

/**
 * Verifiable agent activity: the recorded steps of the latest run, localized by
 * step `kind` + structured data. Never hidden chain-of-thought.
 */
function stepDetail(step: AgentStepDTO): string | undefined {
  const d = step.data;
  switch (step.kind) {
    case "observe":
      return step.detail; // the user's own instruction
    case "context":
      return d
        ? t("activity.contextDetail", {
            seconds: Number(d.seconds ?? 0),
            pauses: Number(d.pauses ?? 0),
            revision: Number(d.revision ?? 0),
          })
        : undefined;
    case "validate":
      return d
        ? t("activity.planDetail", {
            count: Number(d.count ?? 0),
            seconds: Number(d.seconds ?? 0),
            risk: riskLabel(String(d.risk ?? "")),
          })
        : undefined;
    case "execute":
      return d
        ? t("activity.executeDetail", {
            before: `${Number(d.before ?? 0) / 1000}s`,
            after: `${Number(d.after ?? 0) / 1000}s`,
          })
        : undefined;
    case "plan":
    case "summary":
      return step.detail; // zh-TW plan summary from the planner
    default:
      return undefined;
  }
}

function riskLabel(risk: string): string {
  const key = `review.risk.${risk}` as MessageKey;
  const label = t(key);
  return label === key ? risk : label;
}

export function AgentActivity({ project }: { project: ProjectDTO }) {
  const run = project.agentRuns[0];
  if (!run) return null;
  const statusKey = `activity.status.${run.status}` as MessageKey;
  return (
    <div className="card">
      <h2>{t("activity.title")}</h2>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {run.input} · <span className="pill">{t(statusKey)}</span>
      </div>
      <ol className="activity">
        {run.steps.map((s, i) => {
          const detail = stepDetail(s);
          return (
            <li key={i} className={`activity-step kind-${s.kind}`}>
              <span className="activity-title">{activityLabel(s.kind)}</span>
              {detail && <span className="activity-detail">{detail}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
