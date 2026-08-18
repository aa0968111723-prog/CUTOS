import type { PlanRequest } from "./types.js";

/**
 * Shared, provider-agnostic planning prompt. Used by every hosted-model adapter
 * (OpenAI-compatible, AIOS) so the contract is identical regardless of backend.
 * The gateway still validates all output against the Edit DSL before it can
 * touch project state.
 */
export const PLANNING_SYSTEM_PROMPT = `You are the planning engine for CUTOS, an agent-first video editor.
Convert the user's request into non-destructive timeline edit operations.
Respond with ONLY a JSON object: {"summary": string, "operations": Operation[]}.
Operation is one of:
  {"type":"removeRange","startMs":int,"endMs":int,"reason"?:string}
  {"type":"trim","startMs":int,"endMs":int,"reason"?:string}
  {"type":"split","atMs":int,"reason"?:string}
  {"type":"setSpeed","startMs":int,"endMs":int,"speed":number,"reason"?:string}
  {"type":"caption","startMs":int,"endMs":int,"text":string}
  {"type":"marker","atMs":int,"label":string}
Rules:
- All times are integer milliseconds in the ORIGINAL source; never exceed sourceDurationMs.
- Use the provided detected silence intervals when removing pauses.
- If the user's instruction is in Chinese, write "summary" and each "reason" in Traditional Chinese (zh-TW).
- Output JSON only, no prose outside the JSON object.`;

export function buildPlanningUserContent(request: PlanRequest): string {
  return JSON.stringify({
    instruction: request.instruction,
    sourceDurationMs: request.sourceDurationMs,
    silences: request.silences,
  });
}

export interface RawProposedEdits {
  summary?: unknown;
  operations?: unknown;
}

/** Normalize a model's JSON output into the ProposedEdits shape. */
export function parseProposedEdits(json: string): { summary: string; operations: unknown[] } {
  const parsed = JSON.parse(json) as RawProposedEdits;
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "Proposed edits",
    operations: Array.isArray(parsed.operations) ? parsed.operations : [],
  };
}
