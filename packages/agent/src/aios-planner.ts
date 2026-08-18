import type { Planner, PlanRequest, ProposedEdits } from "./types.js";
import {
  PLANNING_SYSTEM_PROMPT,
  buildPlanningUserContent,
  parseProposedEdits,
} from "./planning-prompt.js";

/**
 * Configuration for connecting CUTOS to an AIOS (agiresearch/AIOS) kernel.
 * API keys for the underlying model live in the AIOS kernel's own config, so
 * they are not required here — CUTOS only needs to reach the kernel.
 */
export interface AiosPlannerOptions {
  /** AIOS kernel base URL, e.g. http://localhost:8000 */
  kernelUrl: string;
  /** LLM Core query path on the kernel. */
  queryPath?: string;
  /** Model name registered in the AIOS kernel (e.g. gpt-4o-mini). */
  model: string;
  /** AIOS backend for the model (e.g. openai, anthropic, ollama, vllm). */
  backend: string;
  /** Agent name presented to the kernel. */
  agentName?: string;
  /** Optional bearer token if the kernel is protected. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** AIOS LLM Core API request shape (see docs.aios.foundation LLM Core API). */
interface LlmQuery {
  llms: { name: string; backend: string }[];
  messages: { role: string; content: string }[];
  action_type: "chat" | "tool_use" | "operate_file";
  message_return_type: "text" | "json";
  response_format?: Record<string, unknown>;
}

/** AIOS LLM Core API response shape. */
interface LlmResponse {
  response_message?: string | null;
  tool_calls?: unknown[] | null;
  finished?: boolean;
  error?: string | null;
  status_code?: number;
}

/**
 * Planner backed by an AIOS kernel via its documented LLM Core API
 * (`LLMQuery` → `LLMResponse`). Implements the same {@link Planner} contract as
 * every other adapter, so CUTOS stays model-agnostic and the gateway still
 * validates all output before it can affect project state.
 */
export class AiosPlanner implements Planner {
  readonly name: string;
  private readonly options: AiosPlannerOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(options: AiosPlannerOptions) {
    this.options = options;
    this.name = `aios:${options.model}@${options.backend}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const path = options.queryPath ?? "/query";
    this.endpoint = `${options.kernelUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async propose(request: PlanRequest): Promise<ProposedEdits> {
    const query: LlmQuery = {
      llms: [{ name: this.options.model, backend: this.options.backend }],
      messages: [
        { role: "system", content: PLANNING_SYSTEM_PROMPT },
        { role: "user", content: buildPlanningUserContent(request) },
      ],
      action_type: "chat",
      message_return_type: "json",
      response_format: { type: "json_object" },
    };

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent_name: this.options.agentName ?? "cutos",
        query_type: "llm",
        query: query,
      }),
    });

    if (!response.ok) {
      throw new Error(`AIOS kernel request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as LlmResponse;
    if (data.error) throw new Error(`AIOS kernel error: ${data.error}`);
    const message = data.response_message;
    if (!message) throw new Error("AIOS kernel returned an empty response.");

    return parseProposedEdits(message);
  }
}
