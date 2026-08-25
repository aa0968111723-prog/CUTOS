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

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — production deployment checklist, health/version endpoints, and how to prove which build is live
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
pnpm smoke <url>        # real end-to-end smoke test against a running deployment
node scripts/benchmark.mjs 10 60   # media pipeline benchmark (add larger seconds to profile long media)
```

Persistence and storage default to a git-ignored `.data/` directory (`CUTOS_DATA_DIR`). Set
`CUTOS_STORE=memory` for an ephemeral store. Analysis/export run as durable jobs; set
`CUTOS_LLM_PROVIDER=openai` (+ `CUTOS_OPENAI_API_KEY`) to route planning through an OpenAI-compatible
endpoint instead of the offline deterministic planner.

### Operating a deployment

Three endpoints exist so a running deployment can be asked what it is and whether
it works, rather than inferred from a dashboard:

| Endpoint | Answers |
| --- | --- |
| `GET /api/version` | Which commit, branch, build time and upload-protocol version is running. |
| `GET /api/health` | Every subsystem — `app`, `dataDirWritable`, `database`, `storage`, `uploadSubsystem`, `jobWorker`, `ffprobe`, `ffmpeg` — with a reason and a remedy for anything unhealthy. |
| `GET /api/ready` | 200 only when the deployment can genuinely accept video work; 503 otherwise. |

The same report is available in the UI behind the **系統狀態** button in the header.
The server also validates all of this at boot and logs each failure with its cause
and its fix; it never exits, because a process that will not start cannot serve the
endpoint you need to find out why.

`pnpm smoke <url>` runs the whole thing for real against any deployment — it uploads
an actual video in chunks, finalizes it, waits for the probe, and asks for a byte
range the way a `<video>` element does. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Media upload

Video is uploaded in bounded, resumable chunks and probed by a background job, so no request
ever carries (or buffers) a whole file. Two limits, deliberately separate:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CUTOS_MAX_UPLOAD_BYTES` | 500 MB | Largest **file** a user may upload. |
| `CUTOS_MAX_REQUEST_BYTES` | 8 MB | Largest **single HTTP body**; keep it under the deployment's ingress limit. |
| `CUTOS_UPLOAD_CHUNK_BYTES` | 5 MB | Chunk size sent to the browser (clamped to the request limit). |
| `CUTOS_UPLOAD_SESSION_TTL_MS` | 6 h | How long an unfinished upload survives before it is swept. |

Deploying behind a proxy (Zeabur, nginx, Cloudflare) means tuning `CUTOS_MAX_REQUEST_BYTES`,
not the file limit. See [`docs/MEDIA_INGRESS.md`](docs/MEDIA_INGRESS.md).

The web app runs fully offline by default via the deterministic local planner. To route
planning through an OpenAI-compatible endpoint instead, set `CUTOS_LLM_PROVIDER=openai`,
`CUTOS_OPENAI_API_KEY`, and optionally `CUTOS_OPENAI_BASE_URL` / `CUTOS_OPENAI_MODEL`.

### Zeabur AI Hub (video vision)

CUTOS can **look at frames**, answer questions about a time point, then turn that
grounding into an Edit Plan. This is not a base-URL swap: questions never go through
the Edit Planner, and the API key stays on the server.

```bash
CUTOS_AI_PROVIDER=zeabur
CUTOS_ZEABUR_AI_API_KEY=...          # server-side only
CUTOS_ZEABUR_AI_BASE_URL=https://hnd1.aihub.zeabur.ai/v1   # optional override
CUTOS_ZEABUR_FAST_MODEL=gpt-4o-mini
CUTOS_ZEABUR_VISION_MODEL=gpt-4o-mini
CUTOS_ZEABUR_REASONING_MODEL=gpt-4o
```

`CUTOS_AI_PROVIDER` takes precedence over `CUTOS_LLM_PROVIDER`. OpenAI, AIOS and the
local planner keep working. See [`docs/VIDEO_VISION.md`](docs/VIDEO_VISION.md).

### AI‑OS (AIOS) integration

CUTOS integrates bidirectionally with [AIOS](https://github.com/agiresearch/AIOS): use an AIOS
kernel as the planning brain (`CUTOS_LLM_PROVIDER=aios` + `CUTOS_AIOS_KERNEL_URL`), and let an AIOS
agent drive CUTOS through a capability bridge (`GET /api/aios/manifest`, `POST /api/aios/invoke`).
See [`docs/AIOS_INTEGRATION.md`](docs/AIOS_INTEGRATION.md).
Generated media (sources, samples, exports) is written under a git-ignored `.data/` directory
and never overwrites original source media.
