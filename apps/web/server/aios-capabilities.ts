import { z } from "zod";
import type {
  CapabilityAccess,
  CapabilityDefinition,
  CapabilityIdempotency,
  CapabilityParam,
  CapabilityRisk,
} from "@cutos/protocol";
import * as service from "./editor-service.js";
import * as semantic from "./semantic-service.js";
import type { ActivityKind } from "@cutos/protocol";

/**
 * The cutos.agent.v2 capability registry.
 *
 * Every capability is a typed, permission-tagged, individually-registered unit.
 * There is deliberately no generic `invoke(name, args)` escape hatch exposed to
 * an agent: the manifest IS the allow-list, and anything not in it cannot be
 * reached. Media is only ever addressed by `projectId` — no capability accepts
 * a filesystem path, a URL, or a shell fragment.
 */

export interface CapabilityContext {
  requestId: string;
  aiosRunId?: string;
  aiosStepId?: string;
}

export interface CapabilitySpec<TArgs = unknown> {
  name: string;
  version: number;
  /** zh-TW first, English second. Both UIs render zh-TW. */
  description: string;
  access: CapabilityAccess;
  risk: CapabilityRisk;
  idempotency: CapabilityIdempotency;
  requiresApproval: boolean;
  longRunning: boolean;
  mutatesTimeline: boolean;
  timeoutHintMs: number;
  schema: z.ZodType<TArgs>;
  /** Structural JSON-Schema-ish descriptor published in the manifest. */
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  params: CapabilityParam[];
  /** Activity kind emitted around this capability. */
  activityKind: ActivityKind;
  /** Extracts the project this call targets (for scoping + activity). */
  projectIdOf?: (args: TArgs) => string | undefined;
  run: (args: TArgs, context: CapabilityContext) => Promise<unknown> | unknown;
}

const projectId = z.string().min(1).max(200);
const timeMs = z.number().int().nonnegative().max(24 * 60 * 60 * 1000);

function spec<TArgs>(value: CapabilitySpec<TArgs>): CapabilitySpec<unknown> {
  return value as unknown as CapabilitySpec<unknown>;
}

const P = {
  project: { name: "projectId", type: "string", required: true, description: "CUTOS 專案 ID" },
  query: { name: "query", type: "string", required: true, description: "查詢字串（支援繁體中文）" },
  limit: { name: "limit", type: "number", required: false },
} satisfies Record<string, CapabilityParam>;

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const str = { type: "string" };
const num = { type: "number" };
const bool = { type: "boolean" };
const arr = (items: unknown) => ({ type: "array", items });

const searchArgs = z.object({
  projectId,
  query: z.string().min(1).max(500),
  limit: z.number().int().positive().max(100).optional(),
  speaker: z.string().min(1).max(200).optional(),
  startMs: timeMs.optional(),
  endMs: timeMs.optional(),
});

const searchOutput = objectSchema({
  hits: arr(objectSchema({
    sentenceId: str, startMs: num, endMs: num, speaker: str, text: str, score: num,
  })),
  timelineRevision: num,
});

export const CAPABILITIES: CapabilitySpec<unknown>[] = [
  // ---------------------------------------------------------------- read ---
  spec({
    name: "list_projects",
    version: 2,
    description: "列出所有專案。List all projects.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 5_000,
    schema: z.object({}).strip(),
    inputSchema: objectSchema({}),
    outputSchema: arr(objectSchema({ id: str, name: str, durationMs: num, timelineRevision: num })),
    params: [],
    activityKind: "run",
    run: () => service.listProjects(),
  }),
  spec({
    name: "get_project",
    version: 2,
    description: "取得專案狀態（含時間軸與預覽 manifest）。Get full project state.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 8_000,
    schema: z.object({ projectId }),
    inputSchema: objectSchema({ projectId: str }, ["projectId"]),
    outputSchema: objectSchema({ id: str, timelineRevision: num, timeline: { type: "object" } }),
    params: [P.project],
    activityKind: "run",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string }) => service.getProject(a.projectId),
  }),
  spec({
    name: "get_transcript",
    version: 2,
    description: "取得逐字稿（分頁）。Get the transcript, paged.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 8_000,
    schema: z.object({
      projectId,
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    inputSchema: objectSchema({ projectId: str, offset: num, limit: num }, ["projectId"]),
    outputSchema: objectSchema({
      language: str, total: num, offset: num, truncated: bool,
      sentences: arr(objectSchema({ id: str, startMs: num, endMs: num, speaker: str, text: str })),
    }),
    params: [P.project, { name: "offset", type: "number", required: false }, P.limit],
    activityKind: "transcript",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string; offset?: number; limit?: number }) =>
      semantic.getTranscript(a.projectId, { offset: a.offset, limit: a.limit }),
  }),
  spec({
    name: "search_transcript",
    version: 2,
    description: "在逐字稿中做字面搜尋。Literal substring search over the transcript.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 8_000,
    schema: searchArgs,
    inputSchema: objectSchema(
      { projectId: str, query: str, limit: num, speaker: str, startMs: num, endMs: num },
      ["projectId", "query"],
    ),
    outputSchema: searchOutput,
    params: [P.project, P.query, P.limit],
    activityKind: "semantic_search",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: semantic.SearchArgs) => semantic.searchTranscriptLiteral(a),
  }),
  spec({
    name: "search_semantic",
    version: 2,
    description: "語意搜尋：找出談到某個主題的片段（不需字面相同）。Semantic retrieval over the transcript.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 10_000,
    schema: searchArgs,
    inputSchema: objectSchema(
      { projectId: str, query: str, limit: num, speaker: str, startMs: num, endMs: num },
      ["projectId", "query"],
    ),
    outputSchema: searchOutput,
    params: [P.project, P.query, P.limit],
    activityKind: "semantic_search",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: semantic.SearchArgs) => semantic.searchSemanticRanges(a),
  }),
  spec({
    name: "list_speakers",
    version: 2,
    description: "列出說話者與各自發言時間。List speakers with speaking time.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 8_000,
    schema: z.object({ projectId }),
    inputSchema: objectSchema({ projectId: str }, ["projectId"]),
    outputSchema: objectSchema({
      speakers: arr(objectSchema({ id: str, label: str, speakingMs: num, sentenceCount: num })),
    }),
    params: [P.project],
    activityKind: "speakers",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string }) => semantic.listProjectSpeakers(a.projectId),
  }),
  spec({
    name: "list_topics",
    version: 2,
    description: "列出影片談到的主題與時間範圍。List topics with time spans.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 8_000,
    schema: z.object({ projectId, limit: z.number().int().positive().max(50).optional() }),
    inputSchema: objectSchema({ projectId: str, limit: num }, ["projectId"]),
    outputSchema: objectSchema({
      topics: arr(objectSchema({ id: str, label: str, weight: num, startMs: num, endMs: num, sentenceCount: num })),
    }),
    params: [P.project, P.limit],
    activityKind: "topics",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string; limit?: number }) => semantic.listProjectTopics(a.projectId, a.limit),
  }),
  spec({
    name: "find_highlights",
    version: 2,
    description: "找出適合做精華或短影音的片段。Find highlight candidates.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 15_000,
    schema: z.object({
      projectId,
      targetDurationMs: timeMs.optional(),
      limit: z.number().int().positive().max(20).optional(),
      query: z.string().min(1).max(500).optional(),
    }),
    inputSchema: objectSchema(
      { projectId: str, targetDurationMs: num, limit: num, query: str },
      ["projectId"],
    ),
    outputSchema: objectSchema({
      highlights: arr(objectSchema({
        id: str, startMs: num, endMs: num, score: num, reasonCode: str,
        topicIds: arr(str), speaker: str, excerpt: str,
      })),
      timelineRevision: num,
    }),
    params: [
      P.project,
      { name: "targetDurationMs", type: "number", required: false },
      P.limit,
      { name: "query", type: "string", required: false },
    ],
    activityKind: "highlights",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string; targetDurationMs?: number; limit?: number; query?: string }) =>
      semantic.findProjectHighlights(a),
  }),
  spec({
    name: "inspect_scene",
    version: 2,
    description: "檢視某一段時間區間的內容摘要。Structured description of one time window.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 8_000,
    schema: z.object({ projectId, startMs: timeMs, endMs: timeMs }),
    inputSchema: objectSchema({ projectId: str, startMs: num, endMs: num }, ["projectId", "startMs", "endMs"]),
    outputSchema: objectSchema({
      startMs: num, endMs: num, durationMs: num, sentenceCount: num,
      speakers: arr(str), keyTerms: arr(str), speechMs: num, silenceMs: num,
      excerpt: str, truncated: bool,
    }),
    params: [
      P.project,
      { name: "startMs", type: "number", required: true },
      { name: "endMs", type: "number", required: true },
    ],
    activityKind: "scene",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string; startMs: number; endMs: number }) => semantic.inspectProjectScene(a),
  }),
  spec({
    name: "get_context_range",
    version: 2,
    description: "取得某段時間的逐字稿內容（有上限）。Bounded transcript window.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 8_000,
    schema: z.object({
      projectId,
      startMs: timeMs,
      endMs: timeMs,
      maxSentences: z.number().int().positive().max(200).optional(),
      maxChars: z.number().int().positive().max(20_000).optional(),
    }),
    inputSchema: objectSchema(
      { projectId: str, startMs: num, endMs: num, maxSentences: num, maxChars: num },
      ["projectId", "startMs", "endMs"],
    ),
    outputSchema: objectSchema({
      startMs: num, endMs: num, truncated: bool,
      sentences: arr(objectSchema({ id: str, startMs: num, endMs: num, speaker: str, text: str })),
    }),
    params: [
      P.project,
      { name: "startMs", type: "number", required: true },
      { name: "endMs", type: "number", required: true },
    ],
    activityKind: "context",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: {
      projectId: string; startMs: number; endMs: number;
      maxSentences?: number; maxChars?: number;
    }) => semantic.getProjectContextRange(a),
  }),
  spec({
    name: "build_semantic_context",
    version: 2,
    description: "建立要交給 AIOS 的受控語意脈絡（不送完整逐字稿）。Bounded semantic context for AIOS.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 15_000,
    schema: z.object({
      projectId,
      query: z.string().max(2_000),
      maxRanges: z.number().int().positive().max(64).optional(),
      maxChars: z.number().int().positive().max(40_000).optional(),
      targetDurationMs: timeMs.optional(),
    }),
    inputSchema: objectSchema(
      { projectId: str, query: str, maxRanges: num, maxChars: num, targetDurationMs: num },
      ["projectId", "query"],
    ),
    outputSchema: objectSchema({
      protocolVersion: str, projectId: str, timelineRevision: num,
      ranges: arr({ type: "object" }), topics: arr({ type: "object" }),
      speakers: arr({ type: "object" }), highlights: arr({ type: "object" }),
      provenance: { type: "object" }, budget: { type: "object" },
    }),
    params: [P.project, { name: "query", type: "string", required: true }],
    activityKind: "context",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (
      a: { projectId: string; query: string; maxRanges?: number; maxChars?: number; targetDurationMs?: number },
      ctx: CapabilityContext,
    ) => semantic.buildProjectSemanticContext({ ...a, requestId: ctx.requestId, capability: "build_semantic_context" }),
  }),
  spec({
    name: "get_job",
    version: 2,
    description: "查詢背景工作狀態。Get a background job's status.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 5_000,
    schema: z.object({ jobId: z.string().min(1).max(200) }),
    inputSchema: objectSchema({ jobId: str }, ["jobId"]),
    outputSchema: objectSchema({ id: str, kind: str, status: str, progress: num, stage: str, error: str }),
    params: [{ name: "jobId", type: "string", required: true }],
    activityKind: "job",
    run: (a: { jobId: string }) => service.getJob(a.jobId),
  }),
  spec({
    name: "get_agent_run",
    version: 2,
    description: "查詢 CUTOS 剪輯代理執行狀態。Get a CUTOS agent run.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 5_000,
    schema: z.object({ runId: z.string().min(1).max(200) }),
    inputSchema: objectSchema({ runId: str }, ["runId"]),
    outputSchema: objectSchema({ id: str, projectId: str, status: str, steps: arr({ type: "object" }) }),
    params: [{ name: "runId", type: "string", required: true }],
    activityKind: "run",
    run: (a: { runId: string }) => service.getAgentRun(a.runId),
  }),
  spec({
    name: "get_preview",
    version: 2,
    description: "取得即時預覽 manifest。Get the instant-preview manifest.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 8_000,
    schema: z.object({ projectId }),
    inputSchema: objectSchema({ projectId: str }, ["projectId"]),
    outputSchema: objectSchema({ timelineRevision: num, durationMs: num, segments: arr({ type: "object" }) }),
    params: [P.project],
    activityKind: "preview",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string }) => service.getProject(a.projectId).preview,
  }),
  spec({
    name: "list_activity",
    version: 2,
    description: "取得跨系統活動事件（可從序號續讀）。Replay the cross-system activity log.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 5_000,
    schema: z.object({
      projectId,
      afterSequence: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    inputSchema: objectSchema({ projectId: str, afterSequence: num, limit: num }, ["projectId"]),
    outputSchema: objectSchema({ events: arr({ type: "object" }), lastSequence: num }),
    params: [P.project],
    activityKind: "run",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    // Bound at registry construction time to avoid a cycle with the recorder.
    run: async (a: { projectId: string; afterSequence?: number; limit?: number }) => {
      const { listActivity } = await import("./aios-activity.js");
      return listActivity(a.projectId, { afterSequence: a.afterSequence, limit: a.limit });
    },
  }),

  // ---------------------------------------------------------------- plan ---
  spec({
    name: "analyze",
    version: 2,
    description: "分析影片（停頓、波形、逐字稿）。Enqueue media analysis. Returns a jobId.",
    access: "plan",
    risk: "low",
    idempotency: "keyed",
    requiresApproval: false,
    longRunning: true,
    mutatesTimeline: false,
    timeoutHintMs: 10_000,
    schema: z.object({ projectId }),
    inputSchema: objectSchema({ projectId: str }, ["projectId"]),
    outputSchema: objectSchema({ jobId: str }),
    params: [P.project],
    activityKind: "analyze",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string }) => ({ jobId: service.enqueueAnalyze(a.projectId) }),
  }),
  spec({
    name: "create_edit_plan",
    version: 2,
    description: "用自然語言指令建立剪輯計畫（待審核，不改動時間軸）。Create a staged edit plan.",
    access: "plan",
    risk: "low",
    idempotency: "keyed",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 60_000,
    schema: z.object({ projectId, instruction: z.string().min(1).max(2_000) }),
    inputSchema: objectSchema({ projectId: str, instruction: str }, ["projectId", "instruction"]),
    outputSchema: objectSchema({ runId: str, status: str, planId: str }),
    params: [P.project, { name: "instruction", type: "string", required: true, description: "支援繁體中文" }],
    activityKind: "plan",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: async (a: { projectId: string; instruction: string }) => {
      const planned = await service.plan(a.projectId, a.instruction);
      return {
        runId: planned.runId,
        status: planned.status,
        planId: planned.dto.pendingPlan?.id ?? null,
        summary: planned.dto.pendingPlan?.summary ?? null,
        operationCount: planned.dto.pendingPlan?.operations.length ?? 0,
        timelineRevision: planned.dto.timelineRevision,
        impact: planned.dto.pendingPlan?.impact ?? null,
      };
    },
  }),
  spec({
    name: "verify_edit_plan",
    version: 2,
    description: "驗證待審核計畫（是否過期、是否有不支援操作、影響多大）。Verify the staged plan.",
    access: "plan",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 10_000,
    schema: z.object({ projectId }),
    inputSchema: objectSchema({ projectId: str }, ["projectId"]),
    outputSchema: objectSchema({
      ok: bool, stale: bool, timelineRevision: num, targetRevision: num,
      impact: { type: "object" }, issues: arr(str),
    }),
    params: [P.project],
    activityKind: "verify",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string }) => verifyEditPlan(a.projectId),
  }),
  spec({
    name: "preview_edit_plan",
    version: 2,
    description: "產生待審核計畫的暫時預覽（不改動時間軸）。Ephemeral preview of the staged plan.",
    access: "plan",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 15_000,
    schema: z.object({ projectId }),
    inputSchema: objectSchema({ projectId: str }, ["projectId"]),
    outputSchema: objectSchema({ timelineRevision: num, durationMs: num, segments: arr({ type: "object" }) }),
    params: [P.project],
    activityKind: "preview",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string }) => service.previewPlanManifest(a.projectId),
  }),
  spec({
    name: "preview_operation",
    version: 2,
    description: "產生單一操作的暫時預覽。Ephemeral preview of one pending operation.",
    access: "plan",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 15_000,
    schema: z.object({ projectId, opIndex: z.number().int().nonnegative().max(10_000) }),
    inputSchema: objectSchema({ projectId: str, opIndex: num }, ["projectId", "opIndex"]),
    outputSchema: objectSchema({ timelineRevision: num, durationMs: num, segments: arr({ type: "object" }) }),
    params: [P.project, { name: "opIndex", type: "number", required: true }],
    activityKind: "preview",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string; opIndex: number }) =>
      service.previewOperationManifest(a.projectId, a.opIndex),
  }),
  spec({
    name: "reject_operation",
    version: 2,
    description: "從待審核計畫移除一項操作。Remove one operation from the staged plan.",
    access: "plan",
    risk: "low",
    idempotency: "keyed",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 10_000,
    schema: z.object({ projectId, opIndex: z.number().int().nonnegative().max(10_000) }),
    inputSchema: objectSchema({ projectId: str, opIndex: num }, ["projectId", "opIndex"]),
    outputSchema: objectSchema({ id: str, timelineRevision: num }),
    params: [P.project, { name: "opIndex", type: "number", required: true }],
    activityKind: "plan",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string; opIndex: number }) => service.rejectOperation(a.projectId, a.opIndex),
  }),

  // --------------------------------------------------------------- write ---
  spec({
    name: "apply_edit_plan",
    version: 2,
    description: "套用待審核計畫到時間軸（需要 expectedRevision）。Apply the staged plan.",
    access: "write",
    risk: "high",
    idempotency: "keyed",
    requiresApproval: true,
    longRunning: false,
    mutatesTimeline: true,
    timeoutHintMs: 30_000,
    schema: z.object({ projectId }),
    inputSchema: objectSchema({ projectId: str }, ["projectId"]),
    outputSchema: objectSchema({ id: str, timelineRevision: num, timeline: { type: "object" } }),
    params: [P.project],
    activityKind: "apply",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string }) => service.applyPending(a.projectId),
  }),
  spec({
    name: "undo",
    version: 2,
    description: "復原上一個剪輯。Undo the last timeline mutation.",
    access: "write",
    risk: "medium",
    idempotency: "keyed",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: true,
    timeoutHintMs: 15_000,
    schema: z.object({ projectId }),
    inputSchema: objectSchema({ projectId: str }, ["projectId"]),
    outputSchema: objectSchema({ id: str, timelineRevision: num }),
    params: [P.project],
    activityKind: "undo",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string }) => service.undo(a.projectId),
  }),
  spec({
    name: "redo",
    version: 2,
    description: "重做剪輯。Redo.",
    access: "write",
    risk: "medium",
    idempotency: "keyed",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: true,
    timeoutHintMs: 15_000,
    schema: z.object({ projectId }),
    inputSchema: objectSchema({ projectId: str }, ["projectId"]),
    outputSchema: objectSchema({ id: str, timelineRevision: num }),
    params: [P.project],
    activityKind: "redo",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string }) => service.redo(a.projectId),
  }),
  spec({
    name: "export",
    version: 2,
    description: "輸出影片（需要人工核准）。Enqueue an FFmpeg export. Returns a jobId.",
    access: "write",
    risk: "high",
    idempotency: "keyed",
    requiresApproval: true,
    longRunning: true,
    mutatesTimeline: false,
    timeoutHintMs: 20_000,
    schema: z.object({ projectId }),
    inputSchema: objectSchema({ projectId: str }, ["projectId"]),
    outputSchema: objectSchema({ jobId: str }),
    params: [P.project],
    activityKind: "export",
    projectIdOf: (a: { projectId: string }) => a.projectId,
    run: (a: { projectId: string }) => ({ jobId: service.enqueueExport(a.projectId) }),
  }),
  spec({
    name: "create_sample_project",
    version: 2,
    description: "建立內建示範專案。Create a demo project from the built-in sample.",
    access: "write",
    risk: "low",
    idempotency: "keyed",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 60_000,
    schema: z.object({}).strip(),
    inputSchema: objectSchema({}),
    outputSchema: objectSchema({ projectId: str }),
    params: [],
    activityKind: "run",
    run: async () => ({ projectId: await service.importSample() }),
  }),
  spec({
    name: "cancel_job",
    version: 2,
    description: "取消背景工作。Cancel a background job.",
    access: "write",
    risk: "low",
    idempotency: "keyed",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 10_000,
    schema: z.object({ jobId: z.string().min(1).max(200) }),
    inputSchema: objectSchema({ jobId: str }, ["jobId"]),
    outputSchema: objectSchema({ id: str, status: str }),
    params: [{ name: "jobId", type: "string", required: true }],
    activityKind: "cancel",
    run: (a: { jobId: string }) => service.cancelJob(a.jobId),
  }),
  spec({
    name: "retry_job",
    version: 2,
    description: "重試失敗的背景工作。Requeue a failed job.",
    access: "write",
    risk: "low",
    idempotency: "keyed",
    requiresApproval: false,
    longRunning: true,
    mutatesTimeline: false,
    timeoutHintMs: 10_000,
    schema: z.object({ jobId: z.string().min(1).max(200) }),
    inputSchema: objectSchema({ jobId: str }, ["jobId"]),
    outputSchema: objectSchema({ id: str, status: str }),
    params: [{ name: "jobId", type: "string", required: true }],
    activityKind: "job",
    run: (a: { jobId: string }) => service.retryJob(a.jobId),
  }),
  spec({
    name: "cancel_agent_run",
    version: 2,
    description: "取消 CUTOS 剪輯代理執行。Cancel a CUTOS agent run.",
    access: "write",
    risk: "medium",
    idempotency: "keyed",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 10_000,
    schema: z.object({ runId: z.string().min(1).max(200) }),
    inputSchema: objectSchema({ runId: str }, ["runId"]),
    outputSchema: objectSchema({ id: str, status: str }),
    params: [{ name: "runId", type: "string", required: true }],
    activityKind: "cancel",
    run: (a: { runId: string }) => service.cancelAgentRun(a.runId),
  }),
  spec({
    name: "resume_agent_run",
    version: 2,
    description: "回報剪輯代理執行是否可續行（計畫是否仍有效）。Report whether a run can resume.",
    access: "read",
    risk: "low",
    idempotency: "natural",
    requiresApproval: false,
    longRunning: false,
    mutatesTimeline: false,
    timeoutHintMs: 10_000,
    schema: z.object({ runId: z.string().min(1).max(200) }),
    inputSchema: objectSchema({ runId: str }, ["runId"]),
    outputSchema: objectSchema({ id: str, status: str, resumable: bool, stale: bool, timelineRevision: num }),
    params: [{ name: "runId", type: "string", required: true }],
    activityKind: "run",
    run: (a: { runId: string }) => service.resumeAgentRun(a.runId),
  }),
];

/**
 * Verification is a first-class capability rather than a side effect of apply:
 * a verifier agent must be able to check a plan without any risk of mutating.
 */
function verifyEditPlan(id: string) {
  const project = service.getProject(id);
  const plan = project.pendingPlan;
  if (!plan) {
    return {
      ok: false,
      stale: false,
      timelineRevision: project.timelineRevision,
      targetRevision: null,
      impact: null,
      issues: ["NO_PENDING_PLAN"],
    };
  }
  const issues: string[] = [];
  if (plan.stale) issues.push("STALE_TIMELINE_REVISION");
  const unsupported = plan.impact.unsupportedOperations;
  if (unsupported.length) issues.push(`UNSUPPORTED_OPERATION:${unsupported.join(",")}`);
  if (plan.operations.length === 0) issues.push("EMPTY_PLAN");
  if (plan.impact.estimatedDurationMs <= 0) issues.push("RESULT_WOULD_BE_EMPTY");
  return {
    ok: issues.length === 0,
    stale: plan.stale,
    timelineRevision: project.timelineRevision,
    targetRevision: plan.targetRevision,
    impact: plan.impact,
    requiresApproval: plan.requiresApproval,
    issues,
  };
}

const BY_NAME = new Map(CAPABILITIES.map((capability) => [capability.name, capability]));

/**
 * v1 capability names that v2 renamed. Existing v1 agents call `plan`/`apply`
 * with hard-coded strings, so both the resolver AND the published manifest keep
 * them alive. Removing an alias is a breaking protocol change.
 */
export const LEGACY_ALIASES: Record<string, string> = {
  plan: "create_edit_plan",
  apply: "apply_edit_plan",
};

export function findCapability(name: string): CapabilitySpec<unknown> | undefined {
  return BY_NAME.get(name) ?? BY_NAME.get(LEGACY_ALIASES[name] ?? "");
}

/** Manifest entries for the deprecated v1 names, so a v1 agent still finds them. */
export function legacyAliasDefinitions(): CapabilityDefinition[] {
  return Object.entries(LEGACY_ALIASES).flatMap(([alias, target]) => {
    const capability = BY_NAME.get(target);
    if (!capability) return [];
    const described = describeCapability(capability);
    return [{
      ...described,
      name: alias,
      version: 1,
      description: `[v1 相容名稱，請改用 ${target}] ${described.description}`,
    }];
  });
}

export function capabilityNames(): string[] {
  return CAPABILITIES.map((capability) => capability.name);
}

/** The manifest view of one capability, including the legacy v1 fields. */
export function describeCapability(capability: CapabilitySpec<unknown>): CapabilityDefinition {
  return {
    name: capability.name,
    version: capability.version,
    description: capability.description,
    permission: capability.access === "read" ? "read" : "write",
    access: capability.access,
    risk: capability.risk,
    idempotency: capability.idempotency,
    requiresApproval: capability.requiresApproval,
    longRunning: capability.longRunning,
    mutatesTimeline: capability.mutatesTimeline,
    timeoutHintMs: capability.timeoutHintMs,
    inputSchema: capability.inputSchema,
    outputSchema: capability.outputSchema,
    params: capability.params,
  };
}
