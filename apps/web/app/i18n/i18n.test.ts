import { describe, expect, it } from "vitest";
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

    const codes = [
      "PROJECT_NOT_FOUND",
      "MEDIA_UNSUPPORTED",
      "UPLOAD_TOO_LARGE",
      "STALE_EDIT_PLAN",
      "PREVIEW_UNSUPPORTED",
      "EXPORT_FAILED",
    ];
    for (const code of codes) expect(errorMessage(code)).not.toBe(t("error.UNKNOWN"));
  });
});
