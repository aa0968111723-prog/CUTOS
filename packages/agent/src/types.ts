export interface SilenceInterval {
  startMs: number;
  endMs: number;
}

/** Everything an agent needs to turn a natural-language request into a plan. */
export interface PlanRequest {
  instruction: string;
  sourceDurationMs: number;
  silences: SilenceInterval[];
}

/**
 * A provider proposes only operations + a summary. The gateway is responsible
 * for wrapping them in a versioned Edit Plan envelope and validating them
 * before they can affect project state. This keeps model output untrusted and
 * keeps CUTOS decoupled from any specific LLM vendor.
 */
export interface ProposedEdits {
  summary: string;
  operations: unknown[];
}

export interface Planner {
  readonly name: string;
  propose(request: PlanRequest): Promise<ProposedEdits>;
}
