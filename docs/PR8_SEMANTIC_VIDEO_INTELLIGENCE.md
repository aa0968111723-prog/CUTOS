# PR #8 — Semantic Video Intelligence + Real ASR

## 目標

把 CUTOS 從「能依時間與靜音資訊剪輯」升級成「真正理解影片內容的 Agent-first 剪輯器」。

這一階段不以新增剪輯特效為主，而是建立可持久化、可搜尋、可重用的影片理解層，讓 Agent 能根據逐字稿、說話者、場景、主題與重點做內容導向剪輯。

## 核心流程

```text
Media Asset
  ↓
Video Intelligence Pipeline
  ├─ metadata
  ├─ real ASR
  ├─ word/sentence timestamps
  ├─ speaker diarization
  ├─ scene/shot segmentation
  ├─ topic segmentation
  ├─ highlight scoring
  └─ semantic embeddings/index
  ↓
Persistent Semantic Index
  ↓
Agent Tools
  ├─ search_transcript
  ├─ find_topic
  ├─ find_speaker_segments
  ├─ find_highlights
  └─ inspect_scene
  ↓
Validated Edit Plan
  ↓
Existing Edit DSL / Timeline / Instant Preview / Export
```

## 不可破壞的既有原則

- 使用者介面維持台灣繁體中文（zh-TW）。
- 程式 identifiers、API schema、database fields、domain types 維持英文。
- Agent 不直接修改媒體，也不直接呼叫 FFmpeg。
- 所有剪輯仍須經 Edit DSL 驗證與 Timeline 套用。
- 原始媒體 immutable。
- 分析工作走 durable jobs/workers，不阻塞 request lifecycle。
- Preview 與 Export 仍共享 Timeline semantics。
- 保留 AI-OS inbound/outbound 整合，不建立第二套 Agent 架構。

## P0 — Real ASR

目前 deterministic transcript 可保留為離線 fallback / test provider，但正式能力必須支援真實 ASR provider。

建立或整理：

```ts
interface TranscriptionProvider {
  id: string;
  transcribe(input: TranscriptionInput): Promise<Transcript>;
}
```

Transcript 至少包含：

- language
- durationMs
- segments
- words（provider 支援時）
- confidence（provider 支援時）
- provider/model metadata
- createdAt
- analysisVersion

時間統一使用 integer milliseconds。

中文逐字稿必須正確保存 UTF-8，不可將標點或中文字拆壞。

### Provider 原則

- model-agnostic
- server-side secrets only
- timeout / retry / cancellation
- provider-specific response 不得直接洩漏到 domain
- 可替換 provider
- 無 key 時仍可使用 deterministic fallback，但 UI 必須誠實顯示其不是正式語音辨識

## P0 — Word / Sentence Model

建立 canonical transcript model：

```ts
TranscriptWord
TranscriptSentence
TranscriptSegment
```

至少欄位：

```text
id
startMs
endMs
text
speakerId?
confidence?
```

Sentence segmentation 必須對繁體中文可用，不可只依英文空格與句點。

需處理：

- 中文句號、逗號、問號、驚嘆號
- 無標點 ASR
- 長句切分
- segment 邊界
- word timestamps 缺失時的 fallback

## P0 — Speaker Diarization

建立 provider-neutral diarization layer：

```ts
SpeakerDiarizationProvider
SpeakerTurn
SpeakerProfile
```

第一版至少支援：

- speaker label（SPEAKER_00 / SPEAKER_01 等）
- startMs / endMs
- transcript alignment
- rename speaker in UI

不要宣稱 voice identity recognition；這一階段是「誰在什麼時間講話」的 segmentation。

使用者可在繁中 UI 將 SPEAKER_00 改名為「主持人」、「來賓 A」等。

## P0 — Scene / Shot Segmentation

建立：

```ts
Scene
Shot
VisualSegment
```

至少包含：

- startMs
- endMs
- thumbnail asset reference
- confidence / detector metadata

第一版可以使用 deterministic visual boundary detector / FFmpeg-compatible mechanism；更高階 vision model 必須走 adapter。

分析結果必須可獨立重跑，不需要重新 ASR。

## P0 — Topic Segmentation

根據 transcript 建立：

```ts
TopicSegment
```

至少包含：

- id
- startMs
- endMs
- title
- summary
- keywords
- confidence
- source sentence ids

必須支援繁體中文內容。

Agent 才能理解：

- 「第二個話題」
- 「講到禪定的地方」
- 「把招生那一段縮短」

Topic segmentation 不得直接修改 Timeline。

## P0 — Semantic Search Index

建立獨立 semantic index abstraction：

```ts
SemanticIndex
EmbeddingProvider
SemanticDocument
SemanticSearchResult
```

Index document 可以來自：

- sentence
- transcript segment
- topic
- scene description（未來）

Search result 至少回傳：

- entity type
- entity id
- startMs / endMs
- text/summary
- score

Provider 可替換。

不得把 embedding vendor 細節寫死進 ProjectStore。

第一版允許使用 in-memory cosine search 作測試；正式 persistence 需提供 durable backend 或可重建 index 的 metadata。

## P0 — Highlight Scoring

建立可解釋的 HighlightScore，不要只存一個神祕分數。

至少可以由：

- semantic importance
- novelty
- sentence completeness
- speech energy（若可用）
- topic centrality
- duration suitability

組成。

每個 highlight candidate：

```text
startMs
endMs
score
reasons[]
sourceSentenceIds[]
```

使用者看到的原因需要繁中，例如：

- 「這段包含本段主題的核心結論」
- 「語意完整，適合作為獨立短片片段」

不要顯示 hidden chain-of-thought。

## P0 — Incremental Analysis Pipeline

VideoAnalysis 不可變成一個每次全部重跑的大函式。

建立 stage-based pipeline：

```text
probe
waveform
silence
transcript
diarization
sentences
shots
topics
embeddings
highlights
```

每個 stage：

- own version
- own cache key
- dependencies
- status
- startedAt / completedAt
- provider metadata
- error

例如 transcript 重新跑，不應強制重新 probe/waveform。

## P0 — Durable Persistence

AnalysisRepository 必須能保存新的 semantic entities。

至少：

- transcript
- sentences
- speakers
- speaker turns
- scenes/shots
- topics
- highlights
- index metadata

Server restart 後必須存在。

Schema migration 必須向後相容 PR #3～#7 的既有 project DB。

## P0 — Agent Tools

新增 typed tools：

```text
search_transcript
find_topic
find_speaker_segments
find_highlights
inspect_scene
get_transcript_context
```

所有 tool：

- Zod/runtime validated
- permission-aware
- traceable
- persisted in AgentRun
- bounded result size

### search_transcript

輸入自然語言 query，回傳最相關片段與 timestamps。

### find_topic

例如：

```text
query: "禪定"
```

回 topic segments。

### find_speaker_segments

例如：

```text
speakerId: "speaker-1"
```

回該說話者 segments。

### find_highlights

支援：

```text
count
targetDurationMs?
minScore?
```

## P0 — Agent Context Builder

Agent 不可把整支 60 分鐘逐字稿一次塞進 prompt。

ContextBuilder 必須：

1. 判斷 user intent。
2. 使用 semantic tools/search 找相關範圍。
3. 只取 bounded context。
4. 產生 Edit Plan。

需要 token/context budget abstraction。

這是長影片可用性的核心。

## P0 — 中文內容理解

至少驗證這些指令：

```text
把重複講的地方刪掉
找出講到禪定的所有片段
只留下主持人說話的地方
保留最重要的 90 秒
找三段最適合做短影音的內容
把第二個話題剪短一點
找出提到淡江大學的地方
```

Deterministic planner 不必假裝能完成所有高階語意任務；不支援時要明確回報需要 semantic provider / analysis，而不是亂剪。

## P0 — Transcript / Intelligence UI（全繁中）

新增影片理解面板，但避免 UI 資訊爆炸。

建議：

- 「逐字稿」
- 「說話者」
- 「主題」
- 「重點片段」
- 「搜尋影片內容」

逐字稿支援：

- 點句子 → Preview seek
- 顯示時間
- 顯示 speaker
- 搜尋
- highlight matched text

說話者：

- speaker label
- rename
- duration summary

主題：

- title
- time range
- summary
- 點擊跳轉

重點片段：

- score/reason
- preview
- 「交給 CUTOS 助手剪輯」

所有 user-facing copy 保持 zh-TW。

## P1 — Transcript ↔ Timeline ↔ Preview Sync

點逐字稿句子：

```text
Preview seek
Timeline playhead sync
```

播放器播放：

```text
current sentence highlight
current topic highlight
```

不要每 frame rerender 整個 transcript list；使用 virtualization / bounded updates。

## P1 — Search UX

搜尋框：

```text
搜尋影片內容…
```

支援 literal + semantic search。

例如：「改變自己」即使逐字稿出現近義說法，也可由 semantic search 找到。

結果顯示：

- timestamp
- sentence/topic
- relevance
- speaker
- preview button

## P1 — Worker / Job UX

分析 Job 顯示 stage progress：

```text
正在辨識語音…
正在分辨說話者…
正在分析場景…
正在整理主題…
正在建立影片索引…
正在找出重點片段…
```

允許：

- cancel
- retry failed stage
- resume

不得只顯示「分析中」。

## P1 — AI-OS Integration

既有 AI-OS bridge 不重寫。

擴充 outbound manifest capabilities：

```text
get_transcript
search_transcript
list_topics
find_highlights
list_speakers
```

Inbound AiosPlanner 可使用新的 semantic context，但仍透過既有 gateway / Edit DSL。

AI-OS kernel 不可取得 arbitrary local path。

## P1 — Privacy / Security

Transcript 可能包含敏感內容。

至少：

- provider upload 明確 server-side
- secrets 不送 browser
- logs 不記錄整份 transcript
- debug log 截斷文字內容
- project deletion 刪除 transcript/index metadata
- external provider errors sanitized

## P1 — Performance

長影片是本 PR 必須考慮的情境。

至少 benchmark：

- 1 min
- 10 min
- 30 min
- 60 min

測量：

- transcript ingestion
- sentence segmentation
- topic segmentation
- index build
- semantic search latency
- Agent context retrieval

Search 不得每次線性掃描整個 raw transcript（正式 backend）。

## Testing

現有測試不可 regression。

新增：

### Transcript

- Traditional Chinese text
- timestamps
- missing word timestamps fallback
- sentence segmentation
- provider failure
- cancellation

### Diarization

- overlapping/boundary cases
- transcript alignment
- speaker rename persistence

### Topics

- stable time ranges
- source sentence mapping
- Chinese topics

### Semantic Index

- add/update/delete
- search ranking
- persistence/rebuild
- bounded results

### Highlights

- deterministic scoring inputs
- complete time ranges
- reason output

### Agent tools

- search transcript
- topic lookup
- speaker lookup
- highlight lookup
- invalid schema
- permission validation

### Persistence

- restart recovery
- schema migration from pre-PR8 DB

### E2E

```text
匯入一支包含多段中文語音的測試影片
→ 真實/fixture ASR adapter
→ 逐字稿
→ 主題
→ semantic search
→ 輸入「找出講到 X 的地方」
→ Agent 取得正確 context
→ 產生 Edit Plan
→ Review
→ Apply
→ Instant Preview
→ Undo/Redo
→ Export
```

## Definition of Done

PR #8 至少：

- production-shaped real ASR adapter 可用
- deterministic fallback 保留但不冒充真實 ASR
- zh-TW sentence segmentation
- canonical transcript model
- durable transcript persistence
- speaker diarization abstraction + usable implementation/provider path
- scene/shot segmentation foundation
- topic segmentation
- semantic search index
- highlight candidates + reasons
- typed Agent semantic tools
- bounded ContextBuilder
- transcript/topic/highlight UI 全繁中
- transcript ↔ preview seek
- stage-level job progress
- AI-OS capabilities 擴充
- existing instant preview/export path 不壞
- existing 131+ tests 全過
- 新測試完整
- lint clean
- typecheck clean
- build clean

## 暫不納入

- auto reframe
- Shorts auto-generation final workflow
- face tracking
- generative B-roll
- multi-cam
- advanced color grading
- plugin marketplace
- team collaboration

這些留給後續 PR。

## 下一階段

PR #9 建議：**AI Shorts + Auto Reframe + Hook/Highlight Assembly**。
