import { describe, expect, it } from "vitest";
import { sanitizeAgentError } from "./sanitize.js";
import { MalformedModelResponseError, VisionNotConfiguredError } from "./vision.js";

describe("sanitizeAgentError", () => {
  it("never forwards the Zod empty-operations message", () => {
    const message = sanitizeAgentError(new Error("operations: Array must contain at least 1 element(s)"));
    expect(message).not.toMatch(/Array must contain/);
    expect(message).not.toMatch(/operations:/);
    expect(message.length).toBeGreaterThan(0);
  });

  it("maps a malformed model response to zh-TW", () => {
    expect(sanitizeAgentError(new MalformedModelResponseError())).toContain("格式不正確");
  });

  it("maps a missing vision provider to the natural fallback", () => {
    expect(sanitizeAgentError(new VisionNotConfiguredError())).toContain("尚未設定影片視覺理解模型");
  });

  it("redacts bearer tokens", () => {
    const message = sanitizeAgentError(new Error("Provider request failed: 401 Bearer sk-secret"));
    expect(message).not.toContain("sk-secret");
  });
});
