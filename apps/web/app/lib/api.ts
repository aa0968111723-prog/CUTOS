import type { PreviewManifest, ProjectDTO, ProjectSummaryDTO } from "./types.js";

export interface ApiErrorBody {
  code?: string;
  message?: string;
}

/** Error carrying a stable app error code so the UI can render zh-TW copy. */
export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function parse<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & Partial<ApiErrorBody>;
  if (!res.ok) {
    const body = data as ApiErrorBody;
    throw new ApiRequestError(body.code ?? "UNKNOWN", body.message ?? res.statusText);
  }
  return data as T;
}

const jsonHeaders = { "content-type": "application/json" };

export async function createSampleProject(): Promise<ProjectDTO> {
  return parse(await fetch("/api/projects/sample", { method: "POST" }));
}

export async function uploadProject(file: File): Promise<ProjectDTO> {
  const form = new FormData();
  form.append("file", file);
  return parse(await fetch("/api/projects/upload", { method: "POST", body: form }));
}

export async function getProject(id: string): Promise<ProjectDTO> {
  return parse(await fetch(`/api/projects/${id}`, { cache: "no-store" }));
}

export async function listProjects(): Promise<ProjectSummaryDTO[]> {
  const { projects } = await parse<{ projects: ProjectSummaryDTO[] }>(
    await fetch("/api/projects", { cache: "no-store" }),
  );
  return projects;
}

export async function deleteProject(id: string): Promise<void> {
  await parse(await fetch(`/api/projects/${id}`, { method: "DELETE" }));
}

export interface JobDTO {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  stage: string | null;
  error: string | null;
}

export async function startAnalyze(
  id: string,
  opts?: { thresholdDb?: number; minSilenceMs?: number },
): Promise<string> {
  const { jobId } = await parse<{ jobId: string }>(
    await fetch(`/api/projects/${id}/analyze`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(opts ?? {}),
    }),
  );
  return jobId;
}

export async function startExport(id: string): Promise<string> {
  const { jobId } = await parse<{ jobId: string }>(
    await fetch(`/api/projects/${id}/export`, { method: "POST" }),
  );
  return jobId;
}

export async function getJob(id: string): Promise<JobDTO> {
  return parse(await fetch(`/api/jobs/${id}`, { cache: "no-store" }));
}

export async function requestPlan(
  id: string,
  instruction: string,
): Promise<{ runId: string; status: string; dto: ProjectDTO }> {
  return parse(
    await fetch(`/api/projects/${id}/plan`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ instruction }),
    }),
  );
}

export interface PreviewResult {
  opIndex: number;
  removedMs: number;
  estimatedDurationMs: number;
  riskLevel: string;
}

export async function previewOperation(id: string, opIndex: number): Promise<PreviewResult> {
  return parse(
    await fetch(`/api/projects/${id}/review/preview`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ opIndex }),
    }),
  );
}

export async function rejectOperation(id: string, opIndex: number): Promise<ProjectDTO> {
  return parse(
    await fetch(`/api/projects/${id}/review/reject`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ opIndex }),
    }),
  );
}

export async function previewOperationManifest(id: string, opIndex: number): Promise<PreviewManifest> {
  const { manifest } = await parse<{ manifest: PreviewManifest }>(
    await fetch(`/api/projects/${id}/preview/operation`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ opIndex }),
    }),
  );
  return manifest;
}

export interface AiosHealth {
  configured: boolean;
  /** cutos.agent.v2 fields; a v1 deployment simply omits them. */
  protocolVersion?: string;
  supportedProtocols?: string[];
  manifestVersion?: number;
  serverVersion?: string;
  features?: string[];
  reachable?: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
  /** Inbound AIOS kernel probe, when one is configured. */
  kernel?: {
    configured: boolean;
    reachable?: boolean;
    endpoint?: string;
    latencyMs?: number;
  };
}

export interface AiosActivityEvent {
  id: string;
  timestamp: string;
  projectId: string;
  kind: string;
  status: string;
  messageKey: string;
  metadata: Record<string, string | number | boolean>;
  aiosRunId?: string;
  cutosJobId?: string;
}

/** Replayable cross-system activity feed (the AI-OS control plane view). */
export async function fetchAiosActivity(
  projectId: string,
  afterSequence = 0,
): Promise<{ events: AiosActivityEvent[]; lastSequence: number }> {
  return parse(
    await fetch(
      `/api/aios/activity?projectId=${encodeURIComponent(projectId)}&afterSequence=${afterSequence}`,
      { cache: "no-store" },
    ),
  );
}

export async function checkAiosHealth(): Promise<AiosHealth> {
  return parse(await fetch("/api/aios/health", { cache: "no-store" }));
}

export async function previewPlanManifest(id: string): Promise<PreviewManifest> {
  const { manifest } = await parse<{ manifest: PreviewManifest }>(
    await fetch(`/api/projects/${id}/preview/plan`, { method: "POST" }),
  );
  return manifest;
}

async function post(id: string, action: string): Promise<ProjectDTO> {
  return parse(await fetch(`/api/projects/${id}/${action}`, { method: "POST" }));
}

export const applyPlan = (id: string) => post(id, "apply");
export const discardPlan = (id: string) => post(id, "discard");
export const undo = (id: string) => post(id, "undo");
export const redo = (id: string) => post(id, "redo");

/** Poll a job until it finishes, reporting progress. */
export async function waitForJob(
  jobId: string,
  onProgress?: (job: JobDTO) => void,
): Promise<JobDTO> {
  for (;;) {
    const job = await getJob(jobId);
    onProgress?.(job);
    if (job.status !== "running" && job.status !== "queued") return job;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
