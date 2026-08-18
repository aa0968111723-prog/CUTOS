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

## Monorepo layout

```text
packages/
  edit-dsl/       Zod-validated, versioned Edit DSL v2 (operations, migration, revision-targeting)
  timeline/       Non-destructive timeline engine (transforms, captions/markers, durable undo/redo, sequence)
  media/          FFmpeg adapters + video-intelligence (probe, silence, waveform, transcription, analysis runner)
  agent/          Model-agnostic gateway + agent runtime (ToolRegistry, planner, verifier, approval, AgentRun)
  jobs/           Durable job/worker engine (lifecycle, progress, retry, cancel, stale recovery; Memory + SQLite)
  storage/        Object-storage abstraction (StorageAdapter + LocalStorageAdapter)
  project-store/  Durable persistence (project/timeline/media/analysis/run repositories; Memory + SQLite)
apps/
  web/            Next.js agent-first workspace + API (import → analyze → plan → review → apply → undo → export)
```

The web server persists projects in SQLite (`node:sqlite`), runs analysis/export as durable background
jobs via an in-process worker, stores media through the storage abstraction, and drives editing through the
agent runtime. Projects, timelines, undo/redo history and jobs survive a server restart.

## Development

Requirements: Node.js >= 20, [pnpm](https://pnpm.io), and [FFmpeg](https://ffmpeg.org)
(`ffmpeg` + `ffprobe`) on `PATH`.

```bash
pnpm install            # install workspace dependencies
pnpm dev                # run the web app at http://localhost:3000
pnpm test               # run unit + FFmpeg integration tests
pnpm typecheck          # type-check every package
pnpm lint               # lint the workspace
pnpm build              # production build of the web app
node scripts/benchmark.mjs 10 60   # media pipeline benchmark (add larger seconds to profile long media)
```

Persistence and storage default to a git-ignored `.data/` directory (`CUTOS_DATA_DIR`). Set
`CUTOS_STORE=memory` for an ephemeral store. Analysis/export run as durable jobs; set
`CUTOS_LLM_PROVIDER=openai` (+ `CUTOS_OPENAI_API_KEY`) to route planning through an OpenAI-compatible
endpoint instead of the offline deterministic planner.

The web app runs fully offline by default via the deterministic local planner. To route
planning through an OpenAI-compatible endpoint instead, set `CUTOS_LLM_PROVIDER=openai`,
`CUTOS_OPENAI_API_KEY`, and optionally `CUTOS_OPENAI_BASE_URL` / `CUTOS_OPENAI_MODEL`.
Generated media (sources, samples, exports) is written under a git-ignored `.data/` directory
and never overwrites original source media.
