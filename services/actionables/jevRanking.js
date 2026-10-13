"use strict";

const { TONE_RANK } = require("./actionablesSummary");
const { typesafeJevConfig, systemOne } = require("./typesafeJev.client");

const MAX_CANDIDATES = 12;
const SCORE_LEVELS = Object.freeze([
  "Informational or safe to leave in a digest",
  "Worth monitoring, but no action is needed today",
  "The employee should review this today",
  "The employee should act on this now",
  "Critical business, safety, legal, security, payroll, customer or production risk",
]);

// These queues represent explicit deadlines or stoppages already established
// by ordinary CMS rules. A probabilistic score may raise them, never lower them.
const HARD_MINIMUM = Object.freeze({
  "sales:overdue-tasks": 3,
  "store:po-late": 3,
  "maintenance:mnt-overdue": 4,
});

function candidateId(item) {
  return `${item.slug}:${item.key}`;
}

function buildRequest(items) {
  const state = items.map((item, index) => ({
    candidate: `candidate_${index}`,
    application: item.appName,
    queue: item.label,
    pendingCount: item.count,
    existingRuleTone: item.tone,
  }));
  const questions = {};
  items.forEach((_, index) => {
    questions[`priority_${index}`] = {
      type: "score",
      instructions: `Rate how soon the signed-in employee should address candidate_${index}. Judge business actionability, not merely the number of records. Do not infer facts absent from the state.`,
      criteria: SCORE_LEVELS,
    };
  });
  return { state, questions };
}

function parseRanking(items, response, minConfidence) {
  if (!response || typeof response !== "object" || !response.answers || typeof response.answers !== "object") {
    throw new Error("TypeSafe Jev returned a malformed response");
  }
  return items.map((item, index) => {
    const answer = response.answers[`priority_${index}`];
    const score = Number(answer?.score);
    const confidence = Number(answer?.confidence);
    const usable = answer?.type === "score"
      && Number.isFinite(score)
      && Number.isFinite(confidence)
      && confidence >= minConfidence;
    const original = TONE_RANK[item.tone] || 0;
    const hardMinimum = HARD_MINIMUM[candidateId(item)] ?? 0;
    return {
      item,
      modelScore: usable ? score : null,
      confidence: usable ? confidence : null,
      effectiveScore: usable ? Math.max(score, hardMinimum) : Math.max(original, hardMinimum),
      originalIndex: index,
    };
  });
}

function orderedItems(scored) {
  return [...scored]
    .sort((a, b) => (b.effectiveScore - a.effectiveScore)
      || ((b.confidence || 0) - (a.confidence || 0))
      || (a.originalIndex - b.originalIndex))
    .map(({ item, modelScore, confidence }) => ({
      ...item,
      ...(modelScore == null ? {} : { jev: { priorityScore: modelScore, confidence } }),
    }));
}

function metadata(config, status, extra = {}) {
  return {
    provider: "typesafe-jev",
    mode: config.mode,
    status,
    ...extra,
  };
}

async function rankActionableSummary(summary, {
  config = typesafeJevConfig(),
  systemOneImpl = systemOne,
} = {}) {
  if (!config.enabled) return { ...summary, ranking: metadata(config, "disabled") };
  if (!config.apiKey) return { ...summary, ranking: metadata(config, "unconfigured") };

  const candidates = (summary.top || []).slice(0, MAX_CANDIDATES);
  if (candidates.length < 2) return { ...summary, ranking: metadata(config, "not-needed") };

  try {
    const response = await systemOneImpl(buildRequest(candidates), { config });
    const scored = parseRanking(candidates, response, config.minConfidence);
    const proposed = orderedItems(scored);
    const ranking = metadata(config, "ok", {
      model: String(response.model || config.model),
      evaluated: candidates.length,
      confident: scored.filter((x) => x.modelScore != null).length,
      usage: {
        inputTokens: Number(response.usage?.input_tokens) || 0,
        outputTokens: Number(response.usage?.output_tokens) || 0,
      },
    });
    if (config.mode === "shadow") {
      return {
        ...summary,
        ranking: {
          ...ranking,
          proposedOrder: proposed.map(candidateId),
        },
      };
    }
    return { ...summary, top: proposed, ranking };
  } catch (err) {
    console.warn("[actionables:typesafe-jev]", err?.message || err);
    return { ...summary, ranking: metadata(config, "unavailable") };
  }
}

module.exports = {
  MAX_CANDIDATES,
  SCORE_LEVELS,
  HARD_MINIMUM,
  buildRequest,
  parseRanking,
  orderedItems,
  rankActionableSummary,
};
