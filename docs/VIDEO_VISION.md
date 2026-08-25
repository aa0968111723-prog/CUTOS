# Conversational video vision

CUTOS can look at a time point, answer a question about the picture, and only then
propose an Edit Plan. Chat answers and edit plans are different objects.

## Flow

```text
User: 「0:25 那邊你看得到嗎？」
  → Intent Router: inspect_time + ask_video_question
  → extractFrameWindow(24.0, 24.5, 25.0, 25.5, 26.0)
  → VideoContextPacket (frames + nearby transcript + scene)
  → Zeabur AI Hub vision model
  → ChatAnswer + VisualObservation (no Edit Plan)

User: 「好，就從這裡開始。」
  → conversation grounding (this = 25s observation)
  → trim startMs = 25000
  → Edit DSL + revision guard + review + instant preview
```

Only `edit` intent requires `EditPlan.operations.length >= 1`. Zod validation
errors are never shown in chat.

## Provider

Zeabur AI Hub is an OpenAI-compatible endpoint. Configure it with
`CUTOS_AI_PROVIDER=zeabur` and `CUTOS_ZEABUR_AI_API_KEY` (server-side only).
The default base URL is `https://hnd1.aihub.zeabur.ai/v1` and can be overridden.

Model routing:

| Task | Model env |
| --- | --- |
| Intent classification (heuristic first) | `CUTOS_ZEABUR_FAST_MODEL` |
| Single-frame / time inspect | `CUTOS_ZEABUR_VISION_MODEL` |
| Multi-frame question | vision, or reasoning if that model is multimodal |
| Complex edit planning | `CUTOS_ZEABUR_REASONING_MODEL` |

Usage (provider, model, latency, tokens, cost if the gateway exposes it) is
logged. API keys are never logged.

## Addressing media

Frame extraction accepts `projectId` / `MediaAsset` only. Arbitrary filesystem
paths are rejected. Stills are cached by `projectId + media checksum + timeMs + resolution`.
