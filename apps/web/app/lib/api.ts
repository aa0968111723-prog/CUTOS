import type {
  AgentTurnDTO,
  HealthDTO,
  PreviewManifest,
  ProjectDTO,
  ProjectSummaryDTO,
  ReadinessDTO,
  SuggestedActionDTO,
  VersionDTO,
} from "./types.js";

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

/**
 * Ask the server to read a project's media again.
 *
 * The counterpart to keeping the asset on a probe failure: recovering costs a
 * metadata read, not another upload.
 */
export async function retryMediaProbe(id: string): Promise<{ jobId: string }> {
  return parse(await fetch(`/api/projects/${id}/probe`, { method: "POST" }));
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

export interface PlanRequestBody {
  instruction: string;
  playheadMs?: number;
  selectedRange?: { startMs: number; endMs: number };
  previewMode?: "edited" | "original";
  timelineRevision?: number;
  action?: SuggestedActionDTO;
}

export async function requestPlan(
  id: string,
  instruction: string,
  playback?: Omit<PlanRequestBody, "instruction">,
): Promise<{ runId: string; status: string; dto: ProjectDTO; turn: AgentTurnDTO | null }> {
  return parse(
    await fetch(`/api/projects/${id}/plan`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ instruction, ...playback }),
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

/**
 * Poll a job until it finishes, reporting progress.
 *
 * Bounded on purpose: an unbounded poll is another way to leave the UI busy
 * forever if a worker dies without recording a terminal status.
 */
export async function waitForJob(
  jobId: string,
  onProgress?: (job: JobDTO) => void,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<JobDTO> {
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  for (;;) {
    if (options.signal?.aborted) throw new ApiRequestError("UPLOAD_CANCELLED", "cancelled");
    const job = await getJob(jobId);
    onProgress?.(job);
    if (job.status !== "running" && job.status !== "queued") return job;
    if (Date.now() >= deadline) {
      throw new ApiRequestError("JOB_FAILED", `job ${jobId} did not finish in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

// ---------------------------------------------------------------------------
// Deployment diagnostics
// ---------------------------------------------------------------------------

/**
 * Read the deployment's readiness.
 *
 * `parse` is bypassed on purpose: readiness answers 503 when the deployment is
 * broken, and that response carries exactly the diagnosis the UI needs to
 * show. Treating it as an error would throw away the payload and leave the user
 * with the generic "something went wrong" this repair exists to eliminate.
 */
export async function getReadiness(): Promise<ReadinessDTO> {
  const res = await fetch("/api/ready", { cache: "no-store" });
  const data = (await res.json().catch(() => null)) as ReadinessDTO | null;
  if (!data || typeof data.ready !== "boolean") {
    throw new ApiRequestError("INTERNAL", `Readiness check returned ${res.status}.`);
  }
  return data;
}

/** Full per-subsystem health report, for the 系統狀態 panel. */
export async function getHealth(): Promise<HealthDTO> {
  const res = await fetch("/api/health", { cache: "no-store" });
  const data = (await res.json().catch(() => null)) as HealthDTO | null;
  if (!data || !Array.isArray(data.checks)) {
    throw new ApiRequestError("INTERNAL", `Health check returned ${res.status}.`);
  }
  return data;
}

/** Which build is serving this page. */
export async function getVersion(): Promise<VersionDTO> {
  return parse(await fetch("/api/version", { cache: "no-store" }));
}
