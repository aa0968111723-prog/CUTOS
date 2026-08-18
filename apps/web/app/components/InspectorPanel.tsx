"use client";

import type { ProjectDTO } from "../lib/types.js";

export function InspectorPanel({ project }: { project: ProjectDTO }) {
  return (
    <div className="card">
      <h2>Inspector</h2>
      <dl className="inspector">
        <div><dt>Provider</dt><dd>{project.provider}</dd></div>
        <div><dt>Resolution</dt><dd>{project.source.width ?? "?"}×{project.source.height ?? "?"}</dd></div>
        <div><dt>Audio</dt><dd>{project.source.hasAudio ? "yes" : "no"}</dd></div>
        <div><dt>Version</dt><dd>{project.version}</dd></div>
        <div><dt>Timeline rev</dt><dd>{project.timelineRevision}</dd></div>
        <div><dt>Pauses</dt><dd>{project.analysis?.silences.length ?? "—"}</dd></div>
        <div><dt>Waveform</dt><dd>{project.analysis?.hasWaveform ? "yes" : "—"}</dd></div>
        <div><dt>Sentences</dt><dd>{project.analysis?.sentenceCount ?? "—"}</dd></div>
      </dl>
    </div>
  );
}
