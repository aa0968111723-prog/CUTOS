"use client";

import type { ProjectDTO } from "../lib/types.js";

/**
 * Verifiable agent activity: the recorded steps of the latest run (analyzing,
 * planning, validating, awaiting approval). Never hidden chain-of-thought.
 */
export function AgentActivity({ project }: { project: ProjectDTO }) {
  const run = project.agentRuns[0];
  if (!run) return null;
  return (
    <div className="card">
      <h2>Agent activity</h2>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {run.input} · <span className="pill">{run.status}</span>
      </div>
      <ol className="activity">
        {run.steps.map((s, i) => (
          <li key={i} className={`activity-step kind-${s.kind}`}>
            <span className="activity-title">{s.title}</span>
            {s.detail && <span className="activity-detail">{s.detail}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
