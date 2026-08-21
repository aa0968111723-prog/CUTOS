"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  retryMediaProbe,
  startAnalyze,
  startExport,
  undo as apiUndo,
  waitForJob,
  type JobDTO,
} from "../lib/api.js";
import {
  IDLE_UPLOAD_STATE,
  ingestVideo,
  waitForMedia,
  type UploadState,
} from "../lib/upload.js";
import { shouldPollMedia } from "../lib/media-status.js";
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
  /** The upload state machine. Replaces the old single `busy` string. */
  upload: UploadState;
  previewOverride: PreviewManifest | null;
  refreshProjects: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => void;
  importSample: () => Promise<void>;
  startUpload: (file: File) => Promise<void>;
  cancelUpload: () => void;
  /** Clear a finished/failed upload so the picker is usable again. */
  resetUpload: () => void;
  /** Re-read media metadata without asking for the file again. */
  retryProbe: (projectId: string) => Promise<void>;
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

/**
 * Where an in-flight upload is remembered across a page freeze.
 *
 * Mobile browsers discard backgrounded tabs. The File handle cannot survive
 * that, but the server-side session can: if every byte had already landed, the
 * returning page finalizes it and the user gets their project instead of being
 * told to upload 300 MB again.
 */
const PENDING_UPLOAD_KEY = "cutos.pendingUpload";

interface PendingUpload {
  uploadId: string;
  projectId: string | null;
  fileName: string;
}

function readPending(): PendingUpload | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(PENDING_UPLOAD_KEY);
    return raw ? (JSON.parse(raw) as PendingUpload) : null;
  } catch {
    return null;
  }
}

function writePending(value: PendingUpload | null): void {
  try {
    if (value) globalThis.sessionStorage?.setItem(PENDING_UPLOAD_KEY, JSON.stringify(value));
    else globalThis.sessionStorage?.removeItem(PENDING_UPLOAD_KEY);
  } catch {
    // Private mode / disabled storage: recovery is a bonus, never a requirement.
  }
}

export function useEditor(): Editor {
  const [projects, setProjects] = useState<ProjectSummaryDTO[]>([]);
  const [project, setProject] = useState<ProjectDTO | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [job, setJob] = useState<JobDTO | null>(null);
  const [upload, setUpload] = useState<UploadState>(IDLE_UPLOAD_STATE);
  const [previewOverride, setPreviewOverride] = useState<PreviewManifest | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);

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

  /**
   * Analysis runs in the background.
   *
   * It deliberately does NOT set `busy`: the project is usable the moment its
   * media is readable, and blocking the whole UI on silence detection is how
   * "processing" turned into "stuck" in the first place. Progress shows in the
   * job indicator instead.
   */
  const runAnalysis = useCallback(
    async (id: string) => {
      try {
        const jobId = await startAnalyze(id, { thresholdDb: -30, minSilenceMs: 700 });
        await waitForJob(jobId, setJob);
        const updated = await getProject(id);
        setProject((current) => (current?.id === id ? updated : current));
        const count = updated.analysis?.silences.length ?? 0;
        say("agent", count > 0 ? t("agent.foundPauses", { count }) : t("agent.noPauses"));
      } catch (error) {
        fail(error);
      } finally {
        setJob(null);
      }
    },
    [fail, say],
  );

  /** Open the freshly-ingested project and start analysis behind it. */
  const enterProject = useCallback(
    async (projectId: string) => {
      const created = await getProject(projectId);
      setProject(created);
      // The upload is over; clear its card so returning to the import view does
      // not show a stale "已就緒" for a project the user is already inside.
      setUpload(IDLE_UPLOAD_STATE);
      say("agent", t("import.imported", { name: created.name }));
      await refreshProjects();
      void runAnalysis(created.id);
    },
    [refreshProjects, runAnalysis, say],
  );

  const importSample = useCallback(async () => {
    setBusy(t("import.reading"));
    setMessages([]);
    setPreviewOverride(null);
    try {
      const created = await createSampleProject();
      setProject(created);
      say("agent", t("import.imported", { name: created.name }));
      await refreshProjects();
      void runAnalysis(created.id);
    } catch (error) {
      fail(error);
    } finally {
      // Unconditional: every exit from this call clears the busy flag.
      setBusy(null);
    }
  }, [fail, refreshProjects, runAnalysis, say]);

  const startUpload = useCallback(
    async (file: File) => {
      uploadAbort.current?.abort();
      const controller = new AbortController();
      uploadAbort.current = controller;
      setMessages([]);
      setPreviewOverride(null);

      let final: UploadState;
      try {
        final = await ingestVideo(file, {
          signal: controller.signal,
          onState: (state) => {
            setUpload(state);
            if (state.uploadId) {
              writePending({
                uploadId: state.uploadId,
                projectId: state.projectId,
                fileName: state.fileName,
              });
            }
          },
        });
      } finally {
        // `ingestVideo` resolves rather than throws for every expected outcome,
        // but the ref is cleared here regardless so a thrown bug cannot leave
        // the UI believing an upload is still running.
        if (uploadAbort.current === controller) uploadAbort.current = null;
      }

      if (final.phase === "ready" && final.projectId) {
        writePending(null);
        await enterProject(final.projectId);
        return;
      }
      if (final.phase === "cancelled") {
        writePending(null);
        setUpload(IDLE_UPLOAD_STATE);
        return;
      }
      // Failed. If the bytes made it, the project exists and is recoverable;
      // show it rather than pretending the upload was lost.
      say("error", errorMessage(final.errorCode ?? "UNKNOWN"));
      await refreshProjects();
      if (final.projectId) writePending(null);
    },
    [enterProject, refreshProjects, say],
  );

  const cancelUpload = useCallback(() => {
    uploadAbort.current?.abort();
  }, []);

  const resetUpload = useCallback(() => {
    writePending(null);
    setUpload(IDLE_UPLOAD_STATE);
  }, []);

  const retryProbe = useCallback(
    async (projectId: string) => {
      setUpload((prev) => ({ ...prev, phase: "probing", errorCode: null, projectId }));
      try {
        await retryMediaProbe(projectId);
        const updated = await waitForMedia(projectId);
        setProject((current) => (current?.id === projectId ? updated : current));
        await refreshProjects();
        if (updated.mediaStatus === "failed") {
          setUpload((prev) => ({
            ...prev,
            phase: "failed",
            errorCode: updated.mediaError ?? "PROBE_FAILED",
            canRetryProbe: true,
          }));
          say("error", errorMessage(updated.mediaError ?? "PROBE_FAILED"));
          return;
        }
        setUpload((prev) => ({ ...prev, phase: "ready", errorCode: null, canRetryProbe: false }));
        await enterProject(projectId);
      } catch (error) {
        const code = error instanceof ApiRequestError ? error.code : "PROBE_FAILED";
        setUpload((prev) => ({ ...prev, phase: "failed", errorCode: code, canRetryProbe: true }));
        say("error", errorMessage(code));
      }
    },
    [enterProject, refreshProjects, say],
  );

  /**
   * Recover an upload the browser interrupted (backgrounded tab, reload).
   *
   * Runs once on mount. It never blocks the UI: the picker stays usable while
   * this resolves.
   */
  useEffect(() => {
    const pending = readPending();
    if (!pending) return;
    let cancelled = false;
    void (async () => {
      try {
        if (pending.projectId) {
          const recovered = await waitForMedia(pending.projectId);
          if (cancelled) return;
          writePending(null);
          if (recovered.mediaStatus === "ready") await enterProject(pending.projectId);
          return;
        }
        const response = await fetch(`/api/uploads/${pending.uploadId}`, { cache: "no-store" });
        if (!response.ok) {
          writePending(null);
          return;
        }
        const session = (await response.json()) as { status: string; projectId: string | null };
        if (cancelled) return;
        if (session.status === "finalized" && session.projectId) {
          writePending(null);
          await enterProject(session.projectId);
          return;
        }
        if (session.status === "complete") {
          // Every byte arrived before the page died: finish the job for them.
          const finalized = await fetch(`/api/uploads/${pending.uploadId}/finalize`, {
            method: "POST",
          });
          if (finalized.ok) {
            const { projectId } = (await finalized.json()) as { projectId: string };
            writePending(null);
            if (!cancelled) await enterProject(projectId);
            return;
          }
        }
        // Partly uploaded with no File handle left: say so and let them
        // re-pick, rather than showing a spinner for an upload that is over.
        writePending(null);
        setUpload({
          ...IDLE_UPLOAD_STATE,
          phase: "failed",
          fileName: pending.fileName,
          errorCode: "UPLOAD_INTERRUPTED",
        });
      } catch {
        writePending(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enterProject]);

  /**
   * Keep an open project fresh while its media is still being read.
   *
   * `openProject` fetches once. Without this, opening a project mid-probe
   * showed a processing state that never changed — the probe would finish
   * seconds later and the user would still be looking at "處理中", with no way
   * into their own project short of navigating away and back.
   */
  useEffect(() => {
    const id = project?.id;
    if (!id || !shouldPollMedia(project?.mediaStatus)) return;
    let cancelled = false;
    // Bounded: if the server never resolves the probe, stop asking rather than
    // polling forever. The banner's re-probe button stays as the way out.
    const deadline = Date.now() + 3 * 60_000;
    const timer = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        return;
      }
      try {
        const fresh = await getProject(id);
        if (cancelled) return;
        // Only replace the project the user is actually looking at.
        setProject((current) => (current?.id === id ? fresh : current));
      } catch {
        // A transient failure is not worth a message; the next tick retries.
      }
    }, 1_500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [project?.id, project?.mediaStatus]);

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
    upload,
    previewOverride,
    refreshProjects,
    openProject,
    closeProject,
    importSample,
    startUpload,
    cancelUpload,
    resetUpload,
    retryProbe,
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
