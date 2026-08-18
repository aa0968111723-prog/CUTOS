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

export interface ProjectSummaryDTO {
  id: string;
  name: string;
  updatedAt: number;
  timelineRevision: number;
  durationMs: number;
}

export interface ProjectDTO {
  id: string;
  name: string;
  version: number;
  updatedAt: number;
  provider: string;
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
}
