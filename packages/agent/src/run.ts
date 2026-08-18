import type { ToolCallRecord } from "./tools.js";

export type AgentRunStatus =
  | "running"
  | "awaiting_approval"
  | "applied"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentStepKind =
  | "observe"
  | "context"
  | "tool_call"
  | "plan"
  | "validate"
  | "approval"
  | "execute"
  | "verify"
  | "summary"
  | "error";

/**
 * A single, user-presentable step in an agent run. This is the verifiable
 * activity surfaced to the UI ("analyzing video", "found 4 pauses", "creating
 * edit plan") — never hidden chain-of-thought.
 */
export interface AgentStep {
  at: number;
  kind: AgentStepKind;
  /** English label for logs/debug; the UI localizes by `kind`. */
  title: string;
  detail?: string;
  /** Structured, language-neutral data so the UI can compose localized copy. */
  data?: Record<string, number | string>;
  toolCallId?: string;
}

export interface AgentRun {
  id: string;
  projectId: string;
  input: string;
  status: AgentRunStatus;
  createdAt: number;
  updatedAt: number;
  steps: AgentStep[];
  toolCalls: ToolCallRecord[];
  planId: string | null;
  summary: string | null;
  error: string | null;
}

export interface AgentRunStore {
  save(run: AgentRun): void;
  get(id: string): AgentRun | undefined;
  listByProject(projectId: string): AgentRun[];
}

export class MemoryAgentRunStore implements AgentRunStore {
  private runs = new Map<string, AgentRun>();
  save(run: AgentRun): void {
    this.runs.set(run.id, structuredClone(run));
  }
  get(id: string): AgentRun | undefined {
    const r = this.runs.get(id);
    return r ? structuredClone(r) : undefined;
  }
  listByProject(projectId: string): AgentRun[] {
    return [...this.runs.values()]
      .filter((r) => r.projectId === projectId)
      .map((r) => structuredClone(r))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}
