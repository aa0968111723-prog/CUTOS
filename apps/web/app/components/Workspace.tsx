"use client";

import { useEditor } from "../hooks/useEditor.js";
import { ImportView } from "./ImportView.js";
import { ProjectSidebar } from "./ProjectSidebar.js";
import { PlayerPanel } from "./PlayerPanel.js";
import { TimelinePanel } from "./TimelinePanel.js";
import { AgentPanel } from "./AgentPanel.js";
import { AgentActivity } from "./AgentActivity.js";
import { EditReviewPanel } from "./EditReviewPanel.js";
import { InspectorPanel } from "./InspectorPanel.js";
import { ExportPanel } from "./ExportPanel.js";
import { JobCenter } from "./JobCenter.js";

export function Workspace() {
  const editor = useEditor();
  const { project } = editor;

  return (
    <div className="app">
      <header className="brand">
        <h1>CUTOS</h1>
        <span className="tag">agent-first conversational video editor</span>
        {project && <span className="badge">provider: {project.provider}</span>}
      </header>

      {!project ? (
        <ImportView editor={editor} />
      ) : (
        <>
          <PlayerPanel project={project} />
          <div className="ws-grid">
            <section className="ws-agent">
              <AgentPanel editor={editor} />
              <EditReviewPanel editor={editor} project={project} />
              <AgentActivity project={project} />
            </section>

            <main className="ws-main">
              <TimelinePanel editor={editor} project={project} />
              <ExportPanel editor={editor} project={project} />
            </main>

            <aside className="ws-side">
              <ProjectSidebar editor={editor} />
              <InspectorPanel project={project} />
            </aside>
          </div>
        </>
      )}

      <JobCenter job={editor.job} />
    </div>
  );
}
