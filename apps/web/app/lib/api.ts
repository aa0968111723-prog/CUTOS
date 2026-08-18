import type { ProjectDTO } from "./types.js";

export interface ApiError {
  error: string;
  issues?: string[];
}

async function parse<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & Partial<ApiError>;
  if (!res.ok) {
    const err = data as ApiError;
    const detail = err.issues?.length ? `: ${err.issues.join("; ")}` : "";
    throw new Error(`${err.error ?? res.statusText}${detail}`);
  }
  return data as T;
}

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

interface JobResponse {
  jobId: string;
}

export interface JobRecord {
  id: string;
  kind: string;
  status: "running" | "succeeded" | "failed";
  error?: string;
}

export async function startAnalyze(
  id: string,
  opts?: { thresholdDb?: number; minSilenceMs?: number },
): Promise<string> {
  const { jobId } = await parse<JobResponse>(
    await fetch(`/api/projects/${id}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts ?? {}),
    }),
  );
  return jobId;
}

export async function startExport(id: string): Promise<string> {
  const { jobId } = await parse<JobResponse>(
    await fetch(`/api/projects/${id}/export`, { method: "POST" }),
  );
  return jobId;
}

export async function getJob(id: string): Promise<JobRecord> {
  return parse(await fetch(`/api/jobs/${id}`, { cache: "no-store" }));
}

export async function requestPlan(id: string, instruction: string): Promise<ProjectDTO> {
  return parse(
    await fetch(`/api/projects/${id}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction }),
    }),
  );
}

async function post(id: string, action: string): Promise<ProjectDTO> {
  return parse(await fetch(`/api/projects/${id}/${action}`, { method: "POST" }));
}

export const applyPlan = (id: string) => post(id, "apply");
export const discardPlan = (id: string) => post(id, "discard");
export const undo = (id: string) => post(id, "undo");
export const redo = (id: string) => post(id, "redo");

/** Poll a job until it finishes. */
export async function waitForJob(jobId: string, signal?: AbortSignal): Promise<JobRecord> {
  for (;;) {
    if (signal?.aborted) throw new Error("cancelled");
    const job = await getJob(jobId);
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
