"use strict";

const { flags } = require("./recommendation.config");

/**
 * The embedding seam. The recommendation pipeline is provider-agnostic by
 * design (spec §8): everything semantic goes through `embed(text)`, so the
 * underlying model can be swapped — a local Ollama embedding model, Gemini's
 * embeddings, or a hosted service — without touching the ranker.
 *
 * IMPORTANT (spec §8): this must never be a giant chat LLM. Embeddings only.
 * A 70B model has no business in a per-recommendation code path.
 *
 * Stage 1 ships a NO-OP provider that returns null. The ranker treats a null
 * embedding as "semantic signal unavailable" and falls back to lexical
 * similarity, so the whole engine works with embeddings disabled. Flip
 * `RECOMMENDATION_EMBEDDINGS_ENABLED=true` and register a real provider (Stage
 * 3) to light this up.
 */

let provider = {
  name: "noop",
  dimensions: 0,
  async embed(/* text */) {
    return null;
  },
};

/** Replace the active embedding provider. A provider implements
 *  `{ name, dimensions, embed(text): Promise<number[]|null> }`. */
function setEmbeddingProvider(next) {
  if (!next || typeof next.embed !== "function") {
    throw new Error("embedding provider must implement embed(text)");
  }
  provider = next;
}

/** Whether semantic ranking is available (flag on AND a real provider set). */
function embeddingsAvailable() {
  return flags.embeddings && provider.name !== "noop";
}

/** Embed a single text. Returns null when embeddings are off/unavailable. */
async function embed(text) {
  if (!flags.embeddings || !text) return null;
  try {
    return await provider.embed(text);
  } catch {
    // Never let an embedding failure break a recommendation request.
    return null;
  }
}

module.exports = {
  embed,
  setEmbeddingProvider,
  embeddingsAvailable,
  get providerName() {
    return provider.name;
  },
};
