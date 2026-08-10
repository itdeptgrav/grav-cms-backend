"use strict";
/**
 * services/ai/transcriptCorrect.js — surgical fix-ups for the speech-to-text
 * output, applied AFTER Whisper and BEFORE the assistant sees the text.
 *
 * This is NOT a general phonetic corrector (those over-correct real words). It is
 * a small, evidence-based map of domain TERMS that Whisper reliably mis-hears in
 * this ERP and that are meaningless in any other reading — e.g. "leisure balance"
 * is never a real query here; it is always "ledger balance". Party / customer /
 * employee NAMES are deliberately left alone: they're biased at the STT layer
 * (sttVocab hotwords) and resolved fuzzily downstream, so correcting them here
 * would fight those systems.
 *
 * Add a new entry whenever a real, repeatable mishear shows up in the wild.
 */

// [pattern, replacement]. Patterns are matched case-insensitively with word
// boundaries; replacements preserve nothing of the original (these are fixed
// domain terms). Order matters only where a longer phrase should win first.
const RULES = [
  // "ledger" is the big one — spoken "le-jer" lands on leisure/lecture/leather.
  [/\bleisure\s+balance\b/gi, "ledger balance"],
  [/\blecture\s+balance\b/gi, "ledger balance"],
  [/\bleather\s*balance\b/gi, "ledger balance"],
  [/\bledgers?\s+balance\b/gi, "ledger balance"],
  // Bare token, safe in this ERP (neither word is ever a real term here).
  [/\bleisure\b/gi, "ledger"],
  [/\bledgier\b/gi, "ledger"],

  // Account groups Whisper garbles.
  [/\bsundry\s+daughters\b/gi, "sundry debtors"],
  [/\bsundry\s+data\b/gi, "sundry debtors"],
  [/\bsundry\s+creditor\b/gi, "sundry creditors"],

  // Voucher / accounting nouns.
  [/\bproffit\s+and\s+loss\b/gi, "profit and loss"],
  [/\bpee\s*and\s*ell\b/gi, "profit and loss"],

  // HR nouns.
  [/\battendence\b/gi, "attendance"],
];

/**
 * Apply the curated corrections to a transcript. Returns the (possibly) fixed
 * text; never throws. Preserves surrounding text and punctuation.
 */
function correctTranscript(text) {
  let out = typeof text === "string" ? text : "";
  if (!out) return out;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

module.exports = { correctTranscript };
