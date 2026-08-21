# AI‑OS（AIOS）深度整合

CUTOS 與 AI‑OS（`aa0968111723-prog/ai_os`）做**雙向深度整合**：AIOS 是 Control
Plane，CUTOS 是 Editing Data Plane。兩個方向都在既有的 model-agnostic 邊界內，
不綁定單一廠商。

```
      inbound（AIOS 當 CUTOS 的大腦）
CUTOS Agent Runtime ──LLMQuery──▶ AIOS Kernel ──▶ LLM
                    ◀─LLMResponse──

      inbound（CUTOS 請 AIOS 跑長任務）
CUTOS AiosOrchestrator ──AiosRunRequest──▶ AIOS
                       ◀──AiosRunState────

      outbound（AIOS 驅動 CUTOS）
AIOS Agent ──GET /api/aios/manifest──▶ CUTOS 能力清單
           ──POST /api/aios/invoke───▶ 受治理的剪輯能力
           ──GET /api/aios/health────▶ 協定 / 版本 / 機制
```

跨 repo 完整規格：[`PR9_AIOS_NATIVE_ORCHESTRATION.md`](PR9_AIOS_NATIVE_ORCHESTRATION.md)。
AIOS 端對應文件：`ai_os/docs/CUTOS_NATIVE_INTEGRATION.md`。

核心原則：

- AIOS 不直接修改 Timeline，也不直接執行任意 FFmpeg command。
- AIOS memory 不取代 CUTOS ProjectStore / canonical transcript / Timeline。
- 長影片先由 CUTOS semantic retrieval 產生 bounded context，再交 AIOS。
- semantic capabilities 擴充在既有 `/api/aios/*`，不建立第二套橋接 API。
- 所有 mutation 必須經 approval、revision guard 與 Edit DSL validation。
- run / job / activity 必須可 correlation、取消、恢復與重試。

---

## Protocol：`cutos.agent.v2`

協定定義在 `packages/protocol/src/protocol.ts`，並**逐位元組鏡像**到
`ai_os/shared/cutosProtocol.ts`。兩邊都以 Zod 驗證所有 runtime payload——
TypeScript interface 不夠，因為對方是另一個 repo 的另一個 process。

`PROTOCOL_CONTRACT` 是手寫的結構描述，`protocolContractFingerprint()` 把它雜湊成
`PROTOCOL_CONTRACT_FINGERPRINT`，兩個 repo 的測試斷言同一個值。單邊修改協定而未
鏡像，兩邊測試都會紅。

目前 fingerprint：`63168dcf9a648776eda4e34f61a2028c7fc1041b738d3428120366a2259a3775`

版本協商由 `checkProtocolCompatibility()` 負責；**不相容時明確失敗**，不做 silent
fallback。`packages/protocol/src/version.ts` 是不含 `node:crypto` 的版本常數，
供瀏覽器端 bundle 使用。

### v1 相容

升級不破壞 v1：

- `POST /api/aios/invoke` 仍接受 `{ "name": "...", "args": {...} }` 並回
  `{ capability, result }`。
- 舊能力名稱 `plan` / `apply` 仍可呼叫，且仍出現在 manifest 裡（標記為 v1 相容名稱）。
- v1 呼叫仍然通過同一條治理管線（驗證、冪等、revision guard）。

---

## Outbound：AIOS 驅動 CUTOS

`GET /api/aios/manifest` 回傳每個能力的：

```
name · version · description（繁中＋英） · permission · access · risk ·
idempotency · requiresApproval · longRunning · mutatesTimeline ·
timeoutHintMs · inputSchema · outputSchema · params
```

### 能力

**語意（PR8 semantic video intelligence 之上）**
`get_transcript`、`search_transcript`、`search_semantic`、`list_speakers`、
`list_topics`、`find_highlights`、`inspect_scene`、`get_context_range`、
`build_semantic_context`

**剪輯**
`create_edit_plan`、`verify_edit_plan`、`preview_edit_plan`、`preview_operation`、
`reject_operation`、`apply_edit_plan`、`undo`、`redo`、`export`

**工作與執行**
`analyze`、`get_job`、`cancel_job`、`retry_job`、`get_agent_run`、
`cancel_agent_run`、`resume_agent_run`、`list_activity`、`get_preview`

每個能力都以 Zod 驗證參數、標註權限，且**只透過 `projectId` 引用媒體**——
不接受任意檔案路徑、URL 或 shell 片段。manifest 就是 allow-list，沒有
`invoke(name, args)` 這種萬用出口。

### 治理管線

`POST /api/aios/invoke` 的每一次呼叫依序經過：

```
協定協商 → 能力查表 → 參數驗證 → 冪等回放檢查 → timeline revision guard
→ approval gate → 落地冪等宣告 → 執行 → 保存收據 → 活動事件 → 脫敏回應
```

**冪等回放先於 revision guard**：一次成功的 apply 會讓 revision 前進，若先檢查
revision，網路重試就會被判 stale，呼叫端會誤以為要重做——那正是這個整合要防止的
「同一個 Edit Plan apply 兩次」。

### Idempotency

寫入能力必須帶 `correlation.idempotencyKey`。CUTOS 以
`(projectId, capability, idempotencyKey)` 建立 durable 收據（記憶體與 SQLite 皆
實作）：

- 已完成 → 回放既有結果，`replayed: true`，**不再 mutation**
- 執行中 → `IDEMPOTENCY_IN_PROGRESS`（可重試）
- 同 key 不同參數 → `IDEMPOTENCY_CONFLICT`
- 租約過期（process 崩潰）→ 允許重新取得

保護 `apply_edit_plan`、`undo`、`redo`、`export`、`analyze` 等所有有副作用的操作。

### Revision guard

`mutatesTimeline` 的能力必須帶 `expectedRevision`。不符時立刻回
`STALE_TIMELINE_REVISION`（`retryable: false`），呼叫端應重讀後 replan。

### Approval

CUTOS 計算 AIOS 無法計算的 domain 影響，並以穩定的 `reasonCode` 說明：

| reasonCode | 條件 |
| --- | --- |
| `removes_more_than_30_percent` | 刪除超過原片 30% |
| `keeps_less_than_20_percent` | 保留不足原片 20% |
| `bulk_delete` | 單一計畫 ≥ 12 個刪除操作 |
| `unsupported_operations` | 含尚未支援的操作 |
| `final_export` | 最終輸出 |

CUTOS **不做第二套確認介面**：需要人時回 `APPROVAL_REQUIRED` 與
`ApprovalRequest`（含 removedRatio / keptRatio / 操作數），由 AIOS 這個 Control
Plane 負責人機互動，再帶 `approval.granted` 回來。

---

## Inbound：AiosPlanner 與 AiosOrchestrator

`AiosPlanner` 以 AIOS 文件化的 LLM Core API（`LLMQuery` → `LLMResponse`）當規劃器，
與 `LocalHeuristicPlanner`、`OpenAICompatiblePlanner` 實作同一個 `Planner` 介面。

`AiosOrchestrator`（`packages/agent/src/aios-orchestrator.ts`）是更高階的協調層：

```ts
interface AiosOrchestrator {
  health(): Promise<AiosOrchestratorHealth>;
  submitRun(input: AiosRunRequest, signal?: AbortSignal): Promise<AiosRunHandle>;
  getRun(runId: string, signal?: AbortSignal): Promise<AiosRunState>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<AiosRunState>;
  resumeRun(runId: string, signal?: AbortSignal): Promise<AiosRunState>;
}
```

具備 timeout、AbortSignal、有界重試、驗證回應。**不綁 AIOS private internals**，
全部走 documented HTTP contract，路徑可設定。

`apps/web/server/aios-orchestrator-service.ts` 是耐久的一半：submit 之前先把
handle 寫進 ProjectStore（以推導出的 idempotency key 為索引），所以 CUTOS 在
submit 途中崩潰不會產生兩個 AIOS run；重啟後 `reconcileAiosRuns()` 會去問 AIOS
真正發生了什麼。

### 這個方向真的通了（而且以前沒有）

第一版有 client 卻沒有對端：CUTOS 送 `/api/cutos/*`，ai_os 一條都沒實作，而兩邊
測試全綠——因為 orchestrator 只被「寫在自己測試檔裡的假伺服器」測過，那是照鏡子，
不是合約。現在三件事同時補上：

1. **ai_os 真的提供這些端點**（`server/services/cutosInboundRuns.ts`，掛在
   `server/index.ts`）。
2. **協定描述了這個面**：`PROTOCOL_CONTRACT.aiosEndpoints` 與 `aiosCapabilities`
   進了 fingerprint，所以「AIOS 少掛一條路由」現在是紅燈，不是執行期 404。
3. **CUTOS 這側可以真的被呼叫**：`POST /api/aios/runs`、
   `GET /api/aios/runs?projectId=`、`GET|POST /api/aios/runs/{handleId}`
   （`action` 只接受 `cancel` / `resume`，沒有任何方法可以指名任意函式）。

AIOS 對這種 inbound run 的治理沒有放寬：run 會落在**一般的核准閘門**（回報
`waiting_approval`），送出者不能核准自己的 run——`resume` 明確回
`APPROVAL_REQUIRED` 而不是放行。

### 廠商中立

`AiosRunRequest` 只說 `capability` 與 `qualityProfile`（`fast` / `balanced` /
`quality` / `local`）與可選的 `deadlineMs`。用哪個模型、哪個 backend 完全是 AIOS
的決定——CUTOS 程式碼裡沒有任何 vendor 條件式，測試也斷言送出的 payload 不含
vendor 名稱。

---

## Semantic Video Intelligence

`packages/semantic` 是離線、決定性的檢索層，建構在 canonical transcript 之上：

- CJK-aware tokenizer（中文 bigram、拉丁字詞、雙語停用詞）
- TF-IDF 索引與 cosine 檢索（`search_semantic`）
- 字面搜尋（`search_transcript`）
- 主題抽取、說話者統計
- 精華候選（資訊密度 / 主題密度 / 長度契合 / 語音連續性，每段附 `reasonCode`）
- 片段檢視與有上限的逐字稿窗格

同樣的輸入永遠得到同樣的輸出——這是 `contextHash` 有意義的前提。

### Bounded Context

`build_semantic_context` 是**預設唯一**離開 CUTOS 的逐字稿衍生資料：

```
projectId · timelineRevision · query · topics · speakers · ranges ·
highlights · provenance{capability,requestId,analysisVersion,mediaChecksum,contextHash} ·
budget{maxRanges,maxChars,usedRanges,usedChars,truncated}
```

有上限、決定性、去重、可追溯。完整逐字稿只有在明確呼叫 `get_transcript` 時才會
分頁交出。

---

## 活動事件

`AgentActivityEvent` 帶 `aiosRunId` / `aiosStepId` / `cutosAgentRunId` /
`cutosJobId` / `projectId` / `kind` / `status` / `messageKey` / `metadata`，
落在 durable 的 activity log，可用 `list_activity` 或
`GET /api/aios/activity?projectId=...&afterSequence=...` 續讀。

`messageKey` 是穩定的 i18n 鍵；`metadata` 只收純量。**不記逐字稿全文，也不顯示
模型的 chain-of-thought**——結構上就沒有自由文字欄位可以放。

---

## 長任務、取消與恢復

分析與輸出回 `jobId` 而不是阻塞回應：

```
POST /api/aios/invoke {capability: "analyze"} → { jobId }
POST /api/aios/invoke {capability: "get_job"} → { status, progress, stage }
POST /api/aios/invoke {capability: "cancel_job"}
```

`cancel_job` 會請 worker 停下（analysis / ASR / semantic index / export），並保持
專案狀態一致。CUTOS 端的 job store 本身也有 stale recovery。

---

## 設定

### Outbound（AIOS 呼叫 CUTOS）——**必要**

| 變數 | 說明 | 預設 |
| --- | --- | --- |
| `CUTOS_API_KEY` | 橋接金鑰。**未設定時 `/api/aios/invoke` 拒絕所有能力呼叫。** | — |

ai_os 一直都在送 `Authorization: Bearer $CUTOS_API_KEY`；CUTOS 從來沒有讀它。
在補上這道檢查之前，`POST /api/aios/invoke` **完全沒有認證**：任何能連到這台伺服器
的人，都能對任何 projectId 呼叫 `apply_edit_plan`、`undo`、`redo`、`export`。而 v1
路徑又寫死 `approval.granted = true`，所以 `{"name":"apply"}` 會直接套用剪輯、
`{"name":"export"}` 會直接輸出——沒有任何人確認過。

三個刻意的決定：

1. **檢查在 `handleInvokeBody` 裡，不在 Next route 裡。** 只掛在傳輸層的守衛，是
   下一個傳輸層會忘記的守衛——這個 repo 之所以會「測試檔有認證、正式環境沒有」，
   正是因為如此。
2. **沒設金鑰＝拒絕（fail closed）。** 沒設金鑰的維運者並沒有決定要對外公開一個
   免認證的剪輯端點；「預設放行」正是這個洞的成因。
3. **`GET /api/aios/health` 維持開放。** 它是版本握手，只回兩邊原始碼裡本來就公開
   的常數。要求金鑰會讓「版本不相容」與「認證失敗」變成同一種不可達狀態，正是
   協定禁止的靜默失敗。

兩邊設同一個值：CUTOS 的 `CUTOS_API_KEY` 與 ai_os 的 `CUTOS_API_KEY`。

### Inbound（用 AIOS 當規劃器）

| 變數 | 說明 | 預設 |
| --- | --- | --- |
| `CUTOS_LLM_PROVIDER` | 設為 `aios` 以啟用 | `local` |
| `CUTOS_AIOS_KERNEL_URL` | AIOS kernel 位址 | — |
| `CUTOS_AIOS_QUERY_PATH` | LLM Core 查詢路徑 | `/query` |
| `CUTOS_AIOS_MODEL` | kernel 內註冊的模型名稱 | `gpt-4o-mini` |
| `CUTOS_AIOS_BACKEND` | AIOS backend | `openai` |
| `CUTOS_AIOS_API_KEY` | kernel 保護金鑰 | — |

### Inbound（AiosOrchestrator）

| 變數 | 說明 | 預設 |
| --- | --- | --- |
| `CUTOS_AIOS_URL` | AIOS 位址 | —（未設定＝停用協調） |
| `CUTOS_AIOS_ORCH_KEY` | 保護金鑰 | — |
| `CUTOS_AIOS_TIMEOUT_MS` | 逾時 | `30000` |
| `CUTOS_AIOS_QUALITY` | 預設品質檔次 | `balanced` |

模型本身的 API key 設定在 AIOS，CUTOS 不保存。kernel 未設定時自動退回內建離線
規劃器，不會壞掉。

---

## 測試

| 測試 | 內容 |
| --- | --- |
| `packages/protocol/src/protocol.test.ts` | 協定、版本協商、fingerprint |
| `packages/protocol/src/version.test.ts` | 瀏覽器安全版本模組不漂移 |
| `packages/semantic/src/semantic.test.ts` | 檢索、主題、精華、受控脈絡 |
| `packages/project-store/src/aios-store.test.ts` | 冪等、活動、AIOS run（記憶體＋SQLite＋重啟） |
| `packages/agent/src/aios-orchestrator.test.ts` | 真實 HTTP 的 CUTOS→AIOS 客戶端行為（逾時、重試、中止） |
| `packages/agent/src/aios-orchestrator.contract.test.ts` | 重播 **ai_os 錄下的真實流量**，驗證 CUTOS→AIOS 合約 |
| `apps/web/server/aios-bridge.test.ts` | 完整治理管線（含真實 FFmpeg 的剪輯循環） |
| `apps/web/server/aios-http.test.ts` | 真實 HTTP 的 13 個 contract 情境＋錄製 fixtures |

### 跨 repo contract 檔（兩個方向各一份）

| 檔案 | 誰錄的 | 誰重播 |
| --- | --- | --- |
| `docs/contract/cutos.agent.v2.fixtures.json` | CUTOS `aios-http.test.ts` | ai_os `cutosContract.test.ts` |
| `docs/contract/aios.cutos.v2.inbound.fixtures.json` | ai_os `cutosInboundRuns.pg.test.ts`（真實 PostgreSQL） | CUTOS `aios-orchestrator.contract.test.ts` |

兩份都**確定性**：id 與時間戳在寫入前正規化。這不是潔癖——第一版每跑一次測試就
重寫 284 行，工作區永遠是髒的，而兩個 repo 的副本必然不同，等於讓這個「跨 repo
成品」失去它唯一的用處。

而且 fixture 現在記了 `protocolSourceSha256`：ai_os 會對**自己那份**
`shared/cutosProtocol.ts` 取雜湊來比對。以前 `PROTOCOL_CONTRACT_FINGERPRINT` 只是
同 repo 的自我一致性檢查——只鏡射一半時兩邊都還是綠的；現在沒收到的那一邊會紅。

```bash
# CUTOS → ai_os
pnpm vitest run apps/web/server/aios-http.test.ts
cp docs/contract/cutos.agent.v2.fixtures.json ../ai_os/docs/contract/

# ai_os → CUTOS
(cd ../ai_os && RUN_PG_INTEGRATION=1 npx vitest run server/services/cutosInboundRuns.pg.test.ts)
cp ../ai_os/docs/contract/aios.cutos.v2.inbound.fixtures.json docs/contract/
```

### 範例

```bash
curl -s http://localhost:3000/api/aios/manifest | jq '.protocolVersion, (.capabilities|length)'

curl -s -X POST http://localhost:3000/api/aios/invoke \
  -H 'content-type: application/json' \
  -d '{
    "protocolVersion": "cutos.agent.v2",
    "capability": "search_semantic",
    "args": { "projectId": "<id>", "query": "遠距招募" },
    "correlation": { "requestId": "req-1", "aiosRunId": "run-1", "aiosStepId": "step-1" }
  }' | jq .
```
