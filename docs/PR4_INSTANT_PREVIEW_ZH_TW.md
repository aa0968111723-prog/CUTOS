# PR #4 — Instant Preview Engine + 全繁體中文 UX

## 目標

把 CUTOS 從「套用剪輯後必須等待 FFmpeg 輸出才能確認結果」升級成「套用後即可近即時預覽」，同時將所有使用者可見介面統一為繁體中文（zh-TW）。

核心流程：

```text
匯入影片
→ 分析
→ 使用者用自然語言下指令
→ Agent 建立 Edit Plan
→ 使用者審核
→ 套用 Timeline
→ 立即預覽剪輯後結果
→ Undo / Redo 即時反映
→ 最終 FFmpeg 輸出
```

## 核心架構原則

Preview 與 Export 不得有兩套不同的剪輯語意。

```text
                    ┌→ Preview Compiler → Browser Player
Edit DSL → Timeline ┤
                    └→ Render Compiler  → FFmpeg
```

兩者必須共享同一個 Timeline semantic model、時間映射與 clip 轉換規則。

## P0 — Preview Core

建立可測試的 Preview abstraction：

- `PreviewCompiler`
- `PreviewManifest`
- `PreviewSegment`
- `TimelineTimeMapper`
- `PreviewController`

第一版至少支援：

- trim
- split
- delete_range
- remove_silence
- set_speed
- captions overlay（預覽層）
- markers

Preview manifest 至少包含：

- timeline revision
- total edited duration
- segment list
- source asset reference
- source in/out
- edited in/out
- playback rate
- caption/marker overlays

## P0 — 時間映射

必須提供：

- `sourceTimeToTimelineTime()`
- `timelineTimeToSourceTime()`
- deleted range detection
- clip boundary resolution
- speed-aware mapping

要求：

- Timeline seek 與 Player seek 同步
- 播放頭位置必須使用 edited timeline time
- Undo / Redo 後 mapping 立即更新
- stale revision 不可套用到新 Timeline

## P0 — Browser Playback

優先採 progressive enhancement：

1. HTMLVideoElement fallback
2. MediaSource（適合時）
3. WebCodecs（瀏覽器支援且有實際效益時）

不得為了使用 WebCodecs 而犧牲瀏覽器相容性。

第一版重點是「編輯後時間軸能立即正確播放」，不是追求複雜 GPU 特效。

## P0 — Preview / Export Parity

同一份 Timeline：

- 預覽總長度
- segment 順序
- source in/out
- playback speed

必須與 FFmpeg export compiler 一致。

加入 parity tests：

- trim
- split
- delete
- multiple delete ranges
- speed
- mixed speed + delete
- undo / redo

至少做 duration + segment mapping parity；後續再升級 frame-level parity。

## P0 — 全繁體中文（zh-TW）

所有使用者可見文字改成繁體中文。

### 必須中文化

- 首頁
- 專案側欄
- 匯入影片
- 分析進度
- Agent 對話
- Agent Activity
- Edit Plan
- 操作審核卡
- Timeline 標籤
- Undo / Redo
- Job Center
- 錯誤訊息
- 空狀態
- Loading 狀態
- Export
- 成功/失敗通知
- 手機版 UI

範例：

- `Import video` → `匯入影片`
- `Agent` → `CUTOS 助手`
- `Analyzing…` → `正在分析影片…`
- `Apply plan` → `套用剪輯計畫`
- `Discard` → `取消這次計畫`
- `Undo` → `復原`
- `Redo` → `重做`
- `Export video` → `輸出影片`
- `Job failed` → `任務執行失敗`

### 語氣要求

使用自然、簡潔的台灣繁體中文。

避免：

- 機翻腔
- 中英混雜
- 過度技術化
- 每個按鈕都塞很長文字

Agent 對使用者的說法也必須中文化，例如：

> 我找到 14 個較長的停頓，預計可縮短約 42 秒。你可以先逐項預覽，再決定是否套用。

### 技術要求

不要把中文散落硬編碼在所有 component。

建立最小 i18n 層：

```text
apps/web/i18n/
  zh-TW.ts
  index.ts
```

第一版只需要 zh-TW，但 key 結構需保留未來擴充能力。

程式內部：

- TypeScript identifiers 保持英文
- API schema 保持英文
- database fields 保持英文
- domain model 保持英文
- user-facing copy 使用 zh-TW

這樣避免日後維護困難。

## P0 — 中文 Agent Activity

不要顯示隱藏思考鏈。

顯示可驗證的活動狀態：

- `正在讀取影片分析結果`
- `正在檢查時間軸`
- `找到 8 個可調整片段`
- `正在建立剪輯計畫`
- `剪輯計畫已完成，等待你確認`
- `正在套用修改`
- `正在驗證結果`
- `完成`

## P0 — Edit Review 中文化 + 操作級預覽

每個 operation 卡片需顯示：

- 中文操作名稱
- 時間範圍
- 影響秒數
- Agent 理由
- 風險等級
- 預覽
- 保留
- 套用/排除

例如：

```text
刪除停頓
00:31.20 – 00:33.48
將移除 2.28 秒
原因：偵測到長時間無語音區段

[預覽] [保留這段] [確認刪除]
```

## P1 — UI 結構

Desktop：

- 左：專案 / 素材
- 中：即時預覽 + Semantic Timeline
- 右：CUTOS 助手 + 操作審核 + Inspector

Mobile：

1. 影片預覽
2. CUTOS 助手
3. 建議操作
4. 操作審核
5. 輸出
6. Timeline 放次要頁籤

禁止把 desktop timeline 硬縮成手機版。

## P1 — UX 細節

- 套用 Edit Plan 後 Preview 必須自動更新
- Undo / Redo 後 Preview 必須更新
- 點 Timeline clip 可 seek 到對應 edited time
- Agent 建議可直接觸發 Preview
- 目前播放位置在刪除區段時，套用後要選擇合理的新播放位置
- Preview loading 不得鎖死整個 UI

## P1 — 錯誤與 fallback

必須處理：

- Browser 不支援 WebCodecs
- MediaSource 不支援 codec
- Source media range request 失敗
- Preview manifest stale
- Timeline revision changed
- segment decode error
- seek mapping error

使用者看到的是中文可理解訊息，不是 raw stack trace。

## 測試

新增：

- time mapping unit tests
- preview compiler tests
- preview/export parity tests
- stale revision tests
- undo/redo preview tests
- Chinese UI snapshot/string coverage
- mobile layout smoke test

保留並通過既有測試。

## Definition of Done

PR 完成時至少必須做到：

- 套用 trim/delete/silence removal 後，不經 full FFmpeg render 即可預覽
- set_speed 可正確預覽
- Timeline seek 與 Player 同步
- Undo / Redo 即時反映
- Preview 與 export 在 duration + segment semantics 一致
- 全部主要使用者介面為繁體中文
- Agent Activity 為中文
- 錯誤訊息為中文
- Mobile 主要流程可用
- lint 通過
- typecheck 通過
- tests 通過
- build 通過

## 不要做

本 PR 暫時不要擴張到：

- 真正 speaker diarization
- scene detection
- highlight AI
- auto reframe
- 多機位
- 高階調色
- 複雜 transition engine
- marketplace
- collaboration

這些留給後續 PR。

本 PR 只專注兩件事：

1. 讓剪輯結果可以立即預覽。
2. 讓 CUTOS 成為完整、自然的繁體中文產品體驗。
