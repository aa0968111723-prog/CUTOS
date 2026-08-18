"use client";

import type { ProjectDTO } from "../lib/types.js";
import { formatSeconds } from "../lib/format.js";

export function PlayerPanel({ project }: { project: ProjectDTO }) {
  const removedMs = Math.max(0, project.source.durationMs - project.timeline.durationMs);
  return (
    <div className="card">
      <h2>Preview — original source (immutable)</h2>
      <video className="player" src={`/api/projects/${project.id}/source`} controls />
      <div className="stat" style={{ marginTop: 14 }}>
        <div>
          <b>{formatSeconds(project.source.durationMs)}</b>
          <span>source</span>
        </div>
        <div>
          <b>{formatSeconds(project.timeline.durationMs)}</b>
          <span>edited</span>
        </div>
        <div>
          <b>{formatSeconds(removedMs)}</b>
          <span>removed</span>
        </div>
        <div>
          <b>{project.timeline.clips.length}</b>
          <span>clips</span>
        </div>
        <div>
          <b>rev {project.timelineRevision}</b>
          <span>timeline</span>
        </div>
      </div>
    </div>
  );
}
