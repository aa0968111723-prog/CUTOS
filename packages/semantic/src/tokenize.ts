/**
 * Deterministic, offline, language-mixed tokenizer.
 *
 * CUTOS must be able to search a Traditional Chinese interview transcript with
 * zero external services, so the retrieval layer cannot depend on an embedding
 * vendor. CJK text is split into overlapping bigrams (the standard trick for
 * index-time segmentation without a dictionary), Latin text into lowercased
 * word stems. Same input → same tokens, always: retrieval results are part of
 * the protocol's `contextHash`, so any non-determinism here would break
 * cross-repo reproducibility.
 */

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;
const LATIN_WORD = /[a-z0-9][a-z0-9'’-]*/g;

/** Words carrying no retrieval signal in either language. */
const STOPWORDS = new Set([
  // English
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "had",
  "has", "have", "he", "her", "his", "i", "in", "is", "it", "its", "of", "on",
  "or", "our", "she", "so", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "to", "was", "we", "were", "what", "when", "which",
  "who", "will", "with", "you", "your",
  // Chinese function words (bigram forms are filtered by `isStopBigram`)
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一", "個",
  "上", "也", "很", "到", "說", "要", "去", "你", "會", "著", "沒", "看", "好",
  "自", "這", "那", "麼", "們", "嗎", "呢", "吧", "啊", "喔", "欸", "嗯",
]);

const STOP_BIGRAMS = new Set([
  "我們", "他們", "你們", "這個", "那個", "什麼", "怎麼", "所以", "但是",
  "然後", "因為", "如果", "可以", "就是", "還有", "而且", "其實", "真的",
  "一個", "一下", "一直", "這樣", "那樣",
]);

export function isCjk(char: string): boolean {
  return CJK.test(char);
}

function isStopBigram(token: string): boolean {
  return STOP_BIGRAMS.has(token);
}

/**
 * Tokenize one piece of text. Returns tokens in document order, duplicates
 * kept (callers that need a set build one).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // Latin / digit runs.
  for (const match of lower.matchAll(LATIN_WORD)) {
    const word = match[0];
    if (word.length < 2) continue;
    if (STOPWORDS.has(word)) continue;
    tokens.push(word);
  }

  // CJK: overlapping bigrams, plus single chars that are not stopwords.
  let run = "";
  const flush = () => {
    if (!run) return;
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) tokens.push(run);
    } else {
      for (let i = 0; i + 1 < run.length; i += 1) {
        const bigram = run.slice(i, i + 2);
        if (!isStopBigram(bigram)) tokens.push(bigram);
      }
    }
    run = "";
  };
  for (const char of text) {
    if (isCjk(char)) run += char;
    else flush();
  }
  flush();

  return tokens;
}

/** Character length used for context budgeting (CJK chars count as 1). */
export function charLength(text: string): number {
  return [...text].length;
}
