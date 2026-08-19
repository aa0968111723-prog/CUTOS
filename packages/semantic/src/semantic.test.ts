import { describe, expect, it } from "vitest";
import type { Transcript } from "@cutos/media";
import { cutosSemanticContextSchema } from "@cutos/protocol";
import { buildSemanticIndex } from "./index-build.js";
import { searchSemantic, searchTranscript } from "./search.js";
import { listSpeakers, listTopics } from "./topics.js";
import { findHighlights } from "./highlights.js";
import { getContextRange, inspectScene } from "./scene.js";
import { buildSemanticContext } from "./context.js";
import { tokenize } from "./tokenize.js";

/** A synthetic 45-minute-shaped zh-TW interview: two speakers, three themes. */
function interview(): Transcript {
  const lines: Array<[string, string]> = [
    ["主持人", "今天我們要談的是遠距工作的挑戰與機會。"],
    ["來賓", "遠距工作最大的挑戰是溝通成本變高。"],
    ["來賓", "團隊如果沒有明確的文件文化，遠距溝通就會失敗。"],
    ["主持人", "所以文件文化是遠距工作的基礎。"],
    ["來賓", "對，文件文化讓非同步溝通變得可能。"],
    ["主持人", "那我們談談招募，遠距招募有什麼不同？"],
    ["來賓", "遠距招募可以接觸到全世界的人才。"],
    ["來賓", "但是招募流程必須重新設計，面試要更結構化。"],
    ["主持人", "結構化面試能減少偏誤嗎？"],
    ["來賓", "結構化面試確實能減少偏誤，這是有研究支持的。"],
    ["主持人", "最後聊聊工具，你們團隊用什麼工具？"],
    ["來賓", "我們用文件工具跟非同步影片，會議反而變少了。"],
    ["來賓", "非同步影片讓時區不同的同事也能參與討論。"],
    ["主持人", "謝謝你今天的分享。"],
  ];
  return {
    language: "zh-TW",
    provider: "test-fixture",
    sentences: lines.map(([speaker, text], i) => ({
      id: `s${i}`,
      startMs: i * 10_000,
      endMs: i * 10_000 + 8_000,
      text,
      speaker,
    })),
  };
}

function index() {
  return buildSemanticIndex({
    projectId: "p1",
    mediaChecksum: "checksum-abc",
    analysisVersion: 1,
    transcript: interview(),
    totalDurationMs: 140_000,
  });
}

describe("tokenizer", () => {
  it("splits CJK into bigrams and drops function words", () => {
    const tokens = tokenize("我們的遠距工作");
    expect(tokens).toContain("遠距");
    expect(tokens).toContain("距工");
    expect(tokens).not.toContain("我們");
  });

  it("lowercases Latin words and drops stopwords", () => {
    expect(tokenize("The Remote Working Team")).toEqual(["remote", "working", "team"]);
  });

  it("is deterministic", () => {
    expect(tokenize("結構化面試")).toEqual(tokenize("結構化面試"));
  });
});

describe("semantic search", () => {
  it("finds topically related sentences the query does not literally contain", () => {
    const hits = searchSemantic(index(), "招募人才");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.sentence.text).toContain("招募");
  });

  it("orders by score then timeline position", () => {
    const hits = searchSemantic(index(), "文件文化");
    const scores = hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("returns nothing for a query with no indexed terms", () => {
    expect(searchSemantic(index(), "量子色動力學")).toEqual([]);
  });

  it("honours speaker and time filters", () => {
    const hits = searchSemantic(index(), "遠距", { speaker: "主持人" });
    expect(hits.every((h) => h.sentence.speaker === "主持人")).toBe(true);
    const windowed = searchSemantic(index(), "遠距", { startMs: 0, endMs: 20_000 });
    expect(windowed.every((h) => h.sentence.startMs < 20_000)).toBe(true);
  });

  it("literal search only matches substrings", () => {
    expect(searchTranscript(index(), "結構化面試").length).toBe(2);
    expect(searchTranscript(index(), "招募人才")).toEqual([]);
  });
});

describe("topics and speakers", () => {
  it("extracts recurring terms as topics with real time spans", () => {
    const topics = listTopics(index(), 5);
    expect(topics.length).toBeGreaterThan(0);
    for (const topic of topics) {
      expect(topic.endMs).toBeGreaterThanOrEqual(topic.startMs);
      expect(topic.sentenceCount).toBeGreaterThanOrEqual(2);
    }
  });

  it("aggregates speaking time per speaker", () => {
    const speakers = listSpeakers(index());
    expect(speakers.map((s) => s.id).sort()).toEqual(["主持人", "來賓"]);
    expect(speakers[0]!.speakingMs).toBeGreaterThan(0);
  });
});

describe("highlights", () => {
  it("returns non-overlapping, scored, explainable candidates", () => {
    const highlights = findHighlights(index(), { targetDurationMs: 30_000, limit: 3 });
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < highlights.length; i += 1) {
      expect(highlights[i]!.startMs).toBeGreaterThanOrEqual(highlights[i - 1]!.endMs);
    }
    for (const highlight of highlights) {
      expect(highlight.reasonCode).toBeTruthy();
      expect(highlight.excerpt.length).toBeLessThanOrEqual(200);
    }
  });

  it("is deterministic for the same index and options", () => {
    const a = findHighlights(index(), { targetDurationMs: 30_000, limit: 3 });
    const b = findHighlights(index(), { targetDurationMs: 30_000, limit: 3 });
    expect(a).toEqual(b);
  });
});

describe("scene inspection", () => {
  it("describes a window without dumping the transcript", () => {
    const scene = inspectScene(index(), 0, 40_000);
    expect(scene.sentenceCount).toBe(4);
    expect(scene.speakers).toEqual(["主持人", "來賓"]);
    expect(scene.keyTerms.length).toBeGreaterThan(0);
    expect(scene.speechMs).toBeGreaterThan(0);
  });

  it("bounds get_context_range by sentence and char caps", () => {
    const range = getContextRange(index(), 0, 200_000, { maxSentences: 3 });
    expect(range.sentences.length).toBe(3);
    expect(range.truncated).toBe(true);
    const tight = getContextRange(index(), 0, 200_000, { maxChars: 20 });
    expect(tight.truncated).toBe(true);
  });
});

describe("bounded semantic context", () => {
  it("validates against the protocol schema", () => {
    const context = buildSemanticContext({
      index: index(),
      projectId: "p1",
      timelineRevision: 3,
      query: "遠距招募",
      requestId: "req-1",
      capability: "search_semantic",
      now: () => 1_700_000_000_000,
    });
    expect(() => cutosSemanticContextSchema.parse(context)).not.toThrow();
  });

  it("never emits the full transcript and reports the budget it enforced", () => {
    const context = buildSemanticContext({
      index: index(),
      projectId: "p1",
      timelineRevision: 3,
      query: "遠距",
      requestId: "req-2",
      capability: "search_semantic",
      budget: { maxRanges: 2, maxChars: 60 },
      now: () => 1_700_000_000_000,
    });
    expect(context.ranges.length).toBeLessThanOrEqual(2);
    expect(context.budget.truncated).toBe(true);
    expect(context.budget.usedChars).toBeLessThanOrEqual(60);
    expect(context.ranges.length).toBeLessThan(interview().sentences.length);
  });

  it("emits ranges in timeline order and deduplicates seeds", () => {
    const seed = {
      startMs: 0,
      endMs: 8_000,
      text: "今天我們要談的是遠距工作的挑戰與機會。",
      speaker: "主持人",
      score: 1,
      sentenceIds: ["s0"],
    };
    const context = buildSemanticContext({
      index: index(),
      projectId: "p1",
      timelineRevision: 3,
      query: "遠距工作",
      requestId: "req-3",
      capability: "search_semantic",
      seedRanges: [seed, { ...seed }],
      now: () => 1_700_000_000_000,
    });
    const starts = context.ranges.map((r) => r.startMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(context.ranges.filter((r) => r.sentenceIds.includes("s0")).length).toBe(1);
  });

  it("produces a stable contextHash for identical inputs", () => {
    const build = () => buildSemanticContext({
      index: index(),
      projectId: "p1",
      timelineRevision: 3,
      query: "文件文化",
      requestId: "req-4",
      capability: "search_semantic",
      now: () => 1_700_000_000_000,
    });
    expect(build().provenance.contextHash).toBe(build().provenance.contextHash);
  });

  it("changes contextHash when the timeline revision moves", () => {
    const at = (revision: number) => buildSemanticContext({
      index: index(),
      projectId: "p1",
      timelineRevision: revision,
      query: "文件文化",
      requestId: "req-5",
      capability: "search_semantic",
      now: () => 1_700_000_000_000,
    }).provenance.contextHash;
    expect(at(3)).not.toBe(at(4));
  });
});
