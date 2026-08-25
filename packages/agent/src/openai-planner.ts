import type { Planner, PlanRequest, ProposedEdits } from "./types.js";
import {
  PLANNING_SYSTEM_PROMPT,
  buildPlanningUserContent,
  parseProposedEdits,
} from "./planning-prompt.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Override the planner name (e.g. `zeabur:gpt-4o`). */
  name?: string;
  /** Injectable for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Adapter for any OpenAI-compatible chat completions endpoint (OpenAI, AI-OS,
 * local gateways, etc.). It implements the same {@link Planner} contract as the
 * local planner, keeping provider integrations behind a single boundary so
 * CUTOS is not hard-coded to one vendor. The gateway still validates all
 * output before it can affect project state.
 */
export class OpenAICompatiblePlanner implements Planner {
  readonly name: string;
  private readonly options: OpenAICompatibleOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
    this.name = options.name ?? `openai-compatible:${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async propose(request: PlanRequest): Promise<ProposedEdits> {
    const response = await this.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PLANNING_SYSTEM_PROMPT },
          { role: "user", content: buildPlanningUserContent(request) },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Provider request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Provider returned an empty completion.");
    }
    return parseProposedEdits(content);
  }
}
