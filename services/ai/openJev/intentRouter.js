"use strict";
/**
 * services/ai/openJev/intentRouter.js — turn an Open-Jev choice into a GRAV
 * routing decision, or an abstention.
 *
 * The intent set is fixed by docs/decisions/open-jev-cms-pilot.md:
 *   attendance_today, leave_today, other, unclear
 * An intent is OFFERED only if this user is already authorised for what GRAV
 * would do with it; `other` and `unclear` are always offered. The router never
 * widens a user's tools: a user who may not read attendance is never offered
 * `attendance_today`, so no probability can route them to it.
 *
 * ACCEPT only when all hold: status ok, choice offered, choice is not
 * other/unclear, top probability ≥ minProbability, margin ≥ minMargin.
 * Anything else → `accepted:false`, and the caller uses the existing path.
 */

const { chooseIntent, STATUS } = require("./openJevClient");

const INTENT_DESCRIPTIONS = Object.freeze({
  attendance_today:
    "Asks whether ONE specific named employee is present, has come in, or has checked in TODAY.",
  leave_today: "Asks whether a specific named employee is on leave or off TODAY.",
  other:
    "Anything else: a different date, a group or whole-day question, a question about the user themselves, other HR data, other business data, or conversation.",
  unclear: "The question is too vague or garbled to tell what is being asked.",
});

const INSTRUCTIONS =
  "Classify the employee's question to a company HR assistant. Choose the single intent it expresses.";

const ROUTABLE = new Set(["attendance_today"]);

/**
 * @param {object} input
 * @param {string} input.message
 * @param {{attendanceToday:boolean, leaveToday:boolean}} input.offer  what the
 *        user is already authorised for (decided by GRAV, before the model runs)
 * @param {object} cfg        openJevConfig()
 * @param {Function} [fetchImpl]
 */
async function routeIntent({ message, offer }, cfg, fetchImpl) {
  const intents = {};
  if (offer && offer.attendanceToday) intents.attendance_today = INTENT_DESCRIPTIONS.attendance_today;
  if (offer && offer.leaveToday) intents.leave_today = INTENT_DESCRIPTIONS.leave_today;
  intents.other = INTENT_DESCRIPTIONS.other;
  intents.unclear = INTENT_DESCRIPTIONS.unclear;

  const offered = Object.keys(intents);
  // Nothing GRAV could route to → do not call the model at all.
  if (!offered.some((i) => ROUTABLE.has(i))) {
    return { accepted: false, status: "not_offered", offered, latencyMs: 0 };
  }

  const r = await chooseIntent({ question: message, intents, instructions: INSTRUCTIONS }, cfg, fetchImpl);
  const base = { offered, status: r.status, reason: r.reason, latencyMs: r.latencyMs, provenance: r.provenance };
  if (r.status !== STATUS.OK) return { ...base, accepted: false };

  const sorted = Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]);
  const [top, topP] = sorted[0];
  const margin = topP - (sorted[1] ? sorted[1][1] : 0);
  const decided = { ...base, intent: top, probability: topP, margin };

  if (!ROUTABLE.has(top)) return { ...decided, accepted: false, status: top === "unclear" ? "abstain_unclear" : "not_routable" };
  if (topP < cfg.minProbability || margin < cfg.minMargin) return { ...decided, accepted: false, status: "abstain_low_confidence" };
  return { ...decided, accepted: true };
}

module.exports = { routeIntent, INTENT_DESCRIPTIONS, INSTRUCTIONS };
