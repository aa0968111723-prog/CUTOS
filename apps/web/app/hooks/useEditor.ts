"use client";

import { useCallback, useEffect, useState } from "react";
import {
  applyPlan as apiApply,
  createSampleProject,
  deleteProject as apiDelete,
  discardPlan as apiDiscard,
  getProject,
  listProjects,
  previewOperation,
  redo as apiRedo,
  rejectOperation,
  requestPlan,
  startAnalyze,
  startExport,
  undo as apiUndo,
  uploadProject,
  waitForJob,
  type JobDTO,
  type PreviewResult,
} from "../lib/api.js";
import type { ProjectDTO, ProjectSummaryDTO } from "../lib/types.js";

export interface ChatMessage {
  role: "user" | "agent" | "error";
  text: string;
}

export interface Editor {
  projects: ProjectSummaryDTO[];
  project: ProjectDTO | null;
  messages: ChatMessage[];
  busy: string | null;
  job: JobDTO | null;
  previews: Record<number, PreviewResult>;
  refreshProjects: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => void;
  importSample: () => Promise<void>;
  importUpload: (file: File) => Promise<void>;
  sendInstruction: (text: string) => Promise<void>;
  applyPlan: () => Promise<void>;
  discardPlan: () => Promise<void>;
  rejectOp: (index: number) => Promise<void>;
  previewOp: (index: number) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  runExport: () => Promise<void>;
  removeProject: (id: string) => Promise<void>;
}

export function useEditor(): Editor {
  const [projects, setProjects] = useState<ProjectSummaryDTO[]>([]);
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [job, setJob] = useState<JobDTO | null>(null);
  const [previews, setPreviews] = useState<Record<number, PreviewResult>>({});

  const say = useCallback((role: ChatMessage["role"], text: string) => {
    setMessages((prev) => [...prev, { role, text }]);
  }, []);

  const fail = useCallback((error: unknown) => {
    say("error", error instanceof Error ? error.message : String(error));
  }, [say]);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (error) {
      fail(error);
    }
  }, [fail]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const runAnalysis = useCallback(
    async (id: string) => {
      setBusy("Analyzing video…");
      try {
        const jobId = await startAnalyze(id, { thresholdDb: -30, minSilenceMs: 700 });
        await waitForJob(jobId, setJob);
        const updated = await getProject(id);
        setProject(updated);
        const count = updated.analysis?.silences.length ?? 0;
        say(
          "agent",
          count > 0
            ? `I analyzed the video and found ${count} silent pause${count === 1 ? "" : "s"}. Tell me what to do — e.g. "remove pauses longer than 1 second".`
            : `I analyzed the video. Tell me what you'd like to change.`,
        );
      } catch (error) {
        fail(error);
      } finally {
        setBusy(null);
        setJob(null);
      }
    },
    [fail, say],
  );

  const startProject = useCallback(
    async (loader: () => Promise<ProjectDTO>, label: string) => {
      setBusy(label);
      setMessages([]);
      setPreviews({});
      try {
        const created = await loader();
        setProject(created);
        say("agent", `Imported "${created.name}".`);
        await refreshProjects();
        await runAnalysis(created.id);
      } catch (error) {
        fail(error);
        setBusy(null);
      }
    },
    [fail, refreshProjects, runAnalysis, say],
  );

  const importSample = useCallback(() => startProject(createSampleProject, "Importing demo clip…"), [startProject]);
  const importUpload = useCallback(
    (file: File) => startProject(() => uploadProject(file), "Uploading and probing…"),
    [startProject],
  );

  const openProject = useCallback(
    async (id: string) => {
      setBusy("Loading project…");
      setMessages([]);
      setPreviews({});
      try {
        setProject(await getProject(id));
      } catch (error) {
        fail(error);
      } finally {
        setBusy(null);
      }
    },
    [fail],
  );

  const closeProject = useCallback(() => {
    setProject(null);
    setMessages([]);
    setPreviews({});
  }, []);

  const sendInstruction = useCallback(
    async (text: string) => {
      if (!project || !text.trim()) return;
      say("user", text);
      setBusy("Agent is planning…");
      setPreviews({});
      try {
        const { dto, status } = await requestPlan(project.id, text);
        setProject(dto);
        if (dto.pendingPlan) {
          say("agent", `${dto.pendingPlan.summary} Review the operations below.`);
        } else if (status === "failed") {
          const run = dto.agentRuns[0];
          say("agent", run?.error ? `I couldn't do that: ${run.error}` : "I couldn't derive any edits from that.");
        }
      } catch (error) {
        fail(error);
      } finally {
        setBusy(null);
      }
    },
    [project, fail, say],
  );

  const withProject = useCallback(
    async (label: string, fn: (id: string) => Promise<ProjectDTO>) => {
      if (!project) return;
      setBusy(label);
      try {
        setProject(await fn(project.id));
      } catch (error) {
        fail(error);
      } finally {
        setBusy(null);
      }
    },
    [project, fail],
  );

  const applyPlan = useCallback(async () => {
    await withProject("Applying edit…", apiApply);
    say("agent", "Applied. The edit is non-destructive — undo any time.");
  }, [withProject, say]);

  const discardPlan = useCallback(() => withProject("Discarding…", apiDiscard), [withProject]);
  const rejectOp = useCallback(
    (index: number) => withProject("Updating plan…", (id) => rejectOperation(id, index)),
    [withProject],
  );
  const undo = useCallback(() => withProject("Undoing…", apiUndo), [withProject]);
  const redo = useCallback(() => withProject("Redoing…", apiRedo), [withProject]);

  const previewOp = useCallback(
    async (index: number) => {
      if (!project) return;
      try {
        const result = await previewOperation(project.id, index);
        setPreviews((prev) => ({ ...prev, [index]: result }));
      } catch (error) {
        fail(error);
      }
    },
    [project, fail],
  );

  const runExport = useCallback(async () => {
    if (!project) return;
    setBusy("Rendering export…");
    try {
      const jobId = await startExport(project.id);
      const done = await waitForJob(jobId, setJob);
      if (done.status !== "succeeded") throw new Error(done.error ?? "Export failed");
      setProject(await getProject(project.id));
      say("agent", "Export complete — preview and download below.");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
      setJob(null);
    }
  }, [project, fail, say]);

  const removeProject = useCallback(
    async (id: string) => {
      try {
        await apiDelete(id);
        if (project?.id === id) closeProject();
        await refreshProjects();
      } catch (error) {
        fail(error);
      }
    },
    [project, closeProject, refreshProjects, fail],
  );

  return {
    projects,
    project,
    messages,
    busy,
    job,
    previews,
    refreshProjects,
    openProject,
    closeProject,
    importSample,
    importUpload,
    sendInstruction,
    applyPlan,
    discardPlan,
    rejectOp,
    previewOp,
    undo,
    redo,
    runExport,
    removeProject,
  };
}
