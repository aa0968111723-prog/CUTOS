"use client";

import { useCallback, useEffect, useState } from "react";
import type { PreviewManifest } from "@cutos/preview";
import {
  ApiRequestError,
  applyPlan as apiApply,
  createSampleProject,
  deleteProject as apiDelete,
  discardPlan as apiDiscard,
  getProject,
  listProjects,
  previewOperationManifest,
  redo as apiRedo,
  rejectOperation,
  requestPlan,
  startAnalyze,
  startExport,
  undo as apiUndo,
  uploadProject,
  waitForJob,
  type JobDTO,
} from "../lib/api.js";
import type { ProjectDTO, ProjectSummaryDTO } from "../lib/types.js";
import { errorMessage, t } from "../i18n/index.js";

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
  previewOverride: PreviewManifest | null;
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
  exitPreview: () => void;
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
  const [previewOverride, setPreviewOverride] = useState<PreviewManifest | null>(null);

  const say = useCallback((role: ChatMessage["role"], text: string) => {
    setMessages((prev) => [...prev, { role, text }]);
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      const text = error instanceof ApiRequestError ? errorMessage(error.code) : t("error.UNKNOWN");
      say("error", text);
    },
    [say],
  );

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
      setBusy(t("import.analyzing"));
      try {
        const jobId = await startAnalyze(id, { thresholdDb: -30, minSilenceMs: 700 });
        await waitForJob(jobId, setJob);
        const updated = await getProject(id);
        setProject(updated);
        const count = updated.analysis?.silences.length ?? 0;
        say("agent", count > 0 ? t("agent.foundPauses", { count }) : t("agent.noPauses"));
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
      setPreviewOverride(null);
      try {
        const created = await loader();
        setProject(created);
        say("agent", t("import.imported", { name: created.name }));
        await refreshProjects();
        await runAnalysis(created.id);
      } catch (error) {
        fail(error);
        setBusy(null);
      }
    },
    [fail, refreshProjects, runAnalysis, say],
  );

  const importSample = useCallback(
    () => startProject(createSampleProject, t("import.reading")),
    [startProject],
  );
  const importUpload = useCallback(
    (file: File) => startProject(() => uploadProject(file), t("import.uploading")),
    [startProject],
  );

  const openProject = useCallback(
    async (id: string) => {
      setBusy(t("import.loading"));
      setMessages([]);
      setPreviewOverride(null);
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
    setPreviewOverride(null);
  }, []);

  const sendInstruction = useCallback(
    async (text: string) => {
      if (!project || !text.trim()) return;
      say("user", text);
      setBusy(t("agent.planning"));
      setPreviewOverride(null);
      try {
        const { dto, status } = await requestPlan(project.id, text);
        setProject(dto);
        if (dto.pendingPlan) {
          say("agent", t("agent.reviewBelow", { summary: dto.pendingPlan.summary }));
        } else if (status === "failed") {
          const run = dto.agentRuns[0];
          say("agent", run?.error ? t("agent.cannotDo", { reason: run.error }) : t("agent.noEdits"));
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
      setPreviewOverride(null);
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
    await withProject(t("agent.planning"), apiApply);
    say("agent", t("agent.applied"));
  }, [withProject, say]);

  const discardPlan = useCallback(() => withProject(t("agent.planning"), apiDiscard), [withProject]);
  const rejectOp = useCallback(
    (index: number) => withProject(t("agent.planning"), (id) => rejectOperation(id, index)),
    [withProject],
  );
  const undo = useCallback(async () => {
    await withProject(t("timeline.undo"), apiUndo);
    say("agent", t("agent.reverted"));
  }, [withProject, say]);
  const redo = useCallback(() => withProject(t("timeline.redo"), apiRedo), [withProject]);

  const previewOp = useCallback(
    async (index: number) => {
      if (!project) return;
      try {
        setPreviewOverride(await previewOperationManifest(project.id, index));
      } catch (error) {
        fail(error);
      }
    },
    [project, fail],
  );

  const exitPreview = useCallback(() => setPreviewOverride(null), []);

  const runExport = useCallback(async () => {
    if (!project) return;
    setBusy(t("export.rendering"));
    try {
      const jobId = await startExport(project.id);
      const done = await waitForJob(jobId, setJob);
      if (done.status !== "succeeded") throw new ApiRequestError("EXPORT_FAILED", "export failed");
      setProject(await getProject(project.id));
      say("agent", t("agent.exported"));
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
    previewOverride,
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
    exitPreview,
    undo,
    redo,
    runExport,
    removeProject,
  };
}
