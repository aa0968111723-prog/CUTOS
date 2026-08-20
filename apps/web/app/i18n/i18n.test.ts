import { describe, expect, it } from "vitest";
import { APP_ERROR_CODES } from "../../server/errors.js";
import { zhTW, type MessageKey } from "./zh-TW.js";
import { activityLabel, errorMessage, operationLabel, t, translate } from "./index.js";

describe("i18n", () => {
  it("returns zh-TW copy for a key", () => {
    expect(t("home.loadDemo")).toBe("載入示範影片");
  });

  it("interpolates parameters", () => {
    expect(t("import.imported", { name: "示範" })).toContain("示範");
    expect(t("agent.foundPauses", { count: 4 })).toContain("4");
  });

  it("falls back to the key for a missing key", () => {
    expect(translate("zh-TW", "does.not.exist" as MessageKey)).toBe("does.not.exist");
  });

  it("maps error codes to zh-TW and unknown codes to a generic message", () => {
    expect(errorMessage("MEDIA_UNSUPPORTED")).toBe("目前不支援這個影片格式。");
    expect(errorMessage("SOMETHING_NEW")).toBe(t("error.UNKNOWN"));
    expect(errorMessage(undefined)).toBe(t("error.UNKNOWN"));
  });

  it("maps agent step kinds and operation types", () => {
    expect(activityLabel("plan")).toBe("已建立剪輯計畫");
    expect(operationLabel("removeRange")).toBe("刪除片段");
    expect(operationLabel("setSpeed")).toBe("調整速度");
    // Unknown falls back to the raw token.
    expect(operationLabel("mysteryOp")).toBe("mysteryOp");
  });

  it("has no empty values and uses Traditional (not Simplified) Chinese", () => {
    const simplifiedMarkers = ["视频", "撤销", "导入", "时间轴", "确认删除", "预览"];
    for (const [key, value] of Object.entries(zhTW)) {
      expect(value.length, `empty value for ${key}`).toBeGreaterThan(0);
      for (const bad of simplifiedMarkers) {
        expect(value.includes(bad), `simplified term "${bad}" in ${key}`).toBe(false);
      }
    }
  });

  it("covers the cutos.agent.v2 bridge status copy", () => {
    // The AIOS panel renders these directly; a missing key would show the raw
    // identifier to the user.
    for (const key of [
      "aios.protocol",
      "aios.protocolIncompatible",
      "aios.orchestration",
      "aios.orchestrated",
      "aios.waitingAios",
      "aios.selfDriven",
      "aios.features",
      "aios.capabilityCount",
    ] as const) {
      expect(t(key), `missing copy for ${key}`).not.toBe(key);
    }
  });

  it("labels every bridge feature flag the server advertises", () => {
    // Mirrors FEATURES in apps/web/server/aios-bridge.ts.
    const featureKeys = [
      "aios.feature.semantic",
      "aios.feature.idempotency",
      "aios.feature.revisionGuard",
      "aios.feature.approval",
      "aios.feature.activityLog",
      "aios.feature.longRunningJobs",
      "aios.feature.cancellation",
      "aios.feature.orchestrator",
    ] as const;
    for (const key of featureKeys) expect(t(key)).not.toBe(key);
  });

  it("covers the cross-system progress copy in Traditional Chinese", () => {
    expect(t("bridge.activity.analyze")).toBe("正在分析影片");
    expect(t("bridge.activity.transcript")).toBe("逐字稿已完成");
    expect(t("bridge.activity.semanticSearch")).toBe("正在搜尋相關內容");
    expect(t("bridge.activity.plan")).toBe("正在建立剪輯計畫");
    expect(t("bridge.activity.verify")).toBe("正在驗證剪輯結果");
    expect(t("bridge.activity.approval")).toBe("需要你的確認");
    expect(t("bridge.activity.apply")).toBe("正在套用修改");
    expect(t("bridge.activity.export")).toBe("正在輸出影片");
    expect(t("bridge.activity.foundRanges", { count: 8 })).toBe("找到 8 個相關片段");
  });

  it("explains the v2 guards in zh-TW rather than leaking an error code", () => {
    expect(t("bridge.staleRevision")).toContain("時間軸");
    expect(t("bridge.approvalRequired")).toContain("確認");
    expect(t("bridge.replayed")).toContain("未重複執行");
  });

  it("covers every operation type and error code used by the app", () => {
    const opTypes = [
      "removeRange",
      "deleteRange",
      "trim",
      "split",
      "setSpeed",
      "caption",
      "marker",
    ];
    for (const op of opTypes) expect(operationLabel(op)).not.toBe(op);

    // Exhaustive, not a sample: every code the server can emit must have copy,
    // or the user sees the generic fallback instead of something actionable.
    expect(APP_ERROR_CODES.length).toBeGreaterThan(15);
    const uncovered = APP_ERROR_CODES.filter((code) => errorMessage(code) === t("error.UNKNOWN"));
    expect(uncovered, `缺少繁中文案的錯誤碼：${uncovered.join("、")}`).toEqual([]);
  });
});
