# CUTOS Roadmap

## Phase 0 — Foundation

- Monorepo/tooling baseline
- TypeScript strict mode
- Shared domain types
- Edit DSL schema + validation
- Project/media/timeline persistence model
- Background job abstraction
- Basic observability and error boundaries
- CI for lint, typecheck and tests

## Phase 1 — Reliable agent editing vertical slice

Goal: natural-language pause removal from import to export.

- Video import
- Metadata extraction
- Proxy generation
- Waveform/thumbnails
- Transcription
- Silence detection
- Agent request -> Edit Plan
- Edit Plan validation
- Non-destructive timeline operations
- Review changes before apply
- Undo/redo
- FFmpeg export
- Automated verification of output duration and media integrity

## Phase 1.5 — Instant Preview + zh-TW productization

Goal: make CUTOS feel like a real conversational editor by showing edited results immediately, without requiring a full FFmpeg render for every change, while making the entire user-facing product experience Traditional Chinese (Taiwan).

- Shared Timeline semantics for preview and export
- Preview compiler + preview manifest
- Source time ↔ edited timeline time mapping
- Instant preview for trim / split / delete / silence removal / speed
- Caption overlay preview
- Timeline seek ↔ player sync
- Undo / redo updates preview immediately
- Preview / export parity tests
- Progressive enhancement with HTMLVideoElement / MediaSource / WebCodecs
- Full zh-TW UI copy for project, agent, timeline, jobs, review and export
- Chinese Agent Activity states without exposing hidden chain-of-thought
- Chinese validation, empty, loading, error and success states
- Agent-first mobile layout with timeline as a secondary surface

Detailed specification: [`PR4_INSTANT_PREVIEW_ZH_TW.md`](PR4_INSTANT_PREVIEW_ZH_TW.md)

## Phase 2 — Semantic editing

- Speaker diarization
- Scene/shot segmentation
- Topic segmentation
- Highlight scoring
- Search video by meaning
- Commands such as:
  - "remove repeated explanations"
  - "keep the strongest answer"
  - "make this section faster"
  - "find all mentions of X"

## Phase 3 — Short-form creation

- 9:16 reframing
- Auto captions
- Hook detection
- Multi-clip highlight selection
- Caption emphasis
- Safe auto-crop / face tracking
- YouTube Shorts / Reels / TikTok export presets

## Phase 4 — Production agent mode

- Multi-step autonomous plans
- Batch deliverables from one source video
- Plan progress UI
- Approval gates for destructive/high-impact actions
- Tool-result verification
- Recovery/resume for interrupted jobs

Example goal:

> Turn this 45-minute interview into one 8-minute YouTube cut, three 60-second shorts, captions, chapters and five thumbnail candidates while preserving the speaker's meaning.

## Phase 5 — Ecosystem

- AI-OS integration
- OpenAI-compatible agent adapter
- External model/provider adapters
- MCP/tool bridge where useful
- Team review and comments
- Template/preset system
- Plugin SDK only after the editing core is stable

## UX priorities

### Mobile

Agent + preview + review cards first. Avoid exposing a dense desktop timeline as the default interaction.

### Tablet

Agent-first by default with an optional simplified timeline.

### Desktop

Agent workspace plus full semantic timeline and precision editing controls.

## Quality gates

A feature is not complete unless:

- edits are reversible;
- original media is untouched;
- loading/error/empty states exist;
- keyboard and touch behavior are considered;
- long work is not performed synchronously in the UI request path;
- the agent action is deterministic enough to replay from its Edit Plan;
- a user can inspect what the agent intends to change before applying high-impact edits.
