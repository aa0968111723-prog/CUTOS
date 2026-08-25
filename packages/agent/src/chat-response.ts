import { z } from "zod";

/**
 * Conversation responses are distinct from Edit Plans. A question about a
 * frame must never be wrapped in an empty plan just to satisfy
 * `operations.min(1)`.
 */

export const SuggestedActionSchema = z.object({
  type: z.enum([
    "trim_from",
    "keep_scene",
    "inspect_window",
    "seek",
    "retry_inspect",
    "ask_current",
  ]),
  label: z.string().min(1).max(80),
  atMs: z.number().int().nonnegative().optional(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
  centerMs: z.number().int().nonnegative().optional(),
  beforeMs: z.number().int().nonnegative().optional(),
  afterMs: z.number().int().nonnegative().optional(),
});
export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;

export const FrameCardSchema = z.object({
  timeMs: z.number().int().nonnegative(),
  description: z.string().max(500).optional(),
});
export type FrameCard = z.infer<typeof FrameCardSchema>;

export const VisualObservationSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  description: z.string().min(1).max(2000),
  objects: z.array(z.string().max(80)).max(40),
  /** Appearance / position only — never a guessed identity. */
  peopleDescriptions: z.array(z.string().max(120)).max(20),
  textSeen: z.array(z.string().max(200)).max(20),
  confidence: z.number().min(0).max(1),
  frameRefs: z.array(z.number().int().nonnegative()).max(16),
});
export type VisualObservation = z.infer<typeof VisualObservationSchema>;

export const ChatAnswerSchema = z.object({
  type: z.literal("answer"),
  message: z.string().min(1).max(4000),
  grounding: VisualObservationSchema.optional(),
  suggestedActions: z.array(SuggestedActionSchema).max(8).default([]),
  frames: z.array(FrameCardSchema).max(8).default([]),
});
export type ChatAnswer = z.infer<typeof ChatAnswerSchema>;

export const EditProposalSchema = z.object({
  type: z.literal("edit_plan"),
  message: z.string().min(1).max(4000),
  planId: z.string().min(1),
});
export type EditProposal = z.infer<typeof EditProposalSchema>;

export const ClarificationSchema = z.object({
  type: z.literal("question"),
  message: z.string().min(1).max(4000),
  options: z.array(z.string().max(80)).max(8).optional(),
});
export type Clarification = z.infer<typeof ClarificationSchema>;

export const AgentTurnSchema = z.discriminatedUnion("type", [
  ChatAnswerSchema,
  EditProposalSchema,
  ClarificationSchema,
]);
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

export function answerTurn(
  message: string,
  extra: Partial<Omit<ChatAnswer, "type" | "message">> = {},
): ChatAnswer {
  return ChatAnswerSchema.parse({
    type: "answer",
    message,
    grounding: extra.grounding,
    suggestedActions: extra.suggestedActions ?? [],
    frames: extra.frames ?? [],
  });
}

export function questionTurn(message: string, options?: string[]): Clarification {
  return ClarificationSchema.parse({ type: "question", message, options });
}

export function editTurn(message: string, planId: string): EditProposal {
  return EditProposalSchema.parse({ type: "edit_plan", message, planId });
}
