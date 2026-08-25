import type { ProposedEdits } from "./types.js";
import type { VisualObservation } from "./chat-response.js";

const FROM_HERE_RE =
  /(?:好[，,、]?\s*)?(?:就)?從這(?:裡|邊|一幕|幕)?開始|(?:start(?:ing)?\s+from\s+(?:here|this)|trim\s+from\s+here)/i;
const KEEP_SCENE_RE = /(?:保留這一幕|留下這一幕|留這一幕|keep\s+this(?:\s+scene)?)/i;
const DELETE_THIS_RE = /(?:刪掉這一段|刪除這一段|刪掉這一幕|去掉這一段|delete\s+this)/i;

export interface GroundedEditInput {
  instruction: string;
  observation: VisualObservation;
  sourceDurationMs: number;
}

/**
 * Map a follow-up like "好，就從這裡開始" onto a real Edit DSL proposal using
 * the previous visual observation. The model is not asked to invent times, and
 * the result still goes through PlanGateway validation before review/apply.
 */
export function proposeGroundedEdit(input: GroundedEditInput): ProposedEdits | null {
  const { instruction, observation, sourceDurationMs } = input;
  const start = Math.max(0, Math.min(observation.startMs, sourceDurationMs));
  const end = Math.max(start, Math.min(observation.endMs, sourceDurationMs));
  const from = Math.max(0, Math.min(Math.round((observation.startMs + observation.endMs) / 2), sourceDurationMs));

  if (FROM_HERE_RE.test(instruction)) {
    const inMs = observation.frameRefs[Math.floor(observation.frameRefs.length / 2)] ?? from;
    const sourceIn = Math.max(0, Math.min(inMs, sourceDurationMs));
    if (sourceIn >= sourceDurationMs) return null;
    return {
      summary: `從 ${formatBrief(sourceIn)} 開始保留到片尾。`,
      operations: [
        {
          type: "trim",
          startMs: sourceIn,
          endMs: sourceDurationMs,
          reason: `依剛才看到的畫面，從 ${formatBrief(sourceIn)} 開始`,
          source: "agent",
        },
      ],
    };
  }

  if (KEEP_SCENE_RE.test(instruction)) {
    const keepStart = start;
    const keepEnd = Math.max(keepStart + 1, end);
    if (keepEnd > sourceDurationMs) return null;
    return {
      summary: `只保留 ${formatBrief(keepStart)}–${formatBrief(keepEnd)} 這一幕。`,
      operations: [
        {
          type: "trim",
          startMs: keepStart,
          endMs: keepEnd,
          reason: "保留剛才描述的這一幕",
          source: "agent",
        },
      ],
    };
  }

  if (DELETE_THIS_RE.test(instruction)) {
    const delEnd = Math.max(start + 1, end);
    return {
      summary: `刪除 ${formatBrief(start)}–${formatBrief(delEnd)}。`,
      operations: [
        {
          type: "removeRange",
          startMs: start,
          endMs: delEnd,
          reason: "刪除剛才描述的這一幕",
          source: "agent",
        },
      ],
    };
  }

  return null;
}

function formatBrief(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const tenths = Math.floor((ms % 1000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

/** Follow-ups that should bind to the last visual observation instead of re-planning. */
export function isGroundedFollowUp(instruction: string): boolean {
  return FROM_HERE_RE.test(instruction) || KEEP_SCENE_RE.test(instruction) || DELETE_THIS_RE.test(instruction);
}
