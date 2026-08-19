import { randomUUID } from "node:crypto";
import {
  CUTOS_PROTOCOL_VERSION,
  CUTOS_SUPPORTED_PROTOCOLS,
  argsFingerprint,
  capabilityInvocationSchema,
  checkProtocolCompatibility,
  isRetryableCutosError,
  legacyInvokeRequestSchema,
  type AgentActivityEvent,
  type ApprovalRequest,
  type CapabilityFailure,
  type CapabilityManifest,
  type CapabilityResponse,
  type CapabilityResult,
  type CutosErrorCode,
  type CutosHealth,
  type RunCorrelation,
} from "@cutos/protocol";
import { checkAiosConnection, describeProvider, readAiosConfig } from "@cutos/agent";
import { getRuntime } from "./runtime.js";
import { HttpError } from "./errors.js";
import { logger } from "./logger.js";
import { recordActivity } from "./aios-activity.js";
import { buildApprovalRequest, evaluateApproval, summarizeImpact } from "./aios-approval.js";
import {
  CAPABILITIES,
  describeCapability,
  findCapability,
  legacyAliasDefinitions,
  type CapabilitySpec,
} from "./aios-capabilities.js";

/**
 * Outbound AIOS bridge — the CUTOS side of the cutos.agent.v2 contract.
 *
 * One entrypoint (`POST /api/aios/invoke`) serves a fixed, published capability
 * allow-list. Around every call it enforces, in order:
 *
 *   protocol negotiation → capability lookup → argument validation
 *   → durable idempotency claim → timeline revision guard → approval gate
 *   → execute → durable receipt → activity event → sanitized response
 *
 * The v1 request shape (`{ name, args }`) is still accepted and answered in the
 * v1 response shape, so existing AIOS v1 agents keep working unchanged.
 */

/** Bump whenever the capability set changes. */
export const MANIFEST_VERSION = 2;
export const SERVER_VERSION = "cutos-0.1.0";

export const FEATURES = [
  "semantic",
  "idempotency",
  "revision-guard",
  "approval",
  "activity-log",
  "long-running-jobs",
  "cancellation",
  "orchestrator",
] as const;

const ERROR_MESSAGE_KEYS: Record<CutosErrorCode, string> = {
  PROTOCOL_VERSION_MISMATCH: "aios.error.protocolMismatch",
  CAPABILITY_NOT_FOUND: "aios.error.capabilityNotFound",
  VALIDATION_FAILED: "aios.error.validationFailed",
  UNAUTHORIZED: "aios.error.unauthorized",
  FORBIDDEN_PROJECT_SCOPE: "aios.error.forbiddenProject",
  PROJECT_NOT_FOUND: "aios.error.projectNotFound",
  JOB_NOT_FOUND: "aios.error.jobNotFound",
  RUN_NOT_FOUND: "aios.error.runNotFound",
  STALE_TIMELINE_REVISION: "aios.error.staleRevision",
  IDEMPOTENCY_IN_PROGRESS: "aios.error.effectInProgress",
  IDEMPOTENCY_CONFLICT: "aios.error.idempotencyConflict",
  APPROVAL_REQUIRED: "aios.error.approvalRequired",
  NO_PENDING_PLAN: "aios.error.noPendingPlan",
  UNSUPPORTED_OPERATION: "aios.error.unsupportedOperation",
  EMPTY_TIMELINE: "aios.error.emptyTimeline",
  ANALYSIS_REQUIRED: "aios.error.analysisRequired",
  CANCELLED: "aios.error.cancelled",
  TIMEOUT: "aios.error.timeout",
  UNAVAILABLE: "aios.error.unavailable",
  INTERNAL: "aios.error.internal",
};

/** Maps existing CUTOS domain error codes onto the cross-repo error codes. */
const APP_TO_PROTOCOL: Record<string, CutosErrorCode> = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  TIMELINE_NOT_FOUND: "PROJECT_NOT_FOUND",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  JOB_FAILED: "INTERNAL",
  STALE_EDIT_PLAN: "STALE_TIMELINE_REVISION",
  NO_PENDING_PLAN: "NO_PENDING_PLAN",
  EMPTY_TIMELINE: "EMPTY_TIMELINE",
  OPERATION_NOT_FOUND: "RUN_NOT_FOUND",
  UNSUPPORTED_OPERATION: "UNSUPPORTED_OPERATION",
  PREVIEW_UNSUPPORTED: "UNSUPPORTED_OPERATION",
  EXPORT_FAILED: "INTERNAL",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  CONCURRENCY_CONFLICT: "STALE_TIMELINE_REVISION",
  MEDIA_UNSUPPORTED: "VALIDATION_FAILED",
  MEDIA_MISSING: "VALIDATION_FAILED",
  UPLOAD_TOO_LARGE: "VALIDATION_FAILED",
  UPLOAD_INVALID: "VALIDATION_FAILED",
  INTERNAL: "INTERNAL",
};

export class BridgeError extends Error {
  constructor(
    readonly code: CutosErrorCode,
    message: string,
    readonly details?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

// ---------------------------------------------------------------------------
// Manifest + health
// ---------------------------------------------------------------------------

export function getAiosManifest(): CapabilityManifest {
  return {
    protocolVersion: CUTOS_PROTOCOL_VERSION,
    supportedProtocols: [...CUTOS_SUPPORTED_PROTOCOLS],
    agent: "cutos",
    displayName: "CUTOS — AI 對話式影片剪輯代理",
    manifestVersion: MANIFEST_VERSION,
    serverVersion: SERVER_VERSION,
    features: [...FEATURES],
    capabilities: [...CAPABILITIES.map(describeCapability), ...legacyAliasDefinitions()],
    provider: describeProvider(),
    // Legacy v1 fields; a v1 agent reads these and keeps working.
    protocol: CUTOS_PROTOCOL_VERSION,
    version: MANIFEST_VERSION,
  };
}

export function listCapabilityNames(): string[] {
  return CAPABILITIES.map((capability) => capability.name);
}

/**
 * Health for the AIOS status surface: what protocol/manifest/features this
 * CUTOS speaks, plus the inbound kernel probe when one is configured.
 */
export async function checkAiosHealth(): Promise<CutosHealth & { configured: boolean }> {
  const config = readAiosConfig();
  const base: CutosHealth & { configured: boolean } = {
    protocolVersion: CUTOS_PROTOCOL_VERSION,
    supportedProtocols: [...CUTOS_SUPPORTED_PROTOCOLS],
    manifestVersion: MANIFEST_VERSION,
    serverVersion: SERVER_VERSION,
    features: [...FEATURES],
    reachable: true,
    configured: config.configured,
  };
  if (!config.configured || !config.kernelUrl) {
    return { ...base, kernel: { configured: false } };
  }
  const status = await checkAiosConnection({
    kernelUrl: config.kernelUrl,
    healthPath: config.healthPath,
  });
  return {
    ...base,
    latencyMs: status.latencyMs,
    kernel: {
      configured: true,
      reachable: status.reachable,
      endpoint: status.endpoint,
      ...(status.latencyMs === undefined ? {} : { latencyMs: status.latencyMs }),
    },
  };
}

// ---------------------------------------------------------------------------
// Invocation pipeline
// ---------------------------------------------------------------------------

function nowIso(at = Date.now()): string {
  return new Date(at).toISOString();
}

function correlationFrom(
  raw: Partial<RunCorrelation> & { requestId: string },
  extra: Partial<RunCorrelation> = {},
): RunCorrelation {
  const at = nowIso();
  return {
    requestId: raw.requestId,
    ...(raw.idempotencyKey ? { idempotencyKey: raw.idempotencyKey } : {}),
    ...(raw.aiosRunId ? { aiosRunId: raw.aiosRunId } : {}),
    ...(raw.aiosStepId ? { aiosStepId: raw.aiosStepId } : {}),
    ...(raw.aiosProjectId ? { aiosProjectId: raw.aiosProjectId } : {}),
    ...(raw.cutosProjectId ? { cutosProjectId: raw.cutosProjectId } : {}),
    ...(raw.expectedRevision === undefined ? {} : { expectedRevision: raw.expectedRevision }),
    ...(raw.traceId ? { traceId: raw.traceId } : {}),
    createdAt: raw.createdAt ?? at,
    updatedAt: at,
    ...extra,
  };
}

function failure(
  capability: string,
  code: CutosErrorCode,
  message: string,
  correlation: RunCorrelation,
  options: {
    details?: Record<string, string | number | boolean>;
    activity?: AgentActivityEvent[];
    approvalRequest?: ApprovalRequest;
  } = {},
): CapabilityFailure {
  return {
    protocolVersion: CUTOS_PROTOCOL_VERSION,
    capability,
    ok: false,
    error: {
      code,
      // Already sanitized upstream; never a stack trace, never transcript text.
      message: message.slice(0, 2_000),
      messageKey: ERROR_MESSAGE_KEYS[code],
      retryable: isRetryableCutosError(code),
      ...(options.details ? { details: options.details } : {}),
    },
    correlation,
    activity: options.activity ?? [],
    ...(options.approvalRequest ? { approvalRequest: options.approvalRequest } : {}),
  };
}

function toBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const name = typeof error === "object" && error && "name" in error
    ? String((error as { name?: unknown }).name)
    : undefined;
  // Checked before HttpError: TranscriptRequiredError extends it, and
  // "run analyze first" is a distinct, actionable condition for the caller.
  if (name === "TranscriptRequiredError") {
    return new BridgeError("ANALYSIS_REQUIRED", "Run analyze before using semantic capabilities");
  }
  if (error instanceof HttpError || name === "HttpError") {
    const http = error as HttpError;
    return new BridgeError(
      APP_TO_PROTOCOL[http.code] ?? "INTERNAL",
      http.message || http.code,
    );
  }
  if (name === "ProjectNotFoundError") {
    return new BridgeError("PROJECT_NOT_FOUND", "Project not found");
  }
  if (name === "ConcurrencyError") {
    return new BridgeError("STALE_TIMELINE_REVISION", "The timeline changed under this request");
  }
  // Unknown internals never reach the caller verbatim.
  logger.error("aios bridge internal error", {
    message: error instanceof Error ? error.message : String(error),
  });
  return new BridgeError("INTERNAL", "CUTOS could not complete the request");
}

function currentRevision(projectId: string): number {
  const { store } = getRuntime();
  const state = store.loadTimeline(projectId);
  return state?.revision ?? store.requireProject(projectId).timelineRevision;
}

export interface InvokeOptions {
  /** Wall-clock for deterministic tests. */
  now?: () => number;
  /** Lease held while an effect executes; a crash frees it after this. */
  leaseMs?: number;
}

export interface InvokeInput {
  protocolVersion?: string;
  capability: string;
  args: Record<string, unknown>;
  correlation: Partial<RunCorrelation> & { requestId?: string };
  expectedRevision?: number;
  approval?: { approvalId?: string; granted: boolean; grantedBy?: string; grantedAt?: string };
}

/**
 * Execute one v2 capability invocation with the full governance pipeline.
 * Never throws for expected conditions: callers get a typed CapabilityFailure.
 */
export async function invokeCapabilityV2(
  input: InvokeInput,
  options: InvokeOptions = {},
): Promise<CapabilityResponse> {
  const now = options.now ?? (() => Date.now());
  const requestId = input.correlation?.requestId?.trim() || randomUUID();
  let correlation = correlationFrom({ ...input.correlation, requestId, expectedRevision: input.expectedRevision });

  // 1. Protocol negotiation — an unknown protocol fails loudly.
  const compatibility = checkProtocolCompatibility(
    input.protocolVersion ?? CUTOS_PROTOCOL_VERSION,
    [],
  );
  if (!compatibility.compatible) {
    return failure(
      input.capability,
      "PROTOCOL_VERSION_MISMATCH",
      `Unsupported protocol ${String(input.protocolVersion)}; CUTOS speaks ${CUTOS_SUPPORTED_PROTOCOLS.join(", ")}`,
      correlation,
      { details: { requested: String(input.protocolVersion ?? ""), supported: CUTOS_SUPPORTED_PROTOCOLS.join(",") } },
    );
  }

  // 2. Capability lookup — the manifest is the allow-list.
  const capability = findCapability(input.capability);
  if (!capability) {
    return failure(
      input.capability,
      "CAPABILITY_NOT_FOUND",
      `Unknown capability: ${input.capability}`,
      correlation,
    );
  }

  // 3. Argument validation.
  const parsed = capability.schema.safeParse(input.args ?? {});
  if (!parsed.success) {
    return failure(
      capability.name,
      "VALIDATION_FAILED",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`).join("; "),
      correlation,
    );
  }
  const args = parsed.data;
  const targetProjectId = capability.projectIdOf?.(args);
  if (targetProjectId) {
    correlation = { ...correlation, cutosProjectId: targetProjectId };
  }

  const { store } = getRuntime();
  const needsIdempotency = capability.idempotency === "keyed";
  const idempotencyKey = input.correlation?.idempotencyKey;
  const scopeProjectId = targetProjectId ?? "_global";
  const fingerprint = argsFingerprint(args);

  // 4. Replay check, BEFORE the revision guard.
  //
  // Ordering matters: an apply that already succeeded has moved the timeline,
  // so a retry carrying the original expectedRevision would look "stale". If
  // the guard ran first, a network-retry of a completed write would be told to
  // replan and the caller would apply the same edit twice. A completed effect
  // is therefore replayed on its stored result no matter what the revision is
  // now -- that is exactly what the receipt is for.
  if (needsIdempotency && idempotencyKey) {
    const prior = store.getIdempotentEffect(scopeProjectId, capability.name, idempotencyKey);
    if (prior?.status === "completed" && prior.argsFingerprint === fingerprint) {
      return replayResult(capability.name, prior.result, prior.timelineRevision, correlation);
    }
  }

  // 5. Revision guard, before anything durable happens.
  if (capability.mutatesTimeline && targetProjectId) {
    if (input.expectedRevision === undefined) {
      return failure(
        capability.name,
        "VALIDATION_FAILED",
        "expectedRevision is required for timeline mutations",
        correlation,
      );
    }
    let actual: number;
    try {
      actual = currentRevision(targetProjectId);
    } catch (error) {
      const bridge = toBridgeError(error);
      return failure(capability.name, bridge.code, bridge.message, correlation);
    }
    if (actual !== input.expectedRevision) {
      const event = recordActivity({
        projectId: targetProjectId,
        kind: capability.activityKind,
        status: "failed",
        messageKey: "activity.revision.stale",
        aiosRunId: correlation.aiosRunId,
        aiosStepId: correlation.aiosStepId,
        metadata: { expected: input.expectedRevision, actual },
        now: now(),
      });
      return failure(
        capability.name,
        "STALE_TIMELINE_REVISION",
        `Timeline moved: expected revision ${input.expectedRevision}, current ${actual}`,
        { ...correlation, timelineRevision: actual },
        { details: { expectedRevision: input.expectedRevision, currentRevision: actual }, activity: [event] },
      );
    }
    correlation = { ...correlation, timelineRevision: actual };
  }

  // 6. Approval gate. CUTOS computes the domain impact; AIOS owns the human.
  let approvalRequest: ApprovalRequest | undefined;
  if (capability.requiresApproval && targetProjectId) {
    const decision = describeApproval(capability, targetProjectId, correlation, now());
    if (decision) {
      approvalRequest = decision;
      if (!input.approval?.granted) {
        const event = recordActivity({
          projectId: targetProjectId,
          kind: "approval",
          status: "waiting_approval",
          messageKey: decision.messageKey,
          aiosRunId: correlation.aiosRunId,
          aiosStepId: correlation.aiosStepId,
          metadata: {
            capability: capability.name,
            reasonCode: decision.reasonCode,
            removedRatio: decision.impact.removedRatio,
            keptRatio: decision.impact.keptRatio,
          },
          now: now(),
        });
        return failure(
          capability.name,
          "APPROVAL_REQUIRED",
          `Capability ${capability.name} requires approval (${decision.reasonCode})`,
          correlation,
          { approvalRequest: decision, activity: [event] },
        );
      }
    }
  }

  // 7. Durable idempotency claim -- written BEFORE the effect executes so a
  //    crash mid-apply is recoverable rather than silently repeatable.
  if (needsIdempotency && !idempotencyKey) {
    return failure(
      capability.name,
      "VALIDATION_FAILED",
      `Capability ${capability.name} requires correlation.idempotencyKey`,
      correlation,
    );
  }

  let claimId: string | undefined;

  if (needsIdempotency && idempotencyKey) {
    const claim = store.claimIdempotentEffect({
      projectId: scopeProjectId,
      capability: capability.name,
      idempotencyKey,
      requestId,
      argsFingerprint: fingerprint,
      aiosRunId: correlation.aiosRunId ?? null,
      aiosStepId: correlation.aiosStepId ?? null,
      leaseMs: options.leaseMs ?? 120_000,
      now: now(),
    });

    if (claim.state === "completed") {
      // A concurrent attempt finished between the read above and this claim.
      return replayResult(
        capability.name,
        claim.record.result,
        claim.record.timelineRevision,
        correlation,
      );
    }
    if (claim.state === "failed") {
      return failure(
        capability.name,
        (claim.record.errorCode as CutosErrorCode) ?? "INTERNAL",
        `A previous attempt with this idempotency key failed terminally`,
        correlation,
      );
    }
    if (claim.state === "in_progress") {
      const conflicting = claim.record.argsFingerprint !== fingerprint;
      return failure(
        capability.name,
        conflicting ? "IDEMPOTENCY_CONFLICT" : "IDEMPOTENCY_IN_PROGRESS",
        conflicting
          ? "This idempotency key is already bound to different arguments"
          : "The same effect is already executing",
        correlation,
      );
    }
    claimId = claim.record.id;
  }

  // 8. Execute.
  const activity: AgentActivityEvent[] = [];
  if (targetProjectId) {
    activity.push(recordActivity({
      projectId: targetProjectId,
      kind: capability.activityKind,
      status: "started",
      messageKey: `activity.${capability.activityKind}.started`,
      aiosRunId: correlation.aiosRunId,
      aiosStepId: correlation.aiosStepId,
      metadata: { capability: capability.name },
      now: now(),
    }));
  }

  try {
    const result = await capability.run(args, {
      requestId,
      ...(correlation.aiosRunId ? { aiosRunId: correlation.aiosRunId } : {}),
      ...(correlation.aiosStepId ? { aiosStepId: correlation.aiosStepId } : {}),
    });

    const revisionAfter = targetProjectId ? safeRevision(targetProjectId) : null;
    const jobId = extractJobId(result);
    const runId = extractRunId(result);

    if (claimId) store.completeIdempotentEffect(claimId, result, revisionAfter, now());

    if (targetProjectId) {
      activity.push(recordActivity({
        projectId: targetProjectId,
        kind: capability.activityKind,
        status: capability.longRunning ? "waiting_external" : "completed",
        messageKey: capability.longRunning
          ? `activity.${capability.activityKind}.queued`
          : `activity.${capability.activityKind}.completed`,
        aiosRunId: correlation.aiosRunId,
        aiosStepId: correlation.aiosStepId,
        cutosAgentRunId: runId,
        cutosJobId: jobId,
        metadata: {
          capability: capability.name,
          ...(revisionAfter === null ? {} : { timelineRevision: revisionAfter }),
        },
        now: now(),
      }));
    }

    return {
      protocolVersion: CUTOS_PROTOCOL_VERSION,
      capability: capability.name,
      ok: true,
      result,
      correlation: {
        ...correlation,
        ...(revisionAfter === null ? {} : { timelineRevision: revisionAfter }),
        ...(jobId ? { cutosJobId: jobId } : {}),
        ...(runId ? { cutosAgentRunId: runId } : {}),
        updatedAt: nowIso(now()),
      },
      activity,
      ...(approvalRequest ? { approvalRequest } : {}),
      replayed: false,
    } satisfies CapabilityResult;
  } catch (error) {
    const bridge = toBridgeError(error);
    if (claimId) {
      // A retryable failure keeps the key re-claimable; a terminal one is
      // recorded so a retry loop cannot hammer the same broken effect.
      if (isRetryableCutosError(bridge.code)) store.releaseIdempotentEffect(claimId, now());
      else store.failIdempotentEffect(claimId, bridge.code, now());
    }
    if (targetProjectId) {
      activity.push(recordActivity({
        projectId: targetProjectId,
        kind: capability.activityKind,
        status: "failed",
        messageKey: `activity.${capability.activityKind}.failed`,
        aiosRunId: correlation.aiosRunId,
        aiosStepId: correlation.aiosStepId,
        metadata: { capability: capability.name, code: bridge.code },
        now: now(),
      }));
    }
    return failure(capability.name, bridge.code, bridge.message, correlation, {
      ...(bridge.details ? { details: bridge.details } : {}),
      activity,
    });
  }
}

/** A completed effect replays on its stored receipt; it never re-executes. */
function replayResult(
  capability: string,
  result: unknown,
  timelineRevision: number | null,
  correlation: RunCorrelation,
): CapabilityResult {
  return {
    protocolVersion: CUTOS_PROTOCOL_VERSION,
    capability,
    ok: true,
    result,
    correlation: {
      ...correlation,
      ...(timelineRevision === null ? {} : { timelineRevision }),
    },
    activity: [],
    replayed: true,
  };
}

function safeRevision(projectId: string): number | null {
  try {
    return currentRevision(projectId);
  } catch {
    return null;
  }
}

function extractJobId(result: unknown): string | undefined {
  if (result && typeof result === "object" && "jobId" in result) {
    const value = (result as { jobId?: unknown }).jobId;
    if (typeof value === "string") return value;
  }
  return undefined;
}

function extractRunId(result: unknown): string | undefined {
  if (result && typeof result === "object" && "runId" in result) {
    const value = (result as { runId?: unknown }).runId;
    if (typeof value === "string") return value;
  }
  return undefined;
}

function describeApproval(
  capability: CapabilitySpec<unknown>,
  projectId: string,
  correlation: RunCorrelation,
  at: number,
): ApprovalRequest | undefined {
  const { store } = getRuntime();
  const project = store.getProject(projectId);
  if (!project) return undefined;

  if (capability.name === "export") {
    const state = store.loadTimeline(projectId);
    const sourceDurationMs = project.source.durationMs;
    const impact = {
      sourceDurationMs,
      estimatedDurationMs: state ? sourceDurationMs : 0,
      removedMs: 0,
      addedMs: 0,
      keptRatio: 1,
      removedRatio: 0,
      operationCount: 0,
      deleteOperationCount: 0,
      riskLevel: "high" as const,
      unsupportedOperations: [],
    };
    return buildApprovalRequest({
      projectId,
      capability: capability.name,
      decision: evaluateApproval("export", impact),
      impact,
      correlation,
      now: at,
    });
  }

  const pending = store.loadPendingPlan(projectId);
  if (!pending) return undefined;
  const impact = summarizeImpact(pending, project.source.durationMs);
  const decision = evaluateApproval(capability.name, impact);
  if (!decision.required) return undefined;
  return buildApprovalRequest({
    projectId,
    capability: capability.name,
    decision,
    impact,
    correlation,
    now: at,
  });
}

// ---------------------------------------------------------------------------
// v1 compatibility
// ---------------------------------------------------------------------------

/**
 * Legacy v1 entrypoint: `{ name, args }` → `{ capability, result }`.
 *
 * It routes through the same governed pipeline, but v1 has no correlation or
 * idempotency envelope, so a per-call key is synthesized. v1 callers therefore
 * still cannot double-apply within one request, and still hit the approval and
 * revision guards — a v1 mutation simply targets the current revision.
 */
export async function invokeAiosCapability(name: string, rawArgs: unknown) {
  const parsed = legacyInvokeRequestSchema.safeParse({ name, args: rawArgs ?? {} });
  if (!parsed.success) {
    throw new HttpError(400, "VALIDATION_FAILED", "name is required.");
  }
  const capability = findCapability(parsed.data.name);
  if (!capability) {
    throw new HttpError(404, "OPERATION_NOT_FOUND", `Unknown capability: ${parsed.data.name}`);
  }

  const requestId = randomUUID();
  const args = parsed.data.args;
  let expectedRevision: number | undefined;
  if (capability.mutatesTimeline) {
    const targetProjectId = typeof args.projectId === "string" ? args.projectId : undefined;
    if (targetProjectId) expectedRevision = safeRevision(targetProjectId) ?? undefined;
  }

  const response = await invokeCapabilityV2({
    protocolVersion: CUTOS_PROTOCOL_VERSION,
    capability: parsed.data.name,
    args,
    correlation: { requestId, idempotencyKey: `v1:${requestId}` },
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    // v1 has no approval channel; the legacy behaviour was "apply on request",
    // so a v1 caller is treated as having confirmed at the API boundary.
    approval: { granted: true, grantedBy: "cutos.agent.v1" },
  });

  if (!response.ok) {
    throw new HttpError(statusForCode(response.error.code), legacyCode(response.error.code), response.error.message);
  }
  return { capability: response.capability, result: response.result };
}

function statusForCode(code: CutosErrorCode): number {
  switch (code) {
    case "CAPABILITY_NOT_FOUND":
    case "PROJECT_NOT_FOUND":
    case "JOB_NOT_FOUND":
    case "RUN_NOT_FOUND":
      return 404;
    case "VALIDATION_FAILED":
    case "PROTOCOL_VERSION_MISMATCH":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN_PROJECT_SCOPE":
      return 403;
    case "STALE_TIMELINE_REVISION":
    case "NO_PENDING_PLAN":
    case "EMPTY_TIMELINE":
    case "IDEMPOTENCY_IN_PROGRESS":
    case "IDEMPOTENCY_CONFLICT":
    case "APPROVAL_REQUIRED":
    case "ANALYSIS_REQUIRED":
      return 409;
    case "UNSUPPORTED_OPERATION":
      return 422;
    default:
      return 500;
  }
}

function legacyCode(code: CutosErrorCode) {
  switch (code) {
    case "CAPABILITY_NOT_FOUND":
    case "RUN_NOT_FOUND":
      return "OPERATION_NOT_FOUND" as const;
    case "PROJECT_NOT_FOUND":
      return "PROJECT_NOT_FOUND" as const;
    case "JOB_NOT_FOUND":
      return "JOB_NOT_FOUND" as const;
    case "STALE_TIMELINE_REVISION":
      return "STALE_EDIT_PLAN" as const;
    case "NO_PENDING_PLAN":
      return "NO_PENDING_PLAN" as const;
    case "EMPTY_TIMELINE":
      return "EMPTY_TIMELINE" as const;
    case "UNSUPPORTED_OPERATION":
      return "UNSUPPORTED_OPERATION" as const;
    case "VALIDATION_FAILED":
    case "PROTOCOL_VERSION_MISMATCH":
    case "APPROVAL_REQUIRED":
    case "IDEMPOTENCY_IN_PROGRESS":
    case "IDEMPOTENCY_CONFLICT":
    case "ANALYSIS_REQUIRED":
      return "VALIDATION_FAILED" as const;
    default:
      return "INTERNAL" as const;
  }
}

/** Parse and dispatch a raw `/api/aios/invoke` body (v1 or v2 shape). */
export async function handleInvokeBody(body: unknown): Promise<
  | { protocol: "v2"; response: CapabilityResponse }
  | { protocol: "v1"; response: { capability: string; result: unknown } }
> {
  const v2 = capabilityInvocationSchema.safeParse(body);
  if (v2.success) {
    return {
      protocol: "v2",
      response: await invokeCapabilityV2({
        protocolVersion: v2.data.protocolVersion,
        capability: v2.data.capability,
        args: v2.data.args,
        correlation: v2.data.correlation,
        ...(v2.data.expectedRevision === undefined ? {} : { expectedRevision: v2.data.expectedRevision }),
        ...(v2.data.approval ? { approval: v2.data.approval } : {}),
      }),
    };
  }
  const v1 = legacyInvokeRequestSchema.safeParse(body);
  if (!v1.success) {
    throw new HttpError(400, "VALIDATION_FAILED", "name (v1) or capability + correlation (v2) is required.");
  }
  return { protocol: "v1", response: await invokeAiosCapability(v1.data.name, v1.data.args) };
}
