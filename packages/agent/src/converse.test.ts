import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PlanGateway } from "./gateway.js";
import { LocalHeuristicPlanner } from "./local-planner.js";
import { EditContextSchema, type ContextBuilder, type EditContext } from "./context.js";
import { MemoryAgentRunStore } from "./run.js";
import { AgentRuntime, type CreatePlanToolResult } from "./runtime.js";
import { ToolRegistry, type Tool } from "./tools.js";
import type { ExtractedFrame, VideoContextPacket, VideoVisionProvider, VisionAnswer } from "./vision.js";
import { MalformedModelResponseError } from "./vision.js";
import { MemoryVisualIndexStore, segmentFromObservation } from "./visual-search.js";
import type { VisualObservation } from "./chat-response.js";

const context: EditContext = {
  sourceDurationMs: 60_000,
  timelineRevision: 0,
  silences: [],
  mediaChecksum: "abc",
  transcriptSentences: [
    { startMs: 22_000, endMs: 28_000, text: "歡迎來到市集", speaker: null },
  ],
};

const contextBuilder: ContextBuilder = { build: async () => context };

function jpegStub(timeMs: number): ExtractedFrame {
  return {
    timeMs,
    mimeType: "image/jpeg",
    width: 64,
    height: 36,
    data: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
  };
}

const observation: VisualObservation = {
  startMs: 24_000,
  endMs: 26_000,
  description: "畫面中央是一位女生，抱著大量傳單站在市集裡。",
  objects: ["傳單"],
  peopleDescriptions: ["畫面中央的女生"],
  textSeen: [],
  confidence: 0.92,
  frameRefs: [24_000, 24_500, 25_000, 25_500, 26_000],
};

function visionAnswer(_question: string): VisionAnswer {
  return {
    message: observation.description,
    observation,
    provider: "mock",
    model: "mock-vision",
    latencyMs: 12,
  };
}

function mockVision(overrides: Partial<VideoVisionProvider> = {}): VideoVisionProvider {
  return {
    name: "mock-vision",
    configured: true,
    inspectFrame: async () => visionAnswer(""),
    inspectTimeRange: async () => visionAnswer(""),
    answerQuestion: async ({ question }) => visionAnswer(question),
    ...overrides,
  };
}

function mockFrames() {
  return {
    async extractFrame(_projectId: string, timeMs: number) {
      return jpegStub(timeMs);
    },
    async extractFrameWindow(input: {
      projectId: string;
      centerMs: number;
      beforeMs: number;
      afterMs: number;
      samples: number;
    }) {
      void input.projectId;
      const start = input.centerMs - input.beforeMs;
      const times: number[] = [];
      for (let i = 0; i < input.samples; i += 1) {
        times.push(Math.round(start + ((input.beforeMs + input.afterMs) * i) / Math.max(1, input.samples - 1)));
      }
      return times.map(jpegStub);
    },
  };
}

function planTool(): Tool<
  { instruction: string; context: EditContext; operations?: unknown[]; summary?: string },
  CreatePlanToolResult
> {
  const gateway = new PlanGateway(new LocalHeuristicPlanner(), {
    now: () => 0,
    createId: () => "plan_x",
  });
  return {
    name: "create_edit_plan",
    description: "Create a validated edit plan",
    permission: "plan",
    argsSchema: z.object({
      instruction: z.string(),
      context: EditContextSchema,
      operations: z.array(z.unknown()).optional(),
      summary: z.string().optional(),
    }),
    async execute(args) {
      const request = {
        instruction: args.instruction,
        sourceDurationMs: args.context.sourceDurationMs,
        silences: args.context.silences,
        targetRevision: args.context.timelineRevision,
      };
      const result = args.operations
        ? gateway.wrap({ summary: args.summary ?? "Proposed edits", operations: args.operations }, request)
        : await gateway.plan(request);
      return result.ok ? { plan: result.value } : { issues: result.errors };
    },
  };
}

function runtime(vision: VideoVisionProvider = mockVision(), visualIndex?: MemoryVisualIndexStore) {
  const runStore = new MemoryAgentRunStore();
  const registry = new ToolRegistry();
  registry.register(planTool());
  const agent = new AgentRuntime({
    registry,
    contextBuilder,
    runStore,
    permissions: ["read", "analyze", "plan"],
    now: () => 1,
    createId: () => `run_${runStore.listByProject("p").length + 1}`,
    conversation: { vision, frames: mockFrames(), visualIndex },
  });
  return { agent, runStore };
}

describe("AgentRuntime.converse", () => {
  it("does not create an Edit Plan for 「0:25」", async () => {
    const { agent } = runtime();
    const run = await agent.converse({
      projectId: "p",
      instruction: "0:25",
      playback: { playheadMs: 0 },
    });
    expect(run.status).toBe("completed");
    expect(run.planId).toBeNull();
    expect(run.turn?.type).toBe("answer");
    expect(run.error).toBeNull();
  });

  it("answers 「0:25 那邊你看得到嗎」 without an edit plan", async () => {
    const { agent } = runtime();
    const run = await agent.converse({
      projectId: "p",
      instruction: "0:25 那邊你看得到嗎",
      playback: { playheadMs: 25_000 },
    });
    expect(run.status).toBe("completed");
    expect(run.planId).toBeNull();
    expect(run.turn?.type).toBe("answer");
    expect(run.turn?.message).toContain("可以");
    expect(run.grounding?.peopleDescriptions[0]).toContain("女生");
    expect(run.error).toBeNull();
  });

  it("uses the vision tool for 「25秒女生手上拿什麼」", async () => {
    let asked = "";
    const vision = mockVision({
      answerQuestion: async ({ question, frames }: { question: string; frames: ExtractedFrame[]; context: VideoContextPacket }) => {
        asked = question;
        expect(frames.length).toBeGreaterThan(1);
        return visionAnswer(question);
      },
    });
    const { agent } = runtime(vision);
    const run = await agent.converse({
      projectId: "p",
      instruction: "25秒女生手上拿什麼",
      playback: { playheadMs: 0 },
    });
    expect(asked).toContain("手上");
    expect(run.turn?.type).toBe("answer");
    expect(run.planId).toBeNull();
  });

  it("turns 「從這裡開始」 after grounding into a valid trim Edit Plan", async () => {
    const { agent } = runtime();
    await agent.converse({
      projectId: "p",
      instruction: "0:25 那邊你看得到嗎",
      playback: { playheadMs: 25_000 },
    });
    const run = await agent.converse({
      projectId: "p",
      instruction: "好，就從這裡開始。",
      playback: { playheadMs: 25_000, timelineRevision: 0 },
    });
    expect(run.status).toBe("awaiting_approval");
    expect(run.planId).toBe("plan_x");
    expect(run.turn?.type).toBe("edit_plan");
    const created = run.toolCalls[0]?.result as CreatePlanToolResult | undefined;
    expect(created?.plan?.operations[0]).toMatchObject({ type: "trim", startMs: 25_000, endMs: 60_000 });
  });

  it("falls back to natural zh-TW when no vision provider is configured", async () => {
    const { agent } = runtime({
      name: "none",
      configured: false,
      inspectFrame: async () => {
        throw new Error("should not be called");
      },
      inspectTimeRange: async () => {
        throw new Error("should not be called");
      },
      answerQuestion: async () => {
        throw new Error("should not be called");
      },
    });
    const run = await agent.converse({
      projectId: "p",
      instruction: "0:25 那邊你看得到嗎",
      playback: { playheadMs: 25_000 },
    });
    expect(run.status).toBe("completed");
    expect(run.turn?.message).toContain("尚未設定影片視覺理解模型");
    expect(run.turn?.message).not.toMatch(/Array must contain/);
    expect(run.planId).toBeNull();
  });

  it("does not raise a validation error when vision returns zero editing operations", async () => {
    const { agent } = runtime();
    const run = await agent.converse({
      projectId: "p",
      instruction: "0:25 那邊你看得到嗎",
      playback: { playheadMs: 25_000 },
    });
    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    expect(run.turn?.type).toBe("answer");
  });

  it("sanitizes a malformed model response", async () => {
    const { agent } = runtime(
      mockVision({
        answerQuestion: async () => {
          throw new MalformedModelResponseError();
        },
      }),
    );
    const run = await agent.converse({
      projectId: "p",
      instruction: "這裡你看得到嗎？",
      playback: { playheadMs: 25_000 },
    });
    expect(run.status).toBe("completed");
    expect(run.turn?.message).toContain("格式不正確");
    expect(run.turn?.message).not.toMatch(/JSON|Unexpected|Zod/);
  });

  it("finds a previously described scene via visual search", async () => {
    const index = new MemoryVisualIndexStore();
    index.addSegments("p", "abc", [segmentFromObservation(observation)]);
    const { agent } = runtime(mockVision(), index);
    const run = await agent.converse({
      projectId: "p",
      instruction: "哪裡有女生抱著傳單",
      playback: { playheadMs: 0 },
    });
    expect(run.turn?.type).toBe("answer");
    expect(run.grounding?.startMs).toBe(24_000);
    expect(run.planId).toBeNull();
  });
});
