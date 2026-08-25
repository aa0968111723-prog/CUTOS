import { z } from "zod";
import { SuggestedActionSchema } from "@cutos/agent";
import { plan } from "../../../../../server/editor-service.js";
import { errorResponse, handleError, json } from "../../../../../server/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  instruction: z.string().min(1).max(2000),
  playheadMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1000).optional(),
  selectedRange: z
    .object({
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().nonnegative(),
    })
    .optional(),
  previewMode: z.enum(["edited", "original"]).optional(),
  timelineRevision: z.number().int().nonnegative().optional(),
  action: SuggestedActionSchema.optional(),
});

/**
 * Conversational turn: inspect a time / answer a video question / produce a
 * validated Edit Plan. Playback fields are validated server-side so "這裡"
 * is never guessed by the model.
 */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  try {
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return errorResponse(400, "VALIDATION_FAILED", "An instruction is required.");
    const { instruction, playheadMs, selectedRange, previewMode, timelineRevision, action } = parsed.data;
    const result = await plan(
      ctx.params.id,
      instruction,
      { playheadMs, selectedRange, previewMode, timelineRevision },
      action,
    );
    return json(result);
  } catch (error) {
    return handleError(error);
  }
}
