# PR #9 — AIOS-Native Orchestration for CUTOS

## 目標

把 CUTOS 與 AIOS 的關係從「LLM provider + HTTP capability bridge」提升成真正的 **AIOS Control Plane + CUTOS Editing Data Plane**。

AIOS 負責 Agent 排程、Context、Memory、Tool governance、模型資源路由與長任務協調；CUTOS 繼續掌握 Project、Media、Semantic Index、Edit DSL、Timeline、Preview、Render 的唯一真實狀態。

```text
User / AIOS Agent
      ↓
AIOS Kernel / Cerebrum
  ├─ Scheduler
  ├─ Context Manager
  ├─ Memory Manager
  ├─ Tool Manager
  └─ LLM Core Router
      ↓
CUTOS AIOS Bridge / Agent Runtime
      ↓
Semantic Video Intelligence
      ↓
Validated Edit Plan
      ↓
Edit DSL → Timeline → Instant Preview → Render
```

## 架構分工

### AIOS = Control Plane

AIOS 管理：

- 多 Agent 任務拆分與排程
- LLM / model / backend 選擇
- Context budget 與切換
- Agent memory
- Tool 權限與呼叫治理
- retry / timeout / cancellation policy
- 長任務狀態協調

### CUTOS = Editing Data Plane

CUTOS 管理：

- Project / MediaAsset
- Transcript / Speakers / Topics / Scenes / Highlights
- Semantic Index
- Edit Plan / Edit DSL
- Timeline revision
- Undo / Redo
- Instant Preview
- Export / FFmpeg

AIOS 不得直接修改 Timeline，不得直接執行任意 FFmpeg shell command，不得取得任意本機路徑。

## P0 — AiosOrchestrator

在既有 AiosPlanner 之外建立高階 orchestration abstraction：

```ts
interface AiosOrchestrator {
  submitRun(input: AiosRunRequest): Promise<AiosRunHandle>;
  getRun(runId: string): Promise<AiosRunState>;
  cancelRun(runId: string): Promise<void>;
  resumeRun(runId: string): Promise<void>;
}
```

若 AIOS 某模組沒有穩定 public API，不可直接綁定 private Python internals；以 adapter + documented/public contract 隔離。

## P0 — Multi-Agent Roles

AIOS 長任務角色：

```text
Video Ingest Agent
Transcript Agent
Speaker / Scene Agent
Semantic Analyst Agent
Edit Planner Agent
Critic / Verifier Agent
Delivery Agent
```

這些是 orchestration role，不建立多套 Timeline 或多個互相衝突的編輯狀態。

### Semantic Analyst Agent

負責：

- 搜尋逐字稿
- topic / scene / speaker retrieval
- repeated content
- highlight candidates

### Edit Planner Agent

把 semantic findings 轉成 validated Edit Plan。

### Critic / Verifier Agent

驗證：

- 是否誤刪重要內容
- 是否符合使用者目標
- timestamps 是否有效
- timeline revision 是否 stale
- duration target 是否合理

Verifier 不直接修改 Timeline。

## P0 — Scheduler Integration

CUTOS jobs 與 AIOS runs 建立 correlation：

```text
aiosRunId
cutosAgentRunId
projectId
jobIds[]
```

建立 priority class：

```text
interactive
analysis
background
render
```

確保即時查詢 / 預覽優先於 background semantic rebuild；render 不阻塞 interactive semantic search。

## P0 — Context Manager Integration

CUTOS SemanticContextBuilder 先 retrieval，再交 AIOS：

```text
instruction
↓
semantic search
↓
relevant topics / speakers / scenes
↓
bounded transcript windows
↓
AIOS context payload
```

```ts
interface CutosSemanticContext {
  projectId: string;
  timelineRevision: number;
  query: string;
  topics: TopicRef[];
  speakers: SpeakerRef[];
  ranges: TranscriptRange[];
  highlights: HighlightRef[];
  budget: {
    maxChars: number;
    maxSegments: number;
  };
}
```

要求 deterministic truncation、provenance、bounded size、no full transcript by default、no raw media bytes。

## P0 — Memory Manager Integration

AIOS memory 保存 Agent 記憶；CUTOS DB 保存影片事實。

### 適合放 AIOS Memory

- 使用者剪輯偏好
- project editing goals
- speaker alias references
- 已接受 / 拒絕的剪輯策略摘要
- agent run summaries
- reusable semantic decisions

### 必須留在 CUTOS

- canonical transcript
- Project / Media
- Semantic Index canonical metadata
- Edit Plan source of truth
- Timeline / revision / Undo-Redo
- export metadata

Memory namespace：

```text
user/<userId>/preferences
project/<projectId>/editing-memory
project/<projectId>/semantic-decisions
run/<runId>/ephemeral
```

Memory item 至少包含 source / projectId / runId / createdAt / confidence / provenance。

禁止跨 project 自動共享敏感 transcript。

## P0 — Tool Manager / Capability Governance

既有 `/api/aios/manifest` 與 `/api/aios/invoke` 不重寫，升級 capability metadata。

Semantic capabilities：

```text
get_transcript
search_transcript
search_semantic
list_speakers
list_topics
find_highlights
inspect_scene
get_context_range
create_edit_plan
verify_edit_plan
preview_edit_plan
apply_edit_plan
```

每個 capability：

- name
- version
- zh-TW / en description
- read / write permission
- input schema
- output schema
- sideEffect classification
- approvalRequired
- timeout hint
- idempotency hint

`apply_edit_plan` / `export` 必須 explicit approval。

AIOS tool chaining 不得繞過 CUTOS approval policy。

## P0 — Resource Broker

建立 provider-neutral policy：

```ts
interface IntelligenceResourcePolicy {
  chooseTranscriptionProvider(...): ProviderChoice;
  chooseEmbeddingProvider(...): ProviderChoice;
  choosePlanningProvider(...): ProviderChoice;
  chooseVisionProvider(...): ProviderChoice;
}
```

AIOS 可協調 OpenAI / Gemini / Anthropic / DeepSeek / Groq / Ollama / vLLM / local providers，但 CUTOS domain 只接 provider-neutral result。

Policy 維度：latency、cost class、privacy mode、local-only、quality tier、context size。

UI 只暴露：

```text
快速
平衡
高品質
本機優先
```

## P0 — AIOS Run Graph

大型任務必須變成可恢復 DAG，例如：

```text
ensure_transcript
  ├─ ensure_diarization
  ├─ ensure_topics
  └─ ensure_semantic_index
          ↓
find_highlights
          ↓
plan_long_cut
          ├─ verify_long_cut
          └─ plan_short_candidates
                  ↓
              review gate
                  ↓
              apply/export
```

每 node：id / kind / status / dependsOn / inputRefs / outputRefs / retryPolicy / approvalRequired。

completed CUTOS analysis stage 不重跑；retry 不得重複 apply Timeline。

## P0 — Unified Agent Activity

不顯示 hidden reasoning，只顯示真實 activity：

```text
AIOS 正在規劃分析流程
正在辨識語音
正在分辨說話者
正在建立語意索引
找到 6 個相關片段
正在比較重複內容
正在建立剪輯計畫
正在驗證剪輯計畫
等待你的確認
```

每個 activity 對應真實 run / tool / job event。

## P0 — Event Envelope

```ts
interface CutosAiosEvent {
  id: string;
  type: string;
  projectId: string;
  aiosRunId?: string;
  agentRunId?: string;
  jobId?: string;
  timestamp: number;
  payload: unknown;
}
```

事件至少：analysis.stage.started/completed、semantic.search.completed、agent.plan.created/verified、approval.required、timeline.applied、preview.ready、export.started/completed、run.failed。

Event log bounded + sanitized，不記 transcript 全文。

## P0 — Failure / Resume

處理：

- ASR timeout
- embedding provider failure
- worker restart
- AIOS kernel restart
- stale Edit Plan
- user cancel
- approval timeout

要求：completed stage 不重跑、run graph 可 resume、read tools idempotent、mutation tool 使用 idempotency key + revision guard。

## P0 — Security Boundary

必須：

- project-scoped auth / capability token hook
- projectId scoping
- read / write distinction
- explicit approval for mutation / export
- no arbitrary filesystem path
- no arbitrary shell
- no raw provider secret
- no transcript in logs
- memory namespace isolation
- tool output size limit
- prompt / tool injection defense

Transcript 內容不得被當成 system instruction。

## P1 — Cerebrum Agent Package

若建立 CUTOS 專用 AIOS agent，放在獨立 integration boundary，例如：

```text
integrations/aios/
  cutos_director_agent
  cutos_semantic_analyst_agent
  cutos_verifier_agent
```

CUTOS TypeScript core 不直接耦合 Python runtime，以 HTTP / JSON contract 或明確 process bridge 連接。

## P1 — Vector Memory Cooperation

CUTOS Semantic Index = 影片內容檢索 source of truth。

AIOS vector memory = agent experience / preference / cross-run recall。

AIOS memory 若引用影片內容，只保存 projectId / semanticDocumentId / time range / summary reference；原文由 CUTOS lookup。

## P1 — UI

AI-OS 面板升級為：

```text
AI-OS 狀態
目前模式：平衡
Kernel：可連線
執行中的代理：3
目前任務：影片理解與精華分析
Context：受控範圍
記憶：專案範圍
```

可展開 run graph、agent role、tool activity、job progress、approval gate。全繁體中文。

## Testing

新增：

- orchestration submit / cancel / resume / retry
- run ↔ CUTOS job correlation
- bounded context + provenance
- memory namespace isolation
- analyst → planner → verifier handoff
- verifier rejection
- approval before mutation
- capability schema / permission / idempotency
- kernel unavailable fallback
- transcript prompt injection defense
- arbitrary path / cross-project access rejection

E2E：

```text
匯入中文訪談
→ AIOS 建立 analysis run graph
→ CUTOS jobs 完成 transcript/topics/index
→ Semantic Analyst 找候選
→ Edit Planner 建 plan
→ Verifier 驗證
→ 使用者審核
→ Apply
→ Instant Preview
→ Export
```

## Definition of Done

- AIOS 不再只是 LLM provider。
- AiosOrchestrator 可工作。
- Multi-agent role contract 可工作。
- Scheduler / Context / Memory / Tool integration boundaries 明確。
- semantic tools 可由 AIOS agent 呼叫。
- long task 可追蹤、取消、恢復。
- CUTOS Project / Timeline 仍唯一真實來源。
- memory 有 namespace / provenance / privacy boundary。
- mutation tools 有 approval + revision guard。
- AIOS / CUTOS activity 有真實 event correlation。
- 不破壞 Instant Preview / zh-TW / 既有 AIOS bridge。
- lint / typecheck / tests / build 全綠。

## 非目標

- fork AIOS 核心才能使用 CUTOS。
- 把 CUTOS Timeline 搬進 AIOS memory。
- 讓 AIOS 直接跑任意 FFmpeg shell command。
- 用 computer-use 點 CUTOS 自己 UI 取代正式 API。
- 綁死單一 LLM vendor。
