# PR #8 — AIOS-Native Video Intelligence Integration

## 目標

把 CUTOS 與 AIOS 的關係從「LLM provider + HTTP capability bridge」提升為「AIOS 控制面 + CUTOS 剪輯資料面」：

- AIOS 負責：Agent 排程、Context、Memory、Tool governance、模型資源路由、長任務協調。
- CUTOS 負責：Media、Project、Semantic Index、Edit DSL、Timeline、Preview、Render 的唯一真實狀態。

AIOS 不直接修改 Timeline、不直接操作 FFmpeg；CUTOS 不自行複製一套 AIOS scheduler/memory/context 系統。

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

## 核心分工

### AIOS = Control Plane

AIOS 管理：

- 多 Agent 任務拆分與排程
- LLM/model/backend 選擇
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

AIOS 只拿 projectId / semantic references / typed tool result；不得取得任意本機路徑。

## P0 — AIOS Orchestrator Adapter

在既有 AiosPlanner 之外新增高階 orchestration abstraction：

```ts
interface AiosOrchestrator {
  submitRun(input: AiosRunRequest): Promise<AiosRunHandle>;
  getRun(runId: string): Promise<AiosRunState>;
  cancelRun(runId: string): Promise<void>;
  resumeRun(runId: string): Promise<void>;
}
```

不得把 CUTOS 綁死 AIOS 內部未穩定的 Python module path。

如果 AIOS 某模組沒有穩定 public HTTP/API contract：

- 先以 adapter 隔離。
- 使用可驗證的 documented/public boundary。
- 不直接 import AIOS private internals。
- 不把 experimental implementation 當穩定 API。

## P0 — Multi-Agent Editing Roles

讓 AIOS 能把大型影片任務拆成明確角色：

```text
Video Ingest Agent
Transcript Agent
Speaker/Scene Agent
Semantic Analyst Agent
Edit Planner Agent
Critic / Verifier Agent
Delivery Agent
```

但 CUTOS 不建立七套獨立聊天 UI。

角色是 AIOS orchestration 層概念，所有實際剪輯仍回到單一 CUTOS Edit Plan / DSL / Timeline。

### Video Ingest Agent

負責確認：

- media metadata
- analysis prerequisites
- missing stages

### Transcript Agent

負責：

- ASR stage
- transcript normalization
- sentence segmentation

### Semantic Analyst Agent

負責：

- topic
- semantic search
- repeated content
- highlight candidates

### Edit Planner Agent

負責把 semantic findings 轉成 Edit Plan。

### Critic / Verifier Agent

只讀取 bounded context + proposed plan，驗證：

- 是否誤刪關鍵語意
- 是否超出使用者目標
- timestamps 是否有效
- plan revision 是否 stale
- duration target 是否合理

Verifier 不直接 mutation Timeline。

## P0 — AIOS Scheduler Integration

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

用途：

- 使用者即時預覽/查詢優先於 background highlight rebuild。
- 大型 ASR / scene analysis 可排 background。
- Export/render 不阻塞 interactive semantic search。

如果目前 AIOS scheduler 沒有穩定外部 priority API，先建立 CUTOS-side mapping + adapter，不假造 AIOS 已支援的 contract。

## P0 — AIOS Context Manager Integration

AIOS 不可拿整支 60 分鐘 transcript。

CUTOS SemanticContextBuilder 先做 retrieval：

```text
instruction
↓
semantic search
↓
relevant topics/speakers/scenes
↓
bounded transcript windows
↓
AIOS context payload
```

傳給 AIOS 的 context payload 使用 typed envelope：

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

要求：

- deterministic truncation
- provenance
- bounded size
- no full transcript by default
- no raw media bytes

## P0 — AIOS Memory Integration

AIOS Memory 不應變成第二份 ProjectStore。

AIOS memory 保存「Agent 記憶」，CUTOS DB 保存「影片事實」。

### 適合放 AIOS memory

- 使用者偏好：例如偏好節奏快、保留完整語意
- speaker alias：例如 speaker-1 = 主持人（可同步 reference）
- 已接受/拒絕過的剪輯策略摘要
- project-level editing goals
- agent run summaries
- reusable semantic decisions

### 不應只放 AIOS memory

- canonical transcript
- Timeline
- Edit Plan source of truth
- media asset location
- export metadata

這些必須由 CUTOS durable store 作為唯一真實來源。

### Memory Namespace

至少建立：

```text
user/<userId>/preferences
project/<projectId>/editing-memory
project/<projectId>/semantic-decisions
run/<runId>/ephemeral
```

禁止跨 project 自動共享敏感 transcript。

Memory item 必須含 provenance：

```text
source
projectId
runId
createdAt
confidence
```

## P0 — AIOS Tool Manager / Capability Governance

既有 `/api/aios/manifest` 與 `/api/aios/invoke` 升級為更完整 typed capability contract。

新增 semantic capabilities：

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

每個 capability 需要：

- name
- version
- zh-TW / en description
- read/write permission
- input schema
- output schema
- sideEffect classification
- approvalRequired
- timeout hint
- idempotency hint

例如：

```text
search_semantic = read / no approval
create_edit_plan = write-plan / review required
apply_edit_plan = timeline mutation / explicit approval required
export = heavy side effect / explicit approval required
```

AIOS agent 不得因 tool chaining 繞過 CUTOS approval policy。

## P0 — Resource Broker

建立 AIOS-aware model/resource policy：

```ts
interface IntelligenceResourcePolicy {
  chooseTranscriptionProvider(...): ProviderChoice;
  chooseEmbeddingProvider(...): ProviderChoice;
  choosePlanningProvider(...): ProviderChoice;
  chooseVisionProvider(...): ProviderChoice;
}
```

AIOS 可管理/選擇：

- OpenAI
- Gemini
- Anthropic
- DeepSeek
- Groq
- Ollama
- vLLM
- local providers

但 CUTOS domain 只看到 provider-neutral result。

加入 policy 維度：

- latency
- cost class
- privacy mode
- local-only requirement
- quality tier
- context size

UI 可提供簡單模式：

```text
快速
平衡
高品質
本機優先
```

不要讓一般使用者直接面對一堆 provider 參數。

## P0 — AIOS Run Graph

大型要求：

「把這支 45 分鐘訪談剪成 8 分鐘精華，另外找三段短影音。」

建立可恢復 DAG：

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

每個 node：

```text
id
kind
status
dependsOn[]
inputRefs[]
outputRefs[]
retryPolicy
approvalRequired
```

CUTOS durable jobs 與 AIOS scheduler 狀態必須能 correlation，而不是雙方各自顯示互相不知道的進度。

## P0 — Unified Agent Activity

UI 不顯示 AIOS hidden reasoning。

顯示可驗證 activity：

```text
AIOS 正在規劃分析流程
正在辨識語音
正在分辨說話者
正在建立語意索引
找到 6 個相關片段
正在比較重複內容
正在建立剪輯計畫
驗證剪輯計畫
等待你的確認
```

每個 activity 對應實際 run/tool/job event。

## P0 — Event Envelope

CUTOS ↔ AIOS 建立一致 event envelope：

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

事件：

```text
analysis.stage.started
analysis.stage.completed
semantic.search.completed
agent.plan.created
agent.plan.verified
approval.required
timeline.applied
preview.ready
export.started
export.completed
run.failed
```

event log 要 bounded / sanitized，不記 transcript 全文。

## P0 — Failure / Resume

AIOS orchestration 要能處理：

```text
ASR provider timeout
embedding provider failure
worker restart
AIOS kernel restart
stale Edit Plan
user cancel
approval timeout
```

要求：

- completed CUTOS analysis stage 不重跑
- resumable AIOS run graph
- idempotent read tools
- mutation tool 使用 idempotency key / revision guard
- retry 不可重複 apply Timeline

## P0 — Security Boundary

AIOS integration 是 capability boundary，不是 unrestricted trust。

必須：

- project-scoped capability token / auth hook
- projectId scoping
- read/write distinction
- explicit approval for timeline mutation/export
- no arbitrary filesystem path
- no arbitrary shell
- no raw provider secret
- no transcript in logs
- memory namespace isolation
- tool output size limit
- prompt/tool injection defense

外部 transcript 內容不得被視為 system instruction。

## P1 — Cerebrum Agent SDK

若要建立 CUTOS 專用 AIOS agent package，可使用 Cerebrum 建立：

```text
CutosDirectorAgent
CutosSemanticAnalystAgent
CutosVerifierAgent
```

但應放在獨立 integration boundary，例如：

```text
integrations/aios/
```

CUTOS TypeScript core 不應直接耦合 Python runtime。

建議使用 HTTP / JSON contract 或明確 process bridge。

## P1 — Vector Memory / Semantic Index Cooperation

CUTOS Semantic Index 與 AIOS Memory 分工：

- CUTOS index：影片內容檢索的 source of truth。
- AIOS memory/vector memory：agent experience / preference / cross-run recall。

不要把同一份 transcript embedding 同時維護兩個互不一致的 canonical index。

若 AIOS vector memory 要引用影片內容，保存 reference：

```text
projectId
semanticDocumentId
startMs
endMs
summary
```

原文仍由 CUTOS lookup。

## P1 — AIOS Computer-Use（選配，不是 PR #8 核心）

AIOS 有 computer-use / MCP 方向，但 CUTOS 核心剪輯不應依賴 GUI automation。

未來可用於：

- 發布到外部網站
- 操作第三方素材平台
- 桌面工具協作

但 Timeline / Render 必須仍走 CUTOS API，不用 computer-use 模擬點擊自己的 UI。

## P1 — UI

AI-OS 面板從「連線狀態」升級為：

```text
AI-OS 狀態
目前模式：平衡
Kernel：可連線
執行中的代理：3
目前任務：影片理解與精華分析
Context 使用量：bounded
記憶：專案範圍
```

可展開查看：

- run graph
- agent role
- tool activity
- job progress
- approval gates

保持全繁體中文。

## Testing

新增：

### AIOS orchestration

- run submission
- cancel / resume
- retry
- run ↔ job correlation
- kernel unavailable fallback

### Context

- bounded transcript context
- provenance
- no full transcript leakage

### Memory

- project namespace isolation
- preference recall
- no cross-project transcript leakage

### Tools

- permission enforcement
- approval gate
- idempotency
- payload size limit
- schema validation

### Multi-agent

- analyst → planner handoff
- planner → verifier
- verifier rejection
- approval before apply

### Security

- prompt injection in transcript cannot become tool instruction
- arbitrary path rejected
- cross-project access rejected

### E2E

```text
匯入中文訪談
→ AIOS 建立 analysis run graph
→ CUTOS jobs 完成 transcript/topics/index
→ AIOS Semantic Analyst 找候選
→ Edit Planner 建 plan
→ Verifier 驗證
→ 使用者審核
→ apply
→ instant preview
→ export
```

## Definition of Done

- AIOS 不再只是 LLM provider。
- 有 orchestration adapter。
- 有 multi-agent role contract。
- Scheduler / Context / Memory / Tool integration boundaries 明確且有可工作路徑。
- CUTOS Project/Timeline 仍是唯一真實來源。
- semantic tools 可被 AIOS agent 使用。
- long task 可建立、追蹤、取消、恢復。
- Agent activity 對應真實 event/job/tool。
- memory 有 namespace / provenance / privacy boundary。
- mutation tools 有 approval + revision guard。
- 不破壞 Instant Preview / zh-TW / existing AIOS bridge。
- lint / typecheck / tests / build 全綠。

## 非目標

- fork / 修改 AIOS 核心本身才能使用 CUTOS。
- 把 CUTOS Timeline 搬進 AIOS memory。
- 讓 AIOS 直接跑任意 FFmpeg shell command。
- 用 computer-use 點 CUTOS 自己的 UI 取代正式 API。
- 綁死單一 LLM vendor。
