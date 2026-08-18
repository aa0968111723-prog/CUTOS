import type { Range } from "@cutos/edit-dsl";
import type { Sentence, Silence, Transcript, Word } from "./analysis.js";

export interface TranscribeContext {
  durationMs: number;
  /** Detected silences, used to segment speech when available. */
  silences?: Silence[];
}

/**
 * Transcription is behind an adapter so CUTOS is not tied to one ASR provider.
 * The gateway/runtime consumes the {@link Transcript} shape; swapping providers
 * never touches domain code.
 */
export interface Transcriber {
  readonly name: string;
  transcribe(filePath: string, ctx: TranscribeContext): Promise<Transcript>;
}

/** Non-silent spans = spoken regions (the complement of silence). */
export function computeSpeechRegions(silences: Silence[], durationMs: number): Range[] {
  const sorted = [...silences].sort((a, b) => a.startMs - b.startMs);
  const regions: Range[] = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.startMs > cursor) regions.push({ startMs: cursor, endMs: Math.min(s.startMs, durationMs) });
    cursor = Math.max(cursor, s.endMs);
  }
  if (cursor < durationMs) regions.push({ startMs: cursor, endMs: durationMs });
  return regions.filter((r) => r.endMs > r.startMs);
}

/**
 * Group timed words into sentences, breaking on sentence-final punctuation or a
 * pause longer than `maxGapMs`. Pure and deterministic.
 */
export function segmentIntoSentences(words: Word[], opts: { maxGapMs?: number } = {}): Sentence[] {
  const maxGap = opts.maxGapMs ?? 600;
  const sentences: Sentence[] = [];
  let current: Word[] = [];
  let index = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current.at(-1);
    if (!first || !last) return;
    sentences.push({
      id: `sent_${index}`,
      startMs: first.startMs,
      endMs: last.endMs,
      text: current.map((w) => w.text).join(" ").trim(),
      speaker: null,
      words: current.slice(),
    });
    index += 1;
    current = [];
  };

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!word) continue;
    current.push(word);
    const next = words[i + 1];
    const endsSentence = /[.!?]$/.test(word.text);
    const gap = next ? next.startMs - word.endMs : Number.POSITIVE_INFINITY;
    if (endsSentence || gap > maxGap) flush();
  }
  flush();
  return sentences;
}

/**
 * Deterministic, offline transcriber. Without a real ASR model it cannot
 * recognize words, so it segments the audio into timed speech regions with
 * placeholder text. It implements the same {@link Transcriber} contract as a
 * hosted ASR adapter, which can be dropped in to provide real words later.
 */
export class SilenceSegmentTranscriber implements Transcriber {
  readonly name = "silence-segmenter";

  async transcribe(_filePath: string, ctx: TranscribeContext): Promise<Transcript> {
    const regions = computeSpeechRegions(ctx.silences ?? [], ctx.durationMs);
    const sentences: Sentence[] = regions.map((r, i) => ({
      id: `seg_${i}`,
      startMs: r.startMs,
      endMs: r.endMs,
      text: `(speech segment ${i + 1})`,
      speaker: null,
    }));
    return { language: null, provider: this.name, sentences };
  }
}

export interface OpenAITranscriberOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => Promise<Uint8Array>;
}

/**
 * Adapter for an OpenAI-compatible speech-to-text endpoint (Whisper-style).
 * Optional; enabled only when configured. Implements the same contract as the
 * offline transcriber.
 */
export class OpenAICompatibleTranscriber implements Transcriber {
  readonly name: string;
  private readonly options: OpenAITranscriberOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAITranscriberOptions) {
    this.options = options;
    this.name = `openai-transcribe:${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(filePath: string, _ctx: TranscribeContext): Promise<Transcript> {
    if (!this.options.readFile) {
      throw new Error("OpenAICompatibleTranscriber requires a readFile implementation");
    }
    const bytes = await this.options.readFile(filePath);
    const form = new FormData();
    form.append("model", this.options.model);
    form.append("response_format", "verbose_json");
    form.append("file", new Blob([bytes]), "audio.wav");

    const res = await this.fetchImpl(`${this.options.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Transcription failed: ${res.status} ${res.statusText}`);

    const data = (await res.json()) as {
      language?: string;
      segments?: { start: number; end: number; text: string }[];
    };
    const sentences: Sentence[] = (data.segments ?? []).map((s, i) => ({
      id: `seg_${i}`,
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
      text: s.text.trim(),
      speaker: null,
    }));
    return { language: data.language ?? null, provider: this.name, sentences };
  }
}
