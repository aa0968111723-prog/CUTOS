import type { ModelTask, ModelUsage, ModelUsageSink } from "./model-router.js";
import { MalformedModelResponseError, VisionTimeoutError } from "./vision.js";

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ChatContent = string | Array<ChatTextPart | ChatImagePart>;

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export interface ModelClientOptions {
  provider: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onUsage?: ModelUsageSink;
}

interface CompletionsResponse {
  choices?: { message?: { content?: string | Array<{ type?: string; text?: string }> } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
}

/**
 * OpenAI-compatible chat client used by Zeabur AI Hub, OpenAI, and local
 * gateways. The API key stays on the server; it is never copied into logs,
 * errors, or return values.
 */
export class OpenAICompatibleClient {
  private readonly provider: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onUsage?: ModelUsageSink;

  constructor(options: ModelClientOptions) {
    this.provider = options.provider;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.onUsage = options.onUsage;
  }

  async chat(input: {
    model: string;
    messages: ChatTurn[];
    task: ModelTask;
    json?: boolean;
    temperature?: number;
  }): Promise<{ text: string; usage: ModelUsage }> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: input.model,
          temperature: input.temperature ?? 0,
          ...(input.json ? { response_format: { type: "json_object" } } : {}),
          messages: input.messages,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new VisionTimeoutError();
      throw error;
    }
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`Provider request failed: ${response.status}`);
    }

    const costHeader =
      response.headers.get("x-request-cost") ??
      response.headers.get("x-litellm-response-cost") ??
      response.headers.get("x-groq-cost");

    let data: CompletionsResponse;
    try {
      data = (await response.json()) as CompletionsResponse;
    } catch {
      throw new MalformedModelResponseError();
    }

    const text = extractText(data);
    if (!text) throw new MalformedModelResponseError();

    const usage: ModelUsage = {
      provider: this.provider,
      model: data.model ?? input.model,
      task: input.task,
      latencyMs: Date.now() - started,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
      cost: costHeader ? Number.parseFloat(costHeader) : undefined,
    };
    this.onUsage?.(usage);
    return { text, usage };
  }
}

function extractText(data: CompletionsResponse): string | null {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part.text ?? "").join("") || null;
  }
  return null;
}
