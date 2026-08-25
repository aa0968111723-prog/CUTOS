import { VisualObservationSchema, type VisualObservation } from "./chat-response.js";
import type { ModelCatalog } from "./model-router.js";
import { routeModel, type ModelUsageSink } from "./model-router.js";
import { OpenAICompatibleClient, type ChatTurn } from "./model-client.js";
import {
  MalformedModelResponseError,
  frameToDataUrl,
  type ExtractedFrame,
  type VideoContextPacket,
  type VideoVisionProvider,
  type VisionAnswer,
} from "./vision.js";

const VISION_SYSTEM = `You are the visual inspector for CUTOS, an agent-first video editor.
You are shown one or more frames from a user-uploaded video plus nearby transcript.
Describe only what is visible. Do NOT identify anyone by name or guess identity.
Describe people by position and appearance, e.g. 「畫面中央的女生」「右側穿黑衣的人」.
Reply with ONLY a JSON object:
{
  "description": string (zh-TW, 1-3 sentences),
  "objects": string[],
  "peopleDescriptions": string[],
  "textSeen": string[],
  "confidence": number
}`;

export interface CompatibleVisionOptions {
  provider: string;
  baseUrl: string;
  apiKey: string;
  catalog: ModelCatalog;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onUsage?: ModelUsageSink;
}

interface RawObservation {
  description?: unknown;
  objects?: unknown;
  peopleDescriptions?: unknown;
  textSeen?: unknown;
  confidence?: unknown;
}

/**
 * OpenAI-compatible multimodal vision provider. Used by Zeabur AI Hub (and any
 * other /v1/chat/completions endpoint that accepts image_url parts).
 */
export class OpenAICompatibleVisionProvider implements VideoVisionProvider {
  readonly name: string;
  readonly configured = true;
  private readonly client: OpenAICompatibleClient;
  private readonly catalog: ModelCatalog;

  constructor(options: CompatibleVisionOptions) {
    this.catalog = options.catalog;
    this.name = `${options.provider}-vision`;
    this.client = new OpenAICompatibleClient({
      provider: options.provider,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      onUsage: options.onUsage,
    });
  }

  inspectFrame(input: {
    frame: ExtractedFrame;
    question?: string;
    context: VideoContextPacket;
  }): Promise<VisionAnswer> {
    return this.run({
      frames: [input.frame],
      question: input.question,
      context: input.context,
      task: "vision_fast",
    });
  }

  inspectTimeRange(input: {
    frames: ExtractedFrame[];
    question?: string;
    context: VideoContextPacket;
  }): Promise<VisionAnswer> {
    return this.run({
      frames: input.frames,
      question: input.question,
      context: input.context,
      task: input.frames.length > 1 ? "vision_strong" : "vision_fast",
    });
  }

  answerQuestion(input: {
    question: string;
    context: VideoContextPacket;
    frames: ExtractedFrame[];
  }): Promise<VisionAnswer> {
    return this.run({
      frames: input.frames,
      question: input.question,
      context: input.context,
      task: input.frames.length > 1 ? "vision_strong" : "vision_fast",
    });
  }

  private async run(input: {
    frames: ExtractedFrame[];
    question?: string;
    context: VideoContextPacket;
    task: "vision_fast" | "vision_strong";
  }): Promise<VisionAnswer> {
    const routed = routeModel(this.catalog, input.task);
    const messages: ChatTurn[] = [
      { role: "system", content: VISION_SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: buildUserText(input.question, input.context, input.frames) },
          ...input.frames.map((frame) => ({
            type: "image_url" as const,
            image_url: { url: frameToDataUrl(frame) },
          })),
        ],
      },
    ];
    const { text, usage } = await this.client.chat({
      model: routed.model,
      messages,
      task: input.task,
      json: true,
      temperature: 0,
    });
    const observation = parseObservation(text, input.frames, input.context.centerMs);
    const message = buildSpokenAnswer(input.question, observation);
    return {
      message,
      observation,
      model: usage.model,
      provider: usage.provider,
      latencyMs: usage.latencyMs,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cost: usage.cost,
    };
  }
}

function buildUserText(
  question: string | undefined,
  context: VideoContextPacket,
  frames: ExtractedFrame[],
): string {
  const transcript = [
    sliceLabel("之前", context.transcriptBefore),
    sliceLabel("現在", context.transcriptCurrent),
    sliceLabel("之後", context.transcriptAfter),
  ]
    .filter(Boolean)
    .join("\n");
  return JSON.stringify({
    question: question ?? "請描述這些畫面在做什麼。",
    centerMs: context.centerMs,
    frameTimesMs: frames.map((f) => f.timeMs),
    speaker: context.speaker,
    topic: context.topic,
    scene: context.scene,
    transcript,
  });
}

function sliceLabel(
  label: string,
  slices: VideoContextPacket["transcriptBefore"],
): string | null {
  if (slices.length === 0) return null;
  return `${label}: ${slices.map((s) => s.text).join(" ")}`;
}

function parseObservation(json: string, frames: ExtractedFrame[], centerMs: number): VisualObservation {
  let raw: RawObservation;
  try {
    raw = JSON.parse(json) as RawObservation;
  } catch {
    throw new MalformedModelResponseError();
  }
  const times = frames.map((f) => f.timeMs).sort((a, b) => a - b);
  const startMs = times[0] ?? centerMs;
  const endMs = times[times.length - 1] ?? centerMs;
  const parsed = VisualObservationSchema.safeParse({
    startMs,
    endMs: Math.max(startMs, endMs),
    description: typeof raw.description === "string" && raw.description.trim() ? raw.description : "畫面內容不清楚。",
    objects: asStringArray(raw.objects),
    peopleDescriptions: asStringArray(raw.peopleDescriptions),
    textSeen: asStringArray(raw.textSeen),
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
    frameRefs: times,
  });
  if (!parsed.success) throw new MalformedModelResponseError();
  return parsed.data;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20);
}

function buildSpokenAnswer(question: string | undefined, observation: VisualObservation): string {
  const asked = question?.includes("看") ?? false;
  const prefix = asked ? "可以。" : "";
  return `${prefix}${observation.description}`.trim();
}
