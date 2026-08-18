# CUTOS

**Agent-first conversational video editor** — 對話式 AI 代理優先的快速剪輯系統，可接 AI-OS / OpenAI-compatible agents。

CUTOS 的核心不是複製傳統剪輯器，而是讓使用者以自然語言描述剪輯意圖，由 Agent 產生可檢查、可驗證、可復原的 Edit Plan，再透過非破壞式 Timeline 與 FFmpeg 執行。

## Product direction

```text
Import Video
    ↓
Analyze
    ↓
Chat / Agent
    ↓
Edit Plan (validated DSL)
    ↓
Review
    ↓
Non-destructive Timeline
    ↓
Preview / Undo
    ↓
Export
```

## Core principles

- Agent-first UX
- Semantic timeline
- Model-agnostic provider layer
- Non-destructive editing
- Reversible and inspectable AI operations
- Cached video intelligence instead of re-analyzing the same media repeatedly
- Worker-based analysis and rendering
- Mobile: agent + preview + review first
- Desktop: agent + full semantic timeline

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — core architecture and vertical slice
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased implementation roadmap
- [`AGENTS.md`](AGENTS.md) — rules and guardrails for coding agents

## First milestone

The first reliable vertical slice is intentionally narrow:

1. Import one video.
2. Generate metadata/proxy.
3. Transcribe speech and detect silence.
4. Ask the agent to remove long pauses.
5. Produce and validate an Edit Plan.
6. Review planned changes.
7. Apply them non-destructively.
8. Preview and undo/reapply.
9. Export with FFmpeg.

Advanced effects, collaboration, generative B-roll and plugin ecosystems should come after this path is reliable.
