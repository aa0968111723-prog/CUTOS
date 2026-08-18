import type { EditImpact } from "./impact.js";

export interface VerifyInput {
  beforeDurationMs: number;
  afterDurationMs: number;
  impact: EditImpact;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}

/**
 * Post-execution verification: confirm the applied edit actually matches the
 * plan's intent (e.g. the timeline got shorter when content was removed, and is
 * not empty). This closes the observe→plan→execute→verify loop.
 */
export function verifyEdit(input: VerifyInput): VerifyResult {
  const checks: VerifyCheck[] = [];

  checks.push({
    name: "non-empty",
    ok: input.afterDurationMs > 0,
    detail: `Resulting duration is ${input.afterDurationMs}ms`,
  });

  if (input.impact.removedMs > input.impact.addedMs) {
    checks.push({
      name: "shortened",
      ok: input.afterDurationMs < input.beforeDurationMs,
      detail: `Duration ${input.beforeDurationMs}ms → ${input.afterDurationMs}ms`,
    });
  }

  const expected = input.impact.estimatedDurationMs;
  const drift = Math.abs(input.afterDurationMs - expected);
  checks.push({
    name: "duration-within-estimate",
    ok: drift <= Math.max(1500, expected * 0.05),
    detail: `Expected ~${expected}ms, got ${input.afterDurationMs}ms (drift ${drift}ms)`,
  });

  return { ok: checks.every((c) => c.ok), checks };
}
