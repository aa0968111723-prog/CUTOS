"use client";

import { useMemo, useState } from "react";
import type { PreviewManifest } from "@cutos/preview";
import { useEditor, type Editor } from "../hooks/useEditor.js";
import { usePreview } from "../preview/usePreview.js";
import type { ProjectDTO } from "../lib/types.js";
import { isMediaReady } from "../lib/media-status.js";
import { t } from "../i18n/index.js";
import { ImportView } from "./ImportView.js";
import { ProjectSidebar } from "./ProjectSidebar.js";
import { StatsBar } from "./StatsBar.js";
import { EditedPreviewPlayer } from "./EditedPreviewPlayer.js";
import { TimelinePanel } from "./TimelinePanel.js";
import { AgentPanel } from "./AgentPanel.js";
import { AgentActivity } from "./AgentActivity.js";
import { EditReviewPanel } from "./EditReviewPanel.js";
import { InspectorPanel } from "./InspectorPanel.js";
import { AiosPanel } from "./AiosPanel.js";
import { ExportPanel } from "./ExportPanel.js";
import { JobCenter } from "./JobCenter.js";
import { MediaStatusBanner } from "./MediaStatusBanner.js";

export function Workspace() {
  const editor = useEditor();
  return (
    <div className="app">
      <header className="brand">
        <h1>{t("app.name")}</h1>
        <span className="tag">{t("app.tagline")}</span>
        {editor.project && <span className="badge">{editor.project.provider}</span>}
      </header>
      {editor.project ? <WorkspaceInner editor={editor} project={editor.project} /> : <ImportView editor={editor} />}
      <JobCenter job={editor.job} />
    </div>
  );
}

function WorkspaceInner({ editor, project }: { editor: Editor; project: ProjectDTO }) {
  const [mode, setMode] = useState<"edited" | "original">("edited");
  // A project exists before its media has been read. That is worth SAYING, but
  // never worth withholding the workspace for: this used to early-return a
  // panel, which stranded anyone whose probe failed and anyone who opened a
  // project mid-probe. The banner reports the same thing from inside.
  const mediaReady = isMediaReady(project.mediaStatus);
  const sourceUrl = `/api/projects/${project.id}/source`;

  const originalManifest = useMemo<PreviewManifest>(
    () => ({
      timelineRevision: -1,
      durationMs: project.source.durationMs,
      hasAudio: project.source.hasAudio,
      segments: [
        {
          index: 0,
          clipId: "original",
          sourceInMs: 0,
          sourceOutMs: project.source.durationMs,
          speed: 1,
          timelineInMs: 0,
          timelineOutMs: project.source.durationMs,
        },
      ],
      captions: [],
      markers: [],
    }),
    [project.source.durationMs, project.source.hasAudio],
  );

  const effective = editor.previewOverride ?? (mode === "original" ? originalManifest : project.preview);
  const { videoRef, state, controls } = usePreview(effective, sourceUrl);

  return (
    <>
      {!mediaReady && (
        <MediaStatusBanner project={project} onRetryProbe={() => void editor.retryProbe(project.id)} />
      )}
      <StatsBar project={project} />
      <EditedPreviewPlayer
        videoRef={videoRef}
        state={state}
        controls={controls}
        manifest={effective}
        mode={mode}
        onModeChange={setMode}
        overrideActive={editor.previewOverride !== null}
        onExitOverride={editor.exitPreview}
      />

      <div className="ws-grid">
        <section className="ws-agent">
          <AgentPanel editor={editor} />
          <EditReviewPanel editor={editor} project={project} />
          <AgentActivity project={project} />
        </section>

        <main className="ws-main">
          <TimelinePanel editor={editor} project={project} currentMs={state.currentMs} onSeek={controls.seek} />
          <ExportPanel editor={editor} project={project} />
        </main>

        <aside className="ws-side">
          <ProjectSidebar editor={editor} />
          <AiosPanel integration={project.integration} />
          <InspectorPanel project={project} />
        </aside>
      </div>
    </>
  );
}
