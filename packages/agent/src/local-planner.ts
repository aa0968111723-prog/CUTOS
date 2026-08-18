import { formatTimecode, msToSec } from "@cutos/edit-dsl";
import type { Planner, PlanRequest, ProposedEdits, SilenceInterval } from "./types.js";

const DURATION_RE =
  /(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds)/i;
const SPEED_MULTIPLIER_RE = /(\d+(?:\.\d+)?)\s*x/i;

function parseThresholdMs(instruction: string): number | null {
  const match = DURATION_RE.exec(instruction);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const value = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return unit.startsWith("ms") || unit.startsWith("milli")
    ? Math.round(value)
    : Math.round(value * 1000);
}

function parseSpeed(instruction: string): number | null {
  const text = instruction.toLowerCase();
  const multiplier = SPEED_MULTIPLIER_RE.exec(text);
  if (multiplier?.[1]) {
    return Number.parseFloat(multiplier[1]);
  }
  if (/\bdouble\b/.test(text)) return 2;
  if (/\bhalf\b|\bslow(?:er|\s*down)?\b/.test(text)) return 0.5;
  if (/\bspeed\s*up\b|\bfaster\b|\bspeed\b/.test(text)) return 1.5;
  return null;
}

function wantsPauseRemoval(instruction: string): boolean {
  return /\b(pause|pauses|silence|silences|silent|quiet|dead\s*air|gap|gaps)\b/i.test(
    instruction,
  );
}

/**
 * Deterministic, offline planner. It maps common editing intents onto the Edit
 * DSL using the analysis context (detected silences). Being deterministic makes
 * it ideal as a default provider: no API key required, fully replayable, and
 * easy to test. It implements the same {@link Planner} contract as any hosted
 * model adapter.
 */
export class LocalHeuristicPlanner implements Planner {
  readonly name = "local-heuristic";

  async propose(request: PlanRequest): Promise<ProposedEdits> {
    const operations: unknown[] = [];
    const summaries: string[] = [];

    if (wantsPauseRemoval(request.instruction)) {
      const thresholdMs = parseThresholdMs(request.instruction) ?? 0;
      const targets = request.silences.filter(
        (s) => s.endMs - s.startMs >= thresholdMs,
      );
      for (const silence of targets) {
        operations.push(buildRemoveRange(silence));
      }
      if (targets.length > 0) {
        const removedMs = targets.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
        summaries.push(
          `Remove ${targets.length} pause${targets.length === 1 ? "" : "s"} ` +
            `(${msToSec(removedMs).toFixed(1)}s total` +
            (thresholdMs > 0 ? `, longer than ${msToSec(thresholdMs).toFixed(1)}s` : "") +
            `).`,
        );
      } else {
        summaries.push("No pauses matched the requested threshold.");
      }
    }

    const speed = parseSpeed(request.instruction);
    if (speed !== null && speed !== 1) {
      operations.push({
        type: "setSpeed",
        startMs: 0,
        endMs: request.sourceDurationMs,
        speed,
        reason: `Set overall playback speed to ${speed}x`,
      });
      summaries.push(`Set playback speed to ${speed}x.`);
    }

    return {
      summary: summaries.join(" ") || "No actionable edits were derived from the request.",
      operations,
    };
  }
}

function buildRemoveRange(silence: SilenceInterval) {
  return {
    type: "removeRange",
    startMs: silence.startMs,
    endMs: silence.endMs,
    reason: `Silent pause ${formatTimecode(silence.startMs)}–${formatTimecode(silence.endMs)}`,
  };
}
