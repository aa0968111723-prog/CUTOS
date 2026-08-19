import { randomUUID } from "node:crypto";
import {
  activityEventSchema,
  type ActivityKind,
  type ActivityStatus,
  type AgentActivityEvent,
} from "@cutos/protocol";
import { getRuntime } from "./runtime.js";

/**
 * Durable, sanitized activity log shared with AIOS.
 *
 * Every entry is a real thing that happened (a job started, a search returned
 * N ranges, an approval was requested) keyed by a stable `messageKey` the UI
 * renders in zh-TW. Two hard rules, enforced here rather than trusted to
 * callers:
 *   - metadata is scalars only, so transcript text can never leak into a log,
 *   - nothing resembling model reasoning is accepted; there is no free-text field.
 */
const MAX_METADATA_ENTRIES = 16;
const MAX_STRING_METADATA = 120;

export type ActivityMetadata = Record<string, string | number | boolean>;

function sanitizeMetadata(metadata: ActivityMetadata | undefined): ActivityMetadata {
  if (!metadata) return {};
  const out: ActivityMetadata = {};
  for (const [key, value] of Object.entries(metadata).slice(0, MAX_METADATA_ENTRIES)) {
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      // Bounded: identifiers and stable codes are fine, prose is truncated.
      out[key] = value.length > MAX_STRING_METADATA
        ? `${value.slice(0, MAX_STRING_METADATA - 1)}…`
        : value;
    }
  }
  return out;
}

export interface RecordActivityInput {
  projectId: string;
  kind: ActivityKind;
  status: ActivityStatus;
  messageKey: string;
  aiosRunId?: string | null;
  aiosStepId?: string | null;
  cutosAgentRunId?: string | null;
  cutosJobId?: string | null;
  metadata?: ActivityMetadata;
  now?: number;
}

/** Append one event and return the protocol-shaped payload for the response. */
export function recordActivity(input: RecordActivityInput): AgentActivityEvent {
  const { store } = getRuntime();
  const at = input.now ?? Date.now();
  const record = store.appendActivity({
    id: randomUUID(),
    projectId: input.projectId,
    at,
    kind: input.kind,
    status: input.status,
    messageKey: input.messageKey,
    aiosRunId: input.aiosRunId ?? null,
    aiosStepId: input.aiosStepId ?? null,
    cutosAgentRunId: input.cutosAgentRunId ?? null,
    cutosJobId: input.cutosJobId ?? null,
    metadata: sanitizeMetadata(input.metadata),
  });
  return toProtocolEvent(record);
}

export function toProtocolEvent(record: {
  id: string;
  projectId: string;
  at: number;
  kind: string;
  status: string;
  messageKey: string;
  aiosRunId: string | null;
  aiosStepId: string | null;
  cutosAgentRunId: string | null;
  cutosJobId: string | null;
  metadata: ActivityMetadata;
}): AgentActivityEvent {
  return activityEventSchema.parse({
    id: record.id,
    timestamp: new Date(record.at).toISOString(),
    projectId: record.projectId,
    kind: record.kind,
    status: record.status,
    messageKey: record.messageKey,
    ...(record.aiosRunId ? { aiosRunId: record.aiosRunId } : {}),
    ...(record.aiosStepId ? { aiosStepId: record.aiosStepId } : {}),
    ...(record.cutosAgentRunId ? { cutosAgentRunId: record.cutosAgentRunId } : {}),
    ...(record.cutosJobId ? { cutosJobId: record.cutosJobId } : {}),
    metadata: record.metadata,
  });
}

/** Replay the durable log — used by the AIOS UI and by restart recovery. */
export function listActivity(
  projectId: string,
  options: { afterSequence?: number; limit?: number } = {},
): { events: AgentActivityEvent[]; lastSequence: number } {
  const { store } = getRuntime();
  const records = store.listActivity(projectId, options);
  return {
    events: records.map(toProtocolEvent),
    lastSequence: records.at(-1)?.sequence ?? options.afterSequence ?? 0,
  };
}
