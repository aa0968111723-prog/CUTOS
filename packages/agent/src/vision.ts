import type { VisualObservation } from "./chat-response.js";

/**
 * A JPEG (or PNG) frame extracted from a project's original media. The vision
 * layer never receives a filesystem path — only project-scoped bytes.
 */
export interface ExtractedFrame {
  timeMs: number;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  data: Uint8Array;
}

export interface ExtractFrameWindowInput {
  projectId: string;
  centerMs: number;
  beforeMs: number;
  afterMs: number;
  samples: number;
}

/**
 * Frame extraction is a server capability, injected into the agent. Callers
 * address media by `projectId` only.
 */
export interface FrameExtractor {
  extractFrame(projectId: string, timeMs: number): Promise<ExtractedFrame>;
  extractFrameWindow(input: ExtractFrameWindowInput): Promise<ExtractedFrame[]>;
}

export interface TranscriptSlice {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string | null;
}

/**
 * Everything a vision model should see for one inspect/question: a handful of
 * frames around the playhead plus nearby transcript and scene metadata. A
 * single still is not enough — it may land on a cut or motion blur.
 */
export interface VideoContextPacket {
  projectId: string;
  centerMs: number;
  frames: ExtractedFrame[];
  transcriptBefore: TranscriptSlice[];
  transcriptCurrent: TranscriptSlice[];
  transcriptAfter: TranscriptSlice[];
  speaker: string | null;
  topic: string | null;
  scene: { startMs: number; endMs: number } | null;
  timelineRevision: number;
}

export interface VisionAnswer {
  message: string;
  observation: VisualObservation;
  model?: string;
  provider?: string;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
}

export interface VideoVisionProvider {
  readonly name: string;
  readonly configured: boolean;
  inspectFrame(input: {
    frame: ExtractedFrame;
    question?: string;
    context: VideoContextPacket;
  }): Promise<VisionAnswer>;
  inspectTimeRange(input: {
    frames: ExtractedFrame[];
    question?: string;
    context: VideoContextPacket;
  }): Promise<VisionAnswer>;
  answerQuestion(input: {
    question: string;
    context: VideoContextPacket;
    frames: ExtractedFrame[];
  }): Promise<VisionAnswer>;
}

export class VisionNotConfiguredError extends Error {
  readonly code = "VISION_NOT_CONFIGURED" as const;
  constructor() {
    super(
      "目前尚未設定影片視覺理解模型，因此我可以依逐字稿與時間軸操作，但還不能直接看懂畫面。",
    );
    this.name = "VisionNotConfiguredError";
  }
}

export class FrameExtractionError extends Error {
  readonly code = "FRAME_EXTRACTION_FAILED" as const;
  constructor(public readonly timeMs: number) {
    super(`我目前無法讀取畫面，你可以重新載入影片後再試一次。`);
    this.name = "FrameExtractionError";
  }
}

export class VisionTimeoutError extends Error {
  readonly code = "VISION_TIMEOUT" as const;
  constructor() {
    super("分析這一幕時超過等待時間。");
    this.name = "VisionTimeoutError";
  }
}

export class MalformedModelResponseError extends Error {
  readonly code = "MALFORMED_MODEL_RESPONSE" as const;
  constructor() {
    super("模型回傳的內容格式不正確，我沒有套用任何修改。請再試一次。");
    this.name = "MalformedModelResponseError";
  }
}

/** Offline stand-in used when no vision provider is configured. */
export class UnavailableVisionProvider implements VideoVisionProvider {
  readonly name = "vision:unavailable";
  readonly configured = false;

  async inspectFrame(): Promise<VisionAnswer> {
    throw new VisionNotConfiguredError();
  }
  async inspectTimeRange(): Promise<VisionAnswer> {
    throw new VisionNotConfiguredError();
  }
  async answerQuestion(): Promise<VisionAnswer> {
    throw new VisionNotConfiguredError();
  }
}

export function frameToDataUrl(frame: ExtractedFrame): string {
  const b64 = Buffer.from(frame.data).toString("base64");
  return `data:${frame.mimeType};base64,${b64}`;
}
