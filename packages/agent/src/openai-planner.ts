import type { Planner, PlanRequest, ProposedEdits } from "./types.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injectable for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT = `You are the planning engine for CUTOS, an agent-first video editor.
Convert the user's request into edit operations for a non-destructive timeline.
Only respond with a JSON object of the form:
{"summary": string, "operations": Operation[]}
where Operation is one of:
  {"type":"removeRange","startMs":int,"endMs":int,"reason"?:string}
  {"type":"setSpeed","startMs":int,"endMs":int,"speed":number,"reason"?:string}
All times are integer milliseconds in the ORIGINAL source. Never exceed the source duration.
Use the provided detected silence intervals when removing pauses. Do not include prose outside the JSON.`;

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
    this.name = `openai-compatible:${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async propose(request: PlanRequest): Promise<ProposedEdits> {
    const userContent = JSON.stringify({
      instruction: request.instruction,
      sourceDurationMs: request.sourceDurationMs,
      silences: request.silences,
    });

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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
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

    const parsed = JSON.parse(content) as ProposedEdits;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "Proposed edits",
      operations: Array.isArray(parsed.operations) ? parsed.operations : [],
    };
  }
}
