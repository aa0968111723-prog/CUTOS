import { parseTimeRefs, type TimeRef } from "./time-parse.js";

/**
 * User intents the conversation router understands. Only `edit` is allowed to
 * produce an Edit Plan with operations.length >= 1. Question intents must
 * never be forced through the planner.
 */
export type UserIntentKind =
  | "inspect_current_frame"
  | "inspect_time"
  | "ask_video_question"
  | "semantic_search"
  | "edit"
  | "transport_control"
  | "clarification"
  | "unsupported";

export interface ClassifiedIntent {
  primary: UserIntentKind;
  secondary: UserIntentKind[];
  timeRefs: TimeRef[];
  raw: string;
  confidence: number;
  /** True when answering requires looking at pixels (or a visual index). */
  needsVision: boolean;
  /** True only when the user is asking to change the timeline. */
  needsEditPlan: boolean;
}

const EDIT_RE =
  /(?:刪掉|刪除|剪掉|剪掉這|剪掉那|裁切|裁掉|去掉|拿掉|加速|放慢|變速|倍速|配字幕|加字幕|加標記|從.{0,24}開始|就從這|從這(?:裡|邊)?開始|trim|remove|cut\b|keep from|speed\s*up|slow\s*down)/i;

const KEEP_QUESTION_RE = /(?:可以留下|要不要留|該不該留|留得住嗎)/;

const VISUAL_Q_RE =
  /(?:看[得]到|看得到|看得見|看的到|是什麼|拿什麼|手上|在做什麼|在幹嘛|誰|穿什麼|長什麼樣|發生什麼|描述|畫面|這一幕是|那一幕是|怎麼看起來)/;

const SEARCH_RE =
  /(?:哪裡有|哪裏有|哪裡|哪裏|找出|找到|找一下|是哪一段|哪一段|哪個畫面|有沒有人|有沒有.*畫面|搜尋)/;

const TRANSPORT_RE = /(?:播放|暫停|停止|繼續播|跳到|快轉到|倒轉|靜音)/;

const DEIXIS_RE = /(?:這裡|這邊|這幕|這一幕|這個|目前|現在)/;
const LAST_RE = /(?:剛剛|剛才|上一幕)/;

const CLARIFY_RE = /(?:還是|或者|怎樣|怎麼辦|你覺得)/;

function unique(kinds: UserIntentKind[]): UserIntentKind[] {
  const seen = new Set<UserIntentKind>();
  const out: UserIntentKind[] = [];
  for (const kind of kinds) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.push(kind);
  }
  return out;
}

/**
 * Deterministic intent classifier. A hosted fast model may refine low-confidence
 * results, but this function is the source of truth for the tests and the
 * offline path: "0:25 那邊你看得到嗎" is never an edit.
 */
export function classifyIntent(text: string): ClassifiedIntent {
  const raw = text.trim();
  if (!raw) {
    return {
      primary: "clarification",
      secondary: [],
      timeRefs: [],
      raw,
      confidence: 1,
      needsVision: false,
      needsEditPlan: false,
    };
  }

  const timeRefs = parseTimeRefs(raw);
  const hasAbsolute = timeRefs.some((r) => r.kind === "absolute");
  const hasPlayhead = timeRefs.some((r) => r.kind === "playhead") || DEIXIS_RE.test(raw);
  const hasLast = timeRefs.some((r) => r.kind === "last") || LAST_RE.test(raw);
  const isVisualQ = VISUAL_Q_RE.test(raw);
  const isSearch = SEARCH_RE.test(raw);
  const isTransport = TRANSPORT_RE.test(raw);
  const isKeepQuestion = KEEP_QUESTION_RE.test(raw);
  const isEdit = EDIT_RE.test(raw) && !isKeepQuestion;

  const kinds: UserIntentKind[] = [];

  if (isTransport && !isEdit && !isVisualQ) kinds.push("transport_control");

  if (isEdit) kinds.push("edit");

  if (isSearch && !isEdit) kinds.push("semantic_search");
  // "從女生抱傳單這裡開始" is an edit that first needs a visual lookup.
  if (isEdit && isSearch) kinds.push("semantic_search");
  if (isEdit && /從.{0,24}開始/.test(raw) && !hasAbsolute) {
    // Landmark-based start ("從女生抱傳單這裡開始") needs visual search
    // unless the user already named a clock time.
    if (!kinds.includes("semantic_search") && !/從這(?:裡|邊)?開始|就從這/.test(raw)) {
      kinds.push("semantic_search");
    }
  }

  if (isVisualQ || isKeepQuestion) kinds.push("ask_video_question");

  if (hasAbsolute && (isVisualQ || isKeepQuestion || (!isEdit && !isTransport && !isSearch))) {
    kinds.push("inspect_time");
  } else if ((hasPlayhead || hasLast) && (isVisualQ || isKeepQuestion || (!isEdit && !isTransport))) {
    kinds.push("inspect_current_frame");
  }

  if (hasAbsolute && !kinds.includes("inspect_time") && (isVisualQ || kinds.includes("ask_video_question"))) {
    kinds.push("inspect_time");
  }

  // Bare clock / "25秒" with no other signal → inspect that time.
  if (kinds.length === 0 && hasAbsolute) kinds.push("inspect_time");
  if (kinds.length === 0 && (hasPlayhead || hasLast)) kinds.push("inspect_current_frame");

  if (kinds.length === 0 && CLARIFY_RE.test(raw)) kinds.push("clarification");
  if (kinds.length === 0) kinds.push("unsupported");

  const ordered = unique(kinds);
  // Prefer inspect_time over inspect_current_frame when an absolute time exists.
  if (hasAbsolute && ordered.includes("inspect_time") && ordered.includes("inspect_current_frame")) {
    ordered.splice(ordered.indexOf("inspect_current_frame"), 1);
  }

  const primary = ordered[0] ?? "unsupported";
  const secondary = ordered.slice(1);

  const needsEditPlan = primary === "edit" || secondary.includes("edit");
  const needsVision =
    !needsEditPlan || secondary.includes("semantic_search")
      ? ordered.some((k) =>
          k === "inspect_time" ||
          k === "inspect_current_frame" ||
          k === "ask_video_question" ||
          k === "semantic_search",
        )
      : secondary.includes("semantic_search");

  // Landmark edits still need vision if they name a visual target.
  const landmarkEdit = needsEditPlan && secondary.includes("semantic_search");

  return {
    primary,
    secondary,
    timeRefs,
    raw,
    confidence: primary === "unsupported" ? 0.4 : 0.9,
    needsVision: needsVision || landmarkEdit || isVisualQ,
    needsEditPlan,
  };
}

export function intentNeedsEditPlan(intent: ClassifiedIntent): boolean {
  return intent.needsEditPlan;
}
