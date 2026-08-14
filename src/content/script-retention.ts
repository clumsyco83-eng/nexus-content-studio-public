export interface ScriptRetentionOptions {
  targetSeconds?: number;
  minWordsPerSecond?: number;
  maxWordsPerSecond?: number;
  maxOpeningSentenceWords?: number;
  maxSentenceWords?: number;
}

export interface ScriptRetentionReport {
  passed: boolean;
  score: number;
  wordCount: number;
  estimatedSpokenSeconds: number;
  openingSentenceWords: number;
  longestSentenceWords: number;
  blockers: string[];
  warnings: string[];
}

const genericOpeners = [
  /^in today(?:'|’)s (?:video|post)/i,
  /^have you ever wondered/i,
  /^did you know that/i,
  /^in a world where/i,
];

function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function sentenceWordCounts(script: string): number[] {
  const sentences = script.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  return sentences.map((sentence) => words(sentence).length);
}

export function validateScriptRetention(script: string, options: ScriptRetentionOptions = {}): ScriptRetentionReport {
  const targetSeconds = options.targetSeconds ?? 60;
  const minWordsPerSecond = options.minWordsPerSecond ?? 1.6;
  const maxWordsPerSecond = options.maxWordsPerSecond ?? 3.0;
  const maxOpeningSentenceWords = options.maxOpeningSentenceWords ?? 22;
  const maxSentenceWords = options.maxSentenceWords ?? 36;

  if (targetSeconds <= 0 || minWordsPerSecond <= 0 || maxWordsPerSecond <= minWordsPerSecond) {
    throw new Error('Invalid script-retention timing policy.');
  }

  const trimmed = script.trim();
  const wordCount = words(trimmed).length;
  const sentenceCounts = sentenceWordCounts(trimmed);
  const openingSentenceWords = sentenceCounts[0] ?? wordCount;
  const longestSentenceWords = sentenceCounts.length ? Math.max(...sentenceCounts) : wordCount;
  const minWords = Math.floor(targetSeconds * minWordsPerSecond);
  const maxWords = Math.ceil(targetSeconds * maxWordsPerSecond);
  const estimatedSpokenSeconds = wordCount === 0 ? 0 : Math.round((wordCount / 2.4) * 10) / 10;
  const blockers: string[] = [];
  const warnings: string[] = [];
  let score = 100;

  if (!trimmed) {
    blockers.push('Script is empty.');
    score = 0;
  } else {
    if (wordCount < minWords) { blockers.push(`Script is too short for the ${targetSeconds}s target: ${wordCount} words; minimum policy is ${minWords}.`); score -= 35; }
    if (wordCount > maxWords) { blockers.push(`Script is too dense for the ${targetSeconds}s target: ${wordCount} words; maximum policy is ${maxWords}.`); score -= 35; }
    if (openingSentenceWords > maxOpeningSentenceWords) { warnings.push(`Opening sentence is ${openingSentenceWords} words; policy target is <= ${maxOpeningSentenceWords}.`); score -= 12; }
    if (longestSentenceWords > maxSentenceWords) { warnings.push(`Longest sentence is ${longestSentenceWords} words; policy target is <= ${maxSentenceWords}.`); score -= 10; }
    if (genericOpeners.some((pattern) => pattern.test(trimmed))) { warnings.push('Opening matches a generic hook pattern; rewrite for a more specific Curious Grit promise.'); score -= 10; }
    if (sentenceCounts.length < 4) { warnings.push('Script has fewer than four sentence beats; check pacing manually.'); score -= 8; }
  }

  score = Math.max(0, Math.min(100, score));
  return { passed: blockers.length === 0 && score >= 70, score, wordCount, estimatedSpokenSeconds, openingSentenceWords, longestSentenceWords, blockers, warnings };
}
