/**
 * Serializable DTOs shared between the API routes and the client UI. Plain data
 * only (no domain logic, no Node imports) so they are safe in client components.
 */
import type { PreviewManifest } from "@cutos/preview";

export type { PreviewManifest };

export interface OperationDTO {
  index: number;
  type: string;
  startMs?: number;
  endMs?: number;
  atMs?: number;
  speed?: number;
  reason?: string;
  confidence?: number;
  /** Estimated duration removed by this single operation (ms). */
  estimatedRemovedMs: number;
  /** Whether the timeline engine can currently apply this operation. */
  supported: boolean;
}

export interface ClipDTO {
  id: string;
  sourceInMs: number;
  sourceOutMs: number;
  speed: number;
  outputDurationMs: number;
}

export interface CaptionDTO {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface MarkerDTO {
  id: string;
  atMs: number;
  label: string;
}

export interface ImpactDTO {
  sourceDurationMs: number;
  estimatedDurationMs: number;
  removedMs: number;
  addedMs: number;
  operationCount: number;
  riskLevel: "low" | "medium" | "high";
  unsupportedOperations: string[];
}

export interface PendingPlanDTO {
  id: string;
  instruction: string;
  summary: string;
  provider: string;
  targetRevision?: number;
  stale: boolean;
  operations: OperationDTO[];
  impact: ImpactDTO;
  requiresApproval: boolean;
  approvalReason: string;
}

export interface SilenceDTO {
  startMs: number;
  endMs: number;
}

export interface AgentStepDTO {
  at: number;
  kind: string;
  title: string;
  detail?: string;
  data?: Record<string, string | number>;
}

export interface AgentRunDTO {
  id: string;
  input: string;
  status: string;
  createdAt: number;
  steps: AgentStepDTO[];
  summary: string | null;
  error: string | null;
}

export interface OperationLogDTO {
  id: string;
  at: number;
  revision: number;
  kind: string;
  summary: string | null;
  operationCount: number;
}

/**
 * Ingest state of a project's original media.
 *
 * `uploaded`/`probing` mean the bytes are safe but the metadata is not read
 * yet; `failed` means the media is stored and unreadable — retryable without
 * uploading again. The home screen renders these instead of blocking.
 */
export type MediaStatusDTO = "uploaded" | "probing" | "ready" | "failed";

export interface ProjectSummaryDTO {
  id: string;
  name: string;
  updatedAt: number;
  timelineRevision: number;
  durationMs: number;
  mediaStatus: MediaStatusDTO;
  /** App error code from the last failed probe, for the retry affordance. */
  mediaError: string | null;
}

export interface ProjectDTO {
  id: string;
  name: string;
  version: number;
  updatedAt: number;
  provider: string;
  mediaStatus: MediaStatusDTO;
  mediaError: string | null;
  timelineRevision: number;
  source: {
    durationMs: number;
    hasAudio: boolean;
    width: number | null;
    height: number | null;
  };
  analysis?: {
    silences: SilenceDTO[];
    hasWaveform: boolean;
    sentenceCount: number;
  };
  timeline: {
    durationMs: number;
    clips: ClipDTO[];
    captions: CaptionDTO[];
    markers: MarkerDTO[];
  };
  operationLog: OperationLogDTO[];
  canUndo: boolean;
  canRedo: boolean;
  pendingPlan?: PendingPlanDTO;
  agentRuns: AgentRunDTO[];
  hasExport: boolean;
  exportDurationMs?: number;
  /** Self-contained plan for playing the edited timeline in the browser. */
  preview: PreviewManifest;
  integration: IntegrationDTO;
}

export interface IntegrationDTO {
  provider: "local" | "openai" | "aios";
  providerName: string;
  aios: {
    configured: boolean;
    kernelUrl?: string;
    model: string;
    backend: string;
  };
}

/** Server-issued upload session. Carries no server path, by design. */
export interface UploadSessionDTO {
  uploadId: string;
  status: "pending" | "uploading" | "complete" | "finalized" | "aborted";
  filename: string;
  sizeBytes: number;
  receivedBytes: number;
  mimeType: string;
  /** Bytes per chunk; the server derives it from the deployment's limits. */
  chunkBytes: number;
  expiresAt: number;
  projectId: string | null;
  errorCode: string | null;
}

export interface UploadFinalizeDTO {
  projectId: string;
  created: boolean;
  probeJobId: string | null;
}

export interface UploadLimitsDTO {
  maxUploadBytes: number;
  maxRequestBytes: number;
  chunkBytes: number;
  allowedMimePrefixes: string[];
}
