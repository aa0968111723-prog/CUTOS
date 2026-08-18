/**
 * Serializable DTOs shared between the API routes and the client UI. These are
 * plain data (no domain logic, no Node imports) so they can be imported safely
 * into client components.
 */

export interface OperationDTO {
  type: string;
  startMs?: number;
  endMs?: number;
  atMs?: number;
  speed?: number;
  reason?: string;
}

export interface ClipDTO {
  id: string;
  sourceInMs: number;
  sourceOutMs: number;
  speed: number;
  outputDurationMs: number;
}

export interface AppliedPlanDTO {
  id: string;
  instruction: string;
  summary: string;
  provider: string;
  operationCount: number;
}

export interface PendingPlanDTO {
  id: string;
  instruction: string;
  summary: string;
  provider: string;
  operations: OperationDTO[];
}

export interface SilenceDTO {
  startMs: number;
  endMs: number;
}

export interface ProjectDTO {
  id: string;
  name: string;
  provider: string;
  source: {
    durationMs: number;
    hasAudio: boolean;
    width: number | null;
    height: number | null;
  };
  analysis?: {
    thresholdDb: number;
    minSilenceMs: number;
    silences: SilenceDTO[];
  };
  timeline: {
    durationMs: number;
    clips: ClipDTO[];
  };
  appliedPlans: AppliedPlanDTO[];
  canUndo: boolean;
  canRedo: boolean;
  pendingPlan?: PendingPlanDTO;
  output?: {
    durationMs: number;
  };
}
