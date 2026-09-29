"use strict";
/**
 * services/ai/openJev/accountsCandidates.js — what Jev is allowed to choose
 * between, for THIS signed-in user, on THIS request.
 *
 * The candidate list is derived from the tool registry, not written out a
 * second time here. `authorizedTools(user)` already answers "which accounting
 * tools may this person use?", and the pilot offers exactly those, intersected
 * with the tools it has a deterministic executor for. Two consequences worth
 * being explicit about:
 *
 *   • A user who cannot read accounting data is offered NO accounting
 *     candidate, so no probability Jev returns can route them into one. The
 *     model cannot widen a permission it was never shown.
 *   • Adding a tool to the registry does not silently expose it to Jev. It
 *     appears only once the pilot has an executor for it, which is a code
 *     change in `accountsPilot.js` with tests, not a configuration change.
 *
 * WHAT `EXECUTABLE` IS AND IS NOT. It is not a second intent list — it holds no
 * descriptions, no permissions and no matching rules, and it cannot make a tool
 * exist or a user authorised. It is the set of tool names this pilot knows how
 * to answer deterministically. Offering a tool without one would route a user
 * into a dead end, which is worse than telling them it is unsupported.
 *
 * `clarify` and `unsupported` are not tools and never touch the registry. They
 * are how Jev says "I need more from the user" and "this is not an accounting
 * question I can answer", and they are always offered so that abstaining is
 * always available to it.
 */

const { authorizedTools } = require("../toolRegistry");

/** Router-control choices. Not tools; they read nothing and execute nothing. */
const CLARIFY = "clarify";
const UNSUPPORTED = "unsupported";

const CONTROL_DESCRIPTIONS = Object.freeze({
  [CLARIFY]:
    "The question is about company accounts but does not say clearly enough WHICH account, ledger, party or figure is being asked about.",
  [UNSUPPORTED]:
    "Not a question about this company's accounting records: something else entirely, general conversation, or a request to change or create data.",
});

/**
 * The accounting tools this pilot can answer deterministically.
 *
 * Every registered accounting tool below has an executor. A tool added to
 * the registry still does not appear here on its own — offering one without a
 * deterministic answer would route a user into a dead end, so this list grows
 * only alongside an executor in `accountsPilot.js` and its tests.
 */
const EXECUTABLE = Object.freeze([
  "acc_ledger_balance",
  "acc_financials",
  "acc_vouchers",
  "acc_company",
  "acc_party_reports",
  "acc_report_query",
]);

/**
 * How much of a tool's registered description Jev is shown.
 *
 * Descriptions are developer-written constants, not data — but they are edited
 * over time by people adding examples, and an example is how a real party name
 * or figure would find its way into a model prompt. Capping the length and
 * refusing anything with digit runs that look like an amount or an id is a
 * cheap guard that fails closed: a description that trips it is shortened to
 * the tool's own first sentence.
 */
const MAX_DESCRIPTION = 400;
const LOOKS_LIKE_DATA = /\b\d[\d,]{4,}(?:\.\d+)?\b|\b[0-9a-f]{24}\b/i;

function safeDescription(tool) {
  const raw = String(tool.description || "").replace(/\s+/g, " ").trim();
  const firstSentence = raw.split(/(?<=\.)\s/)[0] || raw;
  const candidate = raw.length <= MAX_DESCRIPTION ? raw : firstSentence;
  return LOOKS_LIKE_DATA.test(candidate) ? firstSentence.replace(LOOKS_LIKE_DATA, "…") : candidate;
}

/**
 * Build the candidate map for one user.
 *
 * @param {object} user
 * @param {{listTools?: Function}} [deps]  test seam only
 * @returns {{candidates: Record<string,string>, toolNames: string[], offered: string[]}}
 */
function accountsCandidates(user, deps = {}) {
  const list = deps.listTools || authorizedTools;

  let authorised = [];
  try {
    authorised = list(user) || [];
  } catch {
    // A throwing permission check is a denied permission, not an open door.
    authorised = [];
  }

  const toolNames = authorised
    .map((t) => t && t.name)
    .filter((name) => EXECUTABLE.includes(name))
    // Registry order is incidental; a stable order keeps routing comparable
    // between runs and keeps the evaluation reproducible.
    .sort((a, b) => EXECUTABLE.indexOf(a) - EXECUTABLE.indexOf(b));

  // Built in `toolNames` order, not registry order, so the list Jev sees is
  // the same on every run whatever order the tool modules happened to load in.
  // A candidate list that reshuffles between runs makes two evaluations of the
  // same model incomparable.
  const byName = new Map(authorised.map((t) => [t.name, t]));
  const candidates = {};
  for (const name of toolNames) {
    candidates[name] = safeDescription(byName.get(name));
  }
  candidates[CLARIFY] = CONTROL_DESCRIPTIONS[CLARIFY];
  candidates[UNSUPPORTED] = CONTROL_DESCRIPTIONS[UNSUPPORTED];

  return { candidates, toolNames, offered: Object.keys(candidates) };
}

/** Would this user be offered anything worth calling a model about? */
function hasExecutableCandidate(user, deps) {
  return accountsCandidates(user, deps).toolNames.length > 0;
}

module.exports = {
  accountsCandidates,
  hasExecutableCandidate,
  safeDescription,
  EXECUTABLE,
  CLARIFY,
  UNSUPPORTED,
  CONTROL_DESCRIPTIONS,
};
