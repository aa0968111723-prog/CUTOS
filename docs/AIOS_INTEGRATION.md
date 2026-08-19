# AI‑OS 深度整合（AIOS Integration）

CUTOS 與 [AIOS（agiresearch/AIOS）](https://github.com/agiresearch/AIOS) 做**雙向深度整合**，兩個方向都在既有的 model-agnostic provider gateway 邊界內，不綁定單一廠商：

```
      inbound（AIOS 當 CUTOS 的大腦）
CUTOS Agent Runtime ──LLMQuery──▶ AIOS Kernel ──▶ LLM
                    ◀─LLMResponse──

      outbound（AIOS 驅動 CUTOS）
AIOS Agent ──GET /api/aios/manifest──▶ CUTOS 能力清單
           ──POST /api/aios/invoke───▶ CUTOS 剪輯能力（analyze / plan / apply / export …）
```

## PR #8：AIOS-native 架構

PR #8 進一步把整合提升為 **AIOS Control Plane + CUTOS Editing Data Plane**：AIOS 的 Scheduler、Context、Memory、Tool governance 與 LLM Core 參與多代理影片理解與長任務協調；CUTOS 保持 Project、Media、Semantic Index、Edit DSL、Timeline、Preview、Render 的唯一真實來源。

完整規格：[`PR8_AIOS_NATIVE_VIDEO_INTELLIGENCE.md`](PR8_AIOS_NATIVE_VIDEO_INTELLIGENCE.md)

核心原則：

- AIOS 不直接修改 Timeline，也不直接執行任意 FFmpeg shell command。
- CUTOS 不複製一套 AIOS Scheduler / Memory / Context Manager。
- CUTOS semantic tools 透過 typed capabilities 提供給 AIOS agents。
- AIOS memory 保存 agent experience / preference / decisions；canonical transcript、Timeline、Project state 仍在 CUTOS。
- 長影片先由 CUTOS semantic retrieval 產生 bounded context，再交給 AIOS，而不是把完整逐字稿塞進模型。
- 所有 mutation capability 都必須經 CUTOS approval policy、timeline revision guard 與 Edit DSL validation。

## Inbound：用 AIOS Kernel 當規劃器

`AiosPlanner`（`packages/agent`）以 AIOS 文件化的 **LLM Core API**（`LLMQuery` → `LLMResponse`）向 kernel 發問，並與 `LocalHeuristicPlanner`、`OpenAICompatiblePlanner` 實作同一個 `Planner` 介面。所有輸出仍會經過 gateway 的 Edit DSL 驗證才會影響時間軸。

啟用（環境變數 / secrets）：

| 變數 | 說明 | 預設 |
| --- | --- | --- |
| `CUTOS_LLM_PROVIDER` | 設為 `aios` 以啟用 | `local` |
| `CUTOS_AIOS_KERNEL_URL` | AIOS kernel 位址，例如 `http://localhost:8000` | —（必填才會連線） |
| `CUTOS_AIOS_QUERY_PATH` | LLM Core 查詢路徑 | `/query` |
| `CUTOS_AIOS_MODEL` | kernel 內註冊的模型名稱 | `gpt-4o-mini` |
| `CUTOS_AIOS_BACKEND` | AIOS backend（`openai`/`anthropic`/`ollama`/`vllm`…） | `openai` |
| `CUTOS_AIOS_AGENT_NAME` | 呈現給 kernel 的 agent 名稱 | `cutos` |
| `CUTOS_AIOS_API_KEY` | kernel 若有保護才需要 | — |

> 模型本身的 API keys 設定在 AIOS kernel 的 `aios/config/config.yaml`，CUTOS 不需要保存。若 kernel 未設定，CUTOS 會自動退回內建離線規劃器，不會壞掉。

啟動 AIOS kernel（參考 AIOS 專案）：

```bash
python3 -m uvicorn runtime.launch:app --host 0.0.0.0 --port 8000
```

## Outbound：讓 AIOS 驅動 CUTOS

CUTOS 把剪輯能力開放為可被 AIOS agent 呼叫的介面：

- `GET /api/aios/manifest` — 回傳能力清單（`cutos.agent.v1`）：每個能力含 `name`、`description`（中英）、`permission`（read/write）、`params`。
- `POST /api/aios/invoke` — 單一驗證入口：`{ "name": "<capability>", "args": { ... } }`。

能力（capabilities）：`list_projects`、`create_sample_project`、`get_project`、`analyze`、`plan`、`preview_operation`、`reject_operation`、`apply`、`undo`、`redo`、`export`、`get_job`。

PR #8 會在同一 bridge 上擴充 semantic capabilities，例如 `get_transcript`、`search_transcript`、`search_semantic`、`list_speakers`、`list_topics`、`find_highlights`、`inspect_scene`、`get_context_range`、`verify_edit_plan`，不建立第二套 AIOS API。

每個能力都以 zod 驗證參數、標註權限，且**只透過 `projectId` 引用媒體**，不接受任意檔案路徑——不會破壞 StorageAdapter 的安全性。

範例（AIOS agent 端）：

```bash
curl -s http://localhost:3000/api/aios/manifest | jq .

curl -s -X POST http://localhost:3000/api/aios/invoke \
  -H 'content-type: application/json' \
  -d '{"name":"plan","args":{"projectId":"<id>","instruction":"刪掉超過 1 秒的停頓"}}'
```

`plan` 會回傳 `runId` 與待審核計畫；`apply` 套用後可用 `get_project` 取得含 `preview`（即時預覽 manifest）的最新狀態，`export` 取得 `jobId` 後以 `get_job` 輪詢。
