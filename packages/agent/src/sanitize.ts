import {
  FrameExtractionError,
  MalformedModelResponseError,
  VisionNotConfiguredError,
  VisionTimeoutError,
} from "./vision.js";

const ZOD_MIN_ARRAY = /Array must contain at least 1 element/;
const ZOD_GENERIC = /(?:expected|required|invalid_type|too_small|too_big)/i;
const JSON_PARSE = /(?:Unexpected token|JSON|not valid JSON|Unterminated)/i;

/**
 * Map thrown errors onto a user-facing zh-TW sentence. Zod internals, HTTP
 * status lines and API keys must never reach the chat surface.
 */
export function sanitizeAgentError(error: unknown): string {
  if (error instanceof VisionNotConfiguredError) return error.message;
  if (error instanceof FrameExtractionError) {
    return `我目前無法讀取該時間點的畫面，你可以重新載入影片後再試一次。`;
  }
  if (error instanceof VisionTimeoutError) {
    return "分析這一幕時超過等待時間，要不要再試一次？";
  }
  if (error instanceof MalformedModelResponseError) return error.message;

  const raw = error instanceof Error ? error.message : String(error);
  const stripped = raw.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");

  if (ZOD_MIN_ARRAY.test(stripped) || /operations:.*at least 1/i.test(stripped)) {
    return "我目前沒有可執行的剪輯操作。如果你是在問畫面內容，直接告訴我時間點即可。";
  }
  if (JSON_PARSE.test(stripped) || /malformed/i.test(stripped)) {
    return "模型回傳的內容格式不正確，我沒有套用任何修改。請再試一次。";
  }
  if (ZOD_GENERIC.test(stripped) && /operations|plan|schema/i.test(stripped)) {
    return "模型回傳的剪輯計畫無法通過驗證，我沒有套用任何修改。請再試一次。";
  }
  if (/timeout|timed out|abort/i.test(stripped)) {
    return "分析這一幕時超過等待時間，要不要再試一次？";
  }
  if (/Provider request failed:\s*401|unauthorized/i.test(stripped)) {
    return "視覺模型目前無法使用，請稍後再試，或先依逐字稿與時間軸操作。";
  }
  if (/Provider request failed/i.test(stripped)) {
    return "視覺模型目前沒有回應，請稍後再試。";
  }
  // Never echo internals.
  return "我沒辦法完成這個要求，請換個說法或稍後再試。";
}

export function frameFailureMessage(timeMs: number): string {
  const total = Math.max(0, Math.round(timeMs));
  const mm = String(Math.floor(total / 60_000)).padStart(2, "0");
  const ss = String(Math.floor((total % 60_000) / 1000)).padStart(2, "0");
  return `我目前無法讀取 ${mm}:${ss} 的畫面，你可以重新載入影片後再試一次。`;
}
