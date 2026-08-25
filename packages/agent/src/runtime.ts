import type { EditPlan } from "@cutos/edit-dsl";
import type { ContextBuilder, EditContext } from "./context.js";
import { buildVideoContextPacket, defaultInspectWindow } from "./context-packet.js";
import {
  answerTurn,
  editTurn,
  questionTurn,
  type AgentTurn,
  type SuggestedAction,
  type VisualObservation,
} from "./chat-response.js";
import { classifyIntent, type ClassifiedIntent } from "./intent.js";
import { DefaultApprovalPolicy, estimateImpact, type ApprovalPolicy, type EditImpact } from "./impact.js";
import { isGroundedFollowUp, proposeGroundedEdit } from "./grounded-edit.js";
import { validatePlaybackContext, type PlaybackContext, type PlaybackContextInput } from "./playback.js";
import type { AgentRun, AgentRunStore, AgentStepKind } from "./run.js";
import { formatClock, formatClockRange, resolveTimeRefs } from "./time-parse.js";
import type { AgentPermission, ToolContext, ToolRegistry } from "./tools.js";
import { verifyEdit, type VerifyResult } from "./verify.js";
import { sanitizeAgentError, frameFailureMessage } from "./sanitize.js";
import {
  FrameExtractionError,
  UnavailableVisionProvider,
  VisionNotConfiguredError,
  VisionTimeoutError,
  type FrameExtractor,
  type VideoVisionProvider,
} from "./vision.js";
import {
  MemoryVisualIndexStore,
  searchVisualIndex,
  segmentFromObservation,
} from "./visual-search.js";

/** Result shape the `create_edit_plan` tool must return. */
export interface CreatePlanToolResult {
  plan?: EditPlan;
  issues?: string[];
}

export interface ConversationRuntimeDeps {
  vision?: VideoVisionProvider;
  frames?: FrameExtractor;
  visualIndex?: MemoryVisualIndexStore;
}

export interface AgentRuntimeDeps {
  registry: ToolRegistry;
  contextBuilder: ContextBuilder;
  runStore: AgentRunStore;
  approvalPolicy?: ApprovalPolicy;
  permissions?: AgentPermission[];
  now?: () => number;
  createId?: () => string;
  conversation?: ConversationRuntimeDeps;
}

export interface PlanEditInput {
  projectId: string;
  instruction: string;
}

export interface ConverseInput {
  projectId: string;
  instruction: string;
  playback?: PlaybackContextInput;
  action?: SuggestedAction;
}

/**
 * Orchestrates the agent loop: observe → intent → (inspect | plan) →
 * validate → approval. Question intents never go through the Edit Planner.
 * The agent never edits media directly.
 */
export class AgentRuntime {
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly permissions: Set<AgentPermission>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly vision: VideoVisionProvider;
  private readonly frames: FrameExtractor | undefined;
  private readonly visualIndex: MemoryVisualIndexStore;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.approvalPolicy = deps.approvalPolicy ?? new DefaultApprovalPolicy();
    this.permissions = new Set(deps.permissions ?? ["read", "analyze", "plan"]);
    this.now = deps.now ?? (() => Date.now());
    this.createId = deps.createId ?? (() => `run_${Math.random().toString(36).slice(2, 10)}`);
    this.vision = deps.conversation?.vision ?? new UnavailableVisionProvider();
    this.frames = deps.conversation?.frames;
    this.visualIndex = deps.conversation?.visualIndex ?? new MemoryVisualIndexStore();
  }

  async planEdit(input: PlanEditInput): Promise<AgentRun> {
    const run = this.startRun(input.projectId, input.instruction);
    this.step(run, "observe", "Received request", input.instruction);
    this.persist(run);

    try {
      const context = await this.deps.contextBuilder.build(input.projectId);
      this.noteContext(run, context);
      return await this.runPlanner(run, input.instruction, context);
    } catch (error) {
      return this.fail(run, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Conversational turn: classify intent, then inspect / search / edit / ask.
   * Edit Plans are produced only for `edit` intents.
   */
  async converse(input: ConverseInput): Promise<AgentRun> {
    const run = this.startRun(input.projectId, input.instruction);
    this.step(run, "observe", "Received request", input.instruction);
    this.persist(run);

    try {
      const context = await this.deps.contextBuilder.build(input.projectId);
      this.noteContext(run, context);
      const playback = validatePlaybackContext(input.playback, context.sourceDurationMs);
      const intent = classifyIntent(input.instruction);
      run.intents = [intent.primary, ...intent.secondary];
      this.step(
        run,
        "intent",
        "Classified intent",
        intent.primary,
        undefined,
        { intent: intent.primary, edit: intent.needsEditPlan ? 1 : 0 },
      );

      if (input.action) {
        return await this.handleAction(run, input, context, playback, intent);
      }

      if (intent.needsEditPlan) {
        return await this.handleEdit(run, input, context, playback, intent);
      }

      if (intent.primary === "transport_control") {
        return this.completeAnswer(run, this.transportAnswer(intent, playback, context));
      }

      if (intent.primary === "clarification") {
        return this.completeAnswer(
          run,
          questionTurn("你是想看這個時間點的畫面，還是要從這裡開始剪？", ["詢問這一幕", "從這裡開始"]),
        );
      }

      if (intent.primary === "unsupported") {
        return this.completeAnswer(
          run,
          answerTurn(
            "我可以幫你看畫面、找片段，或依你的話建立剪輯計畫。試試「0:25 那邊你看得到嗎」，或「刪掉超過 1 秒的停頓」。",
          ),
        );
      }

      if (intent.primary === "semantic_search" || intent.secondary.includes("semantic_search")) {
        return await this.handleSearch(run, input, context, playback, intent);
      }

      return await this.handleInspect(run, input, context, playback, intent);
    } catch (error) {
      return this.failTurn(run, error);
    }
  }

  /** Record execution + verification once the user applies the plan. */
  completeRun(
    runId: string,
    args: { beforeDurationMs: number; afterDurationMs: number; impact: EditImpact },
  ): AgentRun | undefined {
    const run = this.deps.runStore.get(runId);
    if (!run) return undefined;
    this.step(
      run,
      "execute",
      "Applied edit plan to the timeline",
      `duration ${args.beforeDurationMs}ms → ${args.afterDurationMs}ms`,
      undefined,
      { before: args.beforeDurationMs, after: args.afterDurationMs },
    );
    const verify: VerifyResult = verifyEdit({
      beforeDurationMs: args.beforeDurationMs,
      afterDurationMs: args.afterDurationMs,
      impact: args.impact,
    });
    this.step(run, "verify", verify.ok ? "Verified result" : "Verification found issues", verify.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`).join(", "));
    this.step(run, "summary", "Done", run.summary ?? "Edit applied");
    run.status = verify.ok ? "applied" : "completed";
    run.updatedAt = this.now();
    this.persist(run);
    return run;
  }

  private startRun(projectId: string, instruction: string): AgentRun {
    return {
      id: this.createId(),
      projectId,
      input: instruction,
      status: "running",
      createdAt: this.now(),
      updatedAt: this.now(),
      steps: [],
      toolCalls: [],
      planId: null,
      summary: null,
      error: null,
    };
  }

  private noteContext(run: AgentRun, context: EditContext): void {
    this.step(
      run,
      "context",
      "Analyzed project context",
      `${Math.round(context.sourceDurationMs / 1000)}s source · ${context.silences.length} pauses · revision ${context.timelineRevision}`,
      undefined,
      {
        seconds: Math.round(context.sourceDurationMs / 1000),
        pauses: context.silences.length,
        revision: context.timelineRevision,
      },
    );
  }

  private lastGrounding(projectId: string): VisualObservation | undefined {
    for (const previous of this.deps.runStore.listByProject(projectId)) {
      if (previous.grounding) return previous.grounding;
    }
    return undefined;
  }

  private async handleAction(
    run: AgentRun,
    input: ConverseInput,
    context: EditContext,
    playback: PlaybackContext,
    intent: ClassifiedIntent,
  ): Promise<AgentRun> {
    const action = input.action;
    if (!action) return this.handleInspect(run, input, context, playback, intent);
    if (action.type === "trim_from" && action.atMs != null) {
      const observation: VisualObservation = {
        startMs: action.atMs,
        endMs: action.atMs,
        description: "使用者指定的時間點",
        objects: [],
        peopleDescriptions: [],
        textSeen: [],
        confidence: 1,
        frameRefs: [action.atMs],
      };
      return this.stageGrounded(run, { instruction: "從這裡開始", observation, sourceDurationMs: context.sourceDurationMs }, context);
    }
    if (action.type === "keep_scene" && action.startMs != null && action.endMs != null) {
      const observation: VisualObservation = {
        startMs: action.startMs,
        endMs: action.endMs,
        description: "使用者指定的這一幕",
        objects: [],
        peopleDescriptions: [],
        textSeen: [],
        confidence: 1,
        frameRefs: [action.startMs, action.endMs],
      };
      return this.stageGrounded(run, { instruction: "保留這一幕", observation, sourceDurationMs: context.sourceDurationMs }, context);
    }
    if (action.type === "retry_inspect" || action.type === "ask_current" || action.type === "inspect_window") {
      return this.handleInspect(run, input, context, playback, intent, {
        centerMs: action.centerMs ?? action.atMs ?? playback.playheadMs,
        beforeMs: action.beforeMs ?? 1000,
        afterMs: action.afterMs ?? 1000,
        samples: 5,
      });
    }
    if (action.type === "seek" && action.atMs != null) {
      return this.completeAnswer(
        run,
        answerTurn(`好，跳到 ${formatClock(action.atMs)}。`, {
          suggestedActions: [{ type: "seek", atMs: action.atMs, label: `跳到 ${formatClock(action.atMs)}` }],
        }),
      );
    }
    return this.handleInspect(run, input, context, playback, intent);
  }

  private async handleEdit(
    run: AgentRun,
    input: ConverseInput,
    context: EditContext,
    playback: PlaybackContext,
    intent: ClassifiedIntent,
  ): Promise<AgentRun> {
    const last = this.lastGrounding(input.projectId);
    if (isGroundedFollowUp(input.instruction)) {
      const observation =
        last ??
        ({
          startMs: playback.playheadMs,
          endMs: playback.playheadMs,
          description: "目前播放位置",
          objects: [],
          peopleDescriptions: [],
          textSeen: [],
          confidence: 1,
          frameRefs: [playback.playheadMs],
        } satisfies VisualObservation);
      const proposed = proposeGroundedEdit({
        instruction: input.instruction,
        observation,
        sourceDurationMs: context.sourceDurationMs,
      });
      if (proposed && proposed.operations.length > 0) {
        return this.stageGrounded(
          run,
          { instruction: input.instruction, observation, sourceDurationMs: context.sourceDurationMs },
          context,
          proposed,
          { userFacing: true },
        );
      }
      if (!last && (input.playback?.playheadMs == null)) {
        return this.completeAnswer(
          run,
          questionTurn("你是指目前播放位置，還是上一個我看過的畫面？", ["目前播放位置", "上一個畫面"]),
        );
      }
    }

    if (intent.secondary.includes("semantic_search")) {
      const found = await this.lookupVisual(input.projectId, input.instruction, context);
      if (found) {
        const proposed = proposeGroundedEdit({
          instruction: "從這裡開始",
          observation: found,
          sourceDurationMs: context.sourceDurationMs,
        });
        if (proposed) {
          run.grounding = found;
          return this.stageGrounded(
            run,
            { instruction: input.instruction, observation: found, sourceDurationMs: context.sourceDurationMs },
            context,
            proposed,
            { userFacing: true },
          );
        }
      }
    }

    return this.runPlanner(run, input.instruction, context, undefined, undefined, { userFacing: true });
  }

  private async handleSearch(
    run: AgentRun,
    input: ConverseInput,
    context: EditContext,
    playback: PlaybackContext,
    intent: ClassifiedIntent,
  ): Promise<AgentRun> {
    const found = await this.lookupVisual(input.projectId, input.instruction, context);
    if (found) {
      this.step(run, "inspect", "Matched a visual segment", formatClockRange(found.startMs, found.endMs));
      const turn = answerTurn(
        `在 ${formatClockRange(found.startMs, found.endMs)} 附近：${found.description}`,
        {
          grounding: found,
          frames: found.frameRefs.slice(0, 3).map((timeMs) => ({ timeMs, description: found.description })),
          suggestedActions: inspectActions(found),
        },
      );
      run.grounding = found;
      return this.completeAnswer(run, turn);
    }

    const transcriptHits = (context.transcriptSentences ?? []).filter((s) =>
      input.instruction.split(/[\s，。、]+/).some((token) => token.length >= 2 && s.text.includes(token)),
    );
    if (transcriptHits[0]) {
      const hit = transcriptHits[0];
      const observation: VisualObservation = {
        startMs: hit.startMs,
        endMs: hit.endMs,
        description: hit.text,
        objects: [],
        peopleDescriptions: [],
        textSeen: [],
        confidence: 0.4,
        frameRefs: [hit.startMs],
      };
      return this.completeAnswer(
        run,
        answerTurn(`逐字稿在 ${formatClockRange(hit.startMs, hit.endMs)} 提到：「${hit.text}」。我還沒對到畫面，要不要我看這一幕？`, {
          grounding: observation,
          suggestedActions: [
            { type: "ask_current", atMs: hit.startMs, label: "詢問這一幕" },
            { type: "trim_from", atMs: hit.startMs, label: "從這裡開始" },
          ],
        }),
      );
    }

    if (!this.vision.configured) {
      return this.completeAnswer(run, answerTurn(new VisionNotConfiguredError().message));
    }
    return this.handleInspect(run, input, context, playback, intent);
  }

  private async handleInspect(
    run: AgentRun,
    input: ConverseInput,
    context: EditContext,
    playback: PlaybackContext,
    intent: ClassifiedIntent,
    window?: { centerMs: number; beforeMs: number; afterMs: number; samples: number },
  ): Promise<AgentRun> {
    const last = this.lastGrounding(input.projectId);
    const resolved = resolveTimeRefs(intent.timeRefs, {
      playheadMs: playback.playheadMs,
      lastMs: last ? Math.round((last.startMs + last.endMs) / 2) : undefined,
      sourceDurationMs: context.sourceDurationMs,
    });
    const centerMs =
      window?.centerMs ??
      resolved[0] ??
      (intent.primary === "inspect_current_frame" ? playback.playheadMs : playback.playheadMs);
    const inspect = window ?? defaultInspectWindow(centerMs);

    if (!this.vision.configured) {
      const transcript = nearbyTranscript(context, centerMs);
      const extra = transcript ? `依逐字稿，${formatClock(centerMs)} 附近聽到：「${transcript}」` : "";
      return this.completeAnswer(
        run,
        answerTurn(`${new VisionNotConfiguredError().message}${extra ? `\n${extra}` : ""}`, {
          suggestedActions: [{ type: "trim_from", atMs: centerMs, label: "從這裡開始" }],
        }),
      );
    }

    if (!this.frames) {
      return this.completeAnswer(run, answerTurn(frameFailureMessage(centerMs), {
        suggestedActions: [{ type: "retry_inspect", atMs: centerMs, label: "重新分析這一幕" }],
      }));
    }

    this.step(run, "inspect", "Extracting frames", formatClock(centerMs), undefined, { centerMs });
    let frames;
    try {
      frames = await this.frames.extractFrameWindow({
        projectId: input.projectId,
        centerMs: inspect.centerMs,
        beforeMs: inspect.beforeMs,
        afterMs: inspect.afterMs,
        samples: inspect.samples,
      });
    } catch {
      return this.completeAnswer(run, answerTurn(frameFailureMessage(centerMs), {
        suggestedActions: [{ type: "retry_inspect", atMs: centerMs, label: "重新分析這一幕" }],
      }));
    }
    if (frames.length === 0) {
      throw new FrameExtractionError(centerMs);
    }

    const packet = buildVideoContextPacket({
      projectId: input.projectId,
      centerMs,
      frames,
      context,
    });
    const question = input.instruction;

    let visionAnswer;
    try {
      visionAnswer = await this.vision.answerQuestion({ question, context: packet, frames });
    } catch (error) {
      if (error instanceof VisionTimeoutError) {
        return this.completeAnswer(
          run,
          answerTurn(sanitizeAgentError(error), {
            suggestedActions: [{ type: "retry_inspect", atMs: centerMs, label: "重新分析這一幕" }],
          }),
        );
      }
      throw error;
    }

    const observation = visionAnswer.observation;
    this.rememberObservation(input.projectId, context.mediaChecksum ?? "unknown", observation);
    run.grounding = observation;
    const spoken = spokenInspect(question, observation);
    return this.completeAnswer(
      run,
      answerTurn(spoken, {
        grounding: observation,
        frames: observation.frameRefs.map((timeMs) => ({ timeMs, description: observation.description })),
        suggestedActions: inspectActions(observation),
      }),
    );
  }

  private async lookupVisual(
    projectId: string,
    query: string,
    context: EditContext,
  ): Promise<VisualObservation | null> {
    const checksum = context.mediaChecksum ?? "unknown";
    let index = this.visualIndex.load(projectId, checksum);
    if ((!index || index.segments.length === 0) && this.vision.configured && this.frames) {
      index = await this.sparseIndex(projectId, context);
    }
    if (!index) return null;
    const hits = searchVisualIndex(index, query, 3);
    const hit = hits[0];
    if (!hit || hit.score < 0.02) return null;
    return {
      startMs: hit.segment.startMs,
      endMs: hit.segment.endMs,
      description: hit.segment.summary,
      objects: hit.segment.objects,
      peopleDescriptions: [],
      textSeen: hit.segment.ocr,
      confidence: Math.min(1, hit.score),
      frameRefs: [hit.segment.startMs, hit.segment.endMs],
    };
  }

  private async sparseIndex(projectId: string, context: EditContext) {
    if (!this.frames) return undefined;
    const duration = Math.max(1, context.sourceDurationMs);
    const count = Math.min(8, Math.max(3, Math.round(duration / 8_000)));
    const times: number[] = [];
    for (let i = 0; i < count; i += 1) {
      times.push(Math.round((duration * (i + 0.5)) / count));
    }
    const checksum = context.mediaChecksum ?? "unknown";
    for (const timeMs of times) {
      try {
        const frame = await this.frames.extractFrame(projectId, timeMs);
        const packet = buildVideoContextPacket({
          projectId,
          centerMs: timeMs,
          frames: [frame],
          context,
        });
        const answer = await this.vision.inspectFrame({ frame, context: packet });
        this.rememberObservation(projectId, checksum, answer.observation);
      } catch {
        // Sparse indexing is best-effort; a single failed sample must not fail the turn.
      }
    }
    return this.visualIndex.load(projectId, checksum);
  }

  private rememberObservation(projectId: string, mediaChecksum: string, observation: VisualObservation): void {
    this.visualIndex.addSegments(projectId, mediaChecksum, [segmentFromObservation(observation)]);
  }

  private async stageGrounded(
    run: AgentRun,
    input: { instruction: string; observation: VisualObservation; sourceDurationMs: number },
    context: EditContext,
    proposed = proposeGroundedEdit(input),
    options?: { userFacing?: boolean },
  ): Promise<AgentRun> {
    if (!proposed || proposed.operations.length === 0) {
      return this.completeAnswer(run, answerTurn("我還不能從這個畫面建立剪輯，請再說一次你想怎麼剪。"));
    }
    run.grounding = input.observation;
    return this.runPlanner(run, input.instruction, context, proposed.operations, proposed.summary, options);
  }

  private async runPlanner(
    run: AgentRun,
    instruction: string,
    context: EditContext,
    operations?: unknown[],
    summary?: string,
    options?: { userFacing?: boolean },
  ): Promise<AgentRun> {
    const ctx: ToolContext = { runId: run.id, projectId: run.projectId, permissions: this.permissions };
    const args =
      operations && operations.length > 0
        ? { instruction, context, operations, summary }
        : { instruction, context };
    const invocation = await this.deps.registry.call("create_edit_plan", args, ctx);
    run.toolCalls.push(invocation.record);
    this.step(run, "tool_call", `Called tool "create_edit_plan"`, invocation.record.status, invocation.record.id);

    if (invocation.record.status === "error") {
      const raw = invocation.record.error ?? "planning tool failed";
      return options?.userFacing ? this.failTurn(run, raw) : this.fail(run, raw);
    }

    const result = invocation.result as CreatePlanToolResult;
    if (!result.plan) {
      const raw = result.issues?.join("; ") ?? "No actionable plan was produced";
      return options?.userFacing ? this.failTurn(run, raw) : this.fail(run, raw);
    }

    const plan = result.plan;
    this.step(run, "plan", "Created edit plan", plan.summary);

    const impact = estimateImpact(plan, context.sourceDurationMs);
    this.step(
      run,
      "validate",
      "Validated plan",
      `${impact.operationCount} operation(s), est. ${Math.round(impact.estimatedDurationMs / 1000)}s (risk: ${impact.riskLevel})`,
      undefined,
      {
        count: impact.operationCount,
        seconds: Math.round(impact.estimatedDurationMs / 1000),
        risk: impact.riskLevel,
      },
    );

    const decision = this.approvalPolicy.evaluate(impact);
    this.step(run, "approval", decision.requiresApproval ? "Awaiting your approval" : "Auto-approved", decision.reason);

    run.planId = plan.id;
    run.summary = plan.summary;
    run.status = "awaiting_approval";
    run.turn = editTurn(plan.summary, plan.id);
    run.updatedAt = this.now();
    this.persist(run);
    return run;
  }

  private transportAnswer(
    intent: ClassifiedIntent,
    playback: PlaybackContext,
    context: EditContext,
  ): AgentTurn {
    const times = resolveTimeRefs(intent.timeRefs, {
      playheadMs: playback.playheadMs,
      sourceDurationMs: context.sourceDurationMs,
    });
    const atMs = times[0] ?? playback.playheadMs;
    return answerTurn(`好，跳到 ${formatClock(atMs)}。`, {
      suggestedActions: [{ type: "seek", atMs, label: `跳到 ${formatClock(atMs)}` }],
    });
  }

  private completeAnswer(run: AgentRun, turn: AgentTurn): AgentRun {
    run.turn = turn;
    run.summary = turn.message;
    run.status = "completed";
    run.grounding = turn.type === "answer" ? turn.grounding : run.grounding;
    this.step(run, "answer", "Replied", turn.message);
    run.updatedAt = this.now();
    this.persist(run);
    return run;
  }

  private failTurn(run: AgentRun, error: unknown): AgentRun {
    const message = sanitizeAgentError(error);
    run.turn = answerTurn(message, {
      suggestedActions:
        error instanceof VisionTimeoutError || error instanceof FrameExtractionError
          ? [{ type: "retry_inspect", label: "重新分析這一幕" }]
          : [],
    });
    run.status = "completed";
    run.summary = message;
    run.error = null;
    this.step(run, "answer", "Replied", message);
    run.updatedAt = this.now();
    this.persist(run);
    return run;
  }

  private step(
    run: AgentRun,
    kind: AgentStepKind,
    title: string,
    detail?: string,
    toolCallId?: string,
    data?: Record<string, number | string>,
  ): void {
    run.steps.push({ at: this.now(), kind, title, detail, toolCallId, data });
    run.updatedAt = this.now();
  }

  private fail(run: AgentRun, error: string): AgentRun {
    run.status = "failed";
    run.error = error;
    this.step(run, "error", "Could not complete the request", error);
    run.updatedAt = this.now();
    this.persist(run);
    return run;
  }

  private persist(run: AgentRun): void {
    this.deps.runStore.save(run);
  }
}

function inspectActions(observation: VisualObservation): SuggestedAction[] {
  const atMs = observation.frameRefs[Math.floor(observation.frameRefs.length / 2)] ?? observation.startMs;
  return [
    { type: "trim_from", atMs, label: "從這裡開始" },
    { type: "keep_scene", startMs: observation.startMs, endMs: observation.endMs, label: "保留這一幕" },
    {
      type: "inspect_window",
      centerMs: atMs,
      beforeMs: 5000,
      afterMs: 5000,
      label: "分析前後 5 秒",
    },
  ];
}

function spokenInspect(question: string, observation: VisualObservation): string {
  const sees = /看[得的]?到|看得見/.test(question);
  const range = formatClockRange(observation.startMs, observation.endMs);
  const body = observation.description;
  if (sees) {
    return `可以。${range} ${body} 你是想從這個畫面開始剪，還是想調整這一段？`;
  }
  return `${range} ${body}`;
}

function nearbyTranscript(context: EditContext, centerMs: number): string | undefined {
  const hit = context.transcriptSentences?.find((s) => s.startMs <= centerMs && centerMs <= s.endMs)
    ?? context.transcriptSentences?.find((s) => Math.abs(s.startMs - centerMs) < 4000);
  return hit?.text;
}
