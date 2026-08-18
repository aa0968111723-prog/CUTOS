# CUTOS Agent Engineering Guide

This repository is building an agent-first conversational video editor. Coding agents should optimize for a reliable end-to-end editing loop before feature breadth.

## Product invariant

Natural language is the primary editing interface. The timeline is a review/precision surface. Every AI edit must be represented as validated, non-destructive, reversible operations before it can affect the project state.

## Engineering rules

- Keep domain logic out of UI components.
- Never let model output directly call FFmpeg or mutate timeline state without schema validation.
- Original source media is immutable.
- Every edit operation must have enough information to undo/replay.
- Prefer explicit types and schemas over loosely structured JSON.
- Long-running media analysis/render work belongs in jobs/workers.
- Add tests for Edit DSL validation and timeline transforms before expanding AI features.
- Keep provider integrations behind an adapter/gateway.
- Do not hard-code CUTOS to one LLM vendor.
- Mobile UX must remain agent-first and usable without a desktop-style dense timeline.

## Initial implementation target

Build the smallest production-shaped vertical slice:

Import video -> analyze/transcribe -> detect silence -> agent produces Edit Plan -> user reviews -> timeline applies operations -> preview -> undo -> FFmpeg export.

## Preferred stack direction

- TypeScript
- React / Next.js for web UX
- Shared packages in a monorepo
- Zod or equivalent runtime schema validation for the Edit DSL
- FFmpeg for deterministic render/export
- WebCodecs where useful for interactive preview
- PostgreSQL-compatible persistence for durable project metadata
- Object storage abstraction for source/proxy/output media
- Queue/worker abstraction for analysis and rendering

Exact infrastructure choices may evolve; preserve the architecture boundaries above.

## Definition of done for each implementation PR

- focused scope;
- types and validation included;
- relevant tests included;
- loading/error/empty states handled where UI is touched;
- no destructive media mutation;
- docs updated when domain behavior changes;
- lint/typecheck/tests pass or blockers are documented precisely.
