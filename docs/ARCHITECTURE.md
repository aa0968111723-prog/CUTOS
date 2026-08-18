# CUTOS Architecture

CUTOS is an agent-first conversational video editor. The core product principle is simple: users express editing intent in natural language, CUTOS converts that intent into safe, inspectable edit operations, and the timeline remains a review and precision surface rather than the primary interface.

## Core flow

Import -> Analyze -> Converse -> Plan -> Preview -> Execute -> Verify -> Export

## Architecture layers

1. **Experience layer**
   - Web/desktop shell
   - Conversational editing UI
   - Preview player
   - Review cards
   - Semantic timeline

2. **Agent orchestration layer**
   - Model-agnostic provider gateway
   - Tool calling
   - Planning/execution loop
   - Guardrails and approval policy
   - Retry and verification

3. **Edit Intent / DSL layer**
   - Canonical schema for edit operations
   - Validation before execution
   - Reversible operations
   - Versioned schema

4. **Timeline engine**
   - Non-destructive edit graph
   - Clips, tracks, ranges, markers, captions, transitions
   - Undo/redo and version branches

5. **Video intelligence layer**
   - Speech transcription
   - Speaker diarization
   - Scene/shot segmentation
   - OCR and visual understanding
   - Silence/music/audio analysis
   - Topic, emotion and highlight scoring
   - Semantic index over media

6. **Media/render layer**
   - Proxy generation
   - Waveforms/thumbnails
   - FFmpeg render workers
   - WebCodecs-assisted preview where appropriate
   - Export presets and quality verification

## Non-negotiable principles

- Agent output never directly mutates media; it must pass through the Edit DSL.
- Every agent edit is inspectable and reversible.
- Original media is immutable.
- Long-running analysis/rendering is done by workers, not request handlers.
- The core is model-agnostic and supports OpenAI-compatible providers and AI-OS integration.
- Mobile UX is agent-first; desktop can expose the full timeline.
- Analysis results are cached and indexed so the same video is not repeatedly re-understood from scratch.

## Suggested monorepo shape

```text
CUTOS/
  apps/
    web/
    desktop/
  packages/
    ui/
    edit-dsl/
    timeline/
    media/
    player/
    agent-sdk/
    shared/
  services/
    agent/
    transcription/
    video-analysis/
    render/
    asset-index/
  workers/
    ffmpeg/
    proxy/
    thumbnail/
    ai-analysis/
```

## First vertical slice

The first implementation milestone should support one reliable flow end-to-end:

1. Import one local video.
2. Create proxy + metadata.
3. Transcribe speech and detect silence.
4. Ask the agent to remove long pauses.
5. Produce an Edit Plan in the canonical DSL.
6. Show a human-readable preview of planned changes.
7. Apply changes non-destructively to the timeline.
8. Preview result.
9. Undo/reapply.
10. Export via FFmpeg.

Do not expand to advanced effects, collaboration, multi-cam, color grading, generative B-roll, or plugin ecosystems until this slice is stable.
