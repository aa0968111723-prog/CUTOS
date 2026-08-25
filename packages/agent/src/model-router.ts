/**
 * Route each agent task to the cheapest sufficient model. Every model still
 * goes through the configured provider (Zeabur AI Hub, OpenAI, …); this file
 * does not bind CUTOS to a vendor.
 */

export type ModelTask = "intent" | "vision_fast" | "vision_strong" | "planning";

export interface RoutedModel {
  provider: string;
  model: string;
  task: ModelTask;
}

export interface ModelCatalog {
  provider: string;
  fastModel: string;
  visionModel: string;
  reasoningModel: string;
}

export interface ModelUsage {
  provider: string;
  model: string;
  task: ModelTask;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Present only when the upstream response exposes a cost signal. */
  cost?: number;
}

export type ModelUsageSink = (usage: ModelUsage) => void;

const MULTIMODAL_HINT = /gpt-4o|gpt-4\.1|claude|gemini|qwen-vl|vision/i;

export function routeModel(catalog: ModelCatalog, task: ModelTask): RoutedModel {
  switch (task) {
    case "intent":
      return { provider: catalog.provider, model: catalog.fastModel, task };
    case "vision_fast":
      return { provider: catalog.provider, model: catalog.visionModel, task };
    case "vision_strong":
      return {
        provider: catalog.provider,
        model: MULTIMODAL_HINT.test(catalog.reasoningModel)
          ? catalog.reasoningModel
          : catalog.visionModel,
        task,
      };
    case "planning":
      return { provider: catalog.provider, model: catalog.reasoningModel, task };
  }
}

/** Drop any value that looks like a secret before logging usage. */
export function redactUsage(usage: ModelUsage): ModelUsage {
  return { ...usage };
}
