import { formatTimecode, msToSec } from "@cutos/edit-dsl";
import type { Planner, PlanRequest, ProposedEdits, SilenceInterval } from "./types.js";

/**
 * Deterministic, offline planner. Understands both English and Traditional
 * Chinese (zh-TW) editing instructions and maps them onto the Edit DSL. Its
 * user-facing `summary`/`reason` copy is zh-TW; the DSL schema stays English.
 */
export class LocalHeuristicPlanner implements Planner {
  readonly name = "local-heuristic";

  async propose(request: PlanRequest): Promise<ProposedEdits> {
    const operations: unknown[] = [];
    const summaries: string[] = [];

    if (wantsPauseRemoval(request.instruction)) {
      const thresholdMs = parseThresholdMs(request.instruction) ?? 0;
      const targets = request.silences.filter((s) => s.endMs - s.startMs >= thresholdMs);
      for (const silence of targets) operations.push(buildRemoveRange(silence));
      if (targets.length > 0) {
        const removedMs = targets.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
        summaries.push(
          `刪除 ${targets.length} 個停頓（共約 ${msToSec(removedMs).toFixed(1)} 秒` +
            (thresholdMs > 0 ? `，長度超過 ${msToSec(thresholdMs).toFixed(1)} 秒` : "") +
            `）。`,
        );
      } else {
        summaries.push("沒有符合條件的停頓可以刪除。");
      }
    }

    const speed = parseSpeed(request.instruction);
    if (speed !== null && speed !== 1) {
      operations.push({
        type: "setSpeed",
        startMs: 0,
        endMs: request.sourceDurationMs,
        speed,
        reason: `將整體播放速度設為 ${speed}x`,
      });
      summaries.push(`將整體速度調整為 ${speed}x。`);
    }

    return {
      summary: summaries.join(" ") || "我沒辦法從這個要求得出可執行的剪輯。",
      operations,
    };
  }
}

function buildRemoveRange(silence: SilenceInterval) {
  return {
    type: "removeRange",
    startMs: silence.startMs,
    endMs: silence.endMs,
    reason: `靜音停頓 ${formatTimecode(silence.startMs)}–${formatTimecode(silence.endMs)}`,
  };
}

// --- intent parsing (English + zh-TW) ---

const CJK_NUMERALS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function parseNumberToken(token: string): number | null {
  if (/^\d/.test(token)) {
    const value = Number.parseFloat(token);
    return Number.isFinite(value) ? value : null;
  }
  if (token.length === 1) return CJK_NUMERALS[token] ?? null;
  if (token === "十") return 10;
  // e.g. 十二 / 二十
  if (token.startsWith("十")) {
    const rest = CJK_NUMERALS[token.slice(1)] ?? 0;
    return 10 + rest;
  }
  if (token.endsWith("十")) {
    const tens = CJK_NUMERALS[token.slice(0, 1)] ?? 1;
    return tens * 10;
  }
  return null;
}

const EN_DURATION_RE = /(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds)\b/i;
const ZH_DURATION_RE = /([零一二兩三四五六七八九十]+|\d+(?:\.\d+)?)\s*(毫秒|秒)/;

function parseThresholdMs(instruction: string): number | null {
  const en = EN_DURATION_RE.exec(instruction);
  if (en?.[1] && en[2]) {
    const value = Number.parseFloat(en[1]);
    const unit = en[2].toLowerCase();
    return unit.startsWith("ms") || unit.startsWith("milli") ? Math.round(value) : Math.round(value * 1000);
  }
  const zh = ZH_DURATION_RE.exec(instruction);
  if (zh?.[1] && zh[2]) {
    const value = parseNumberToken(zh[1]);
    if (value === null) return null;
    return zh[2] === "毫秒" ? Math.round(value) : Math.round(value * 1000);
  }
  return null;
}

const EN_SPEED_MULTIPLIER_RE = /(\d+(?:\.\d+)?)\s*x/i;
const ZH_SPEED_MULTIPLIER_RE = /([零一二兩三四五六七八九十]+|\d+(?:\.\d+)?)\s*倍/;

function parseSpeed(instruction: string): number | null {
  const text = instruction.toLowerCase();

  const enMul = EN_SPEED_MULTIPLIER_RE.exec(text);
  if (enMul?.[1]) return Number.parseFloat(enMul[1]);

  const zhMul = ZH_SPEED_MULTIPLIER_RE.exec(instruction);
  if (zhMul?.[1]) {
    const value = parseNumberToken(zhMul[1]);
    if (value !== null && value > 0) return value;
  }

  if (/\bdouble\b/.test(text) || /雙倍|加倍/.test(instruction)) return 2;
  if (/\bhalf\b|\bslow(?:er|\s*down)?\b/.test(text) || /放慢|慢一點|慢一些|變慢|減速|一半|慢速/.test(instruction)) {
    return 0.5;
  }
  if (
    /\bspeed\s*up\b|\bfaster\b|\bspeed\b/.test(text) ||
    /加速|快一點|快一些|快點|更快|剪快|節奏.*快|速度.*快/.test(instruction)
  ) {
    return 1.5;
  }
  return null;
}

function wantsPauseRemoval(instruction: string): boolean {
  if (/\b(pause|pauses|silence|silences|silent|quiet|dead\s*air|gap|gaps)\b/i.test(instruction)) {
    return true;
  }
  return /停頓|空白|靜音|安靜|沉默|空檔|冷場|留白|沒有?聲音|沒聲音|沒有內容|沒內容/.test(instruction);
}
