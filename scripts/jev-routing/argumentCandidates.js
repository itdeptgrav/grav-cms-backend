"use strict";
/**
 * scripts/jev-routing/argumentCandidates.js — what Jev may choose from when it
 * names an argument.
 *
 * Open-Jev scores candidates; it never writes text. So "extract the party
 * name" becomes "which of these spans, copied out of the question by GRAV, is
 * the party?" — and an argument Jev did not see in the question cannot be
 * produced at all. That is the whole defence against invented arguments, and
 * it is structural rather than a filter applied afterwards.
 *
 * Everything here is pure and deterministic: the same question always yields
 * the same candidates in the same order. The evaluator and the dataset
 * generator both call it, so training and evaluation offer identical options.
 */

const schema = require("./schema/grav-acc-tools.v2.json");

/** Words that can begin or end a span only as noise. Lower-case. */
const STOP = new Set(
  (
    // English function words and question scaffolding
    "a an the of for to from in on at by with and or but is are was were be been am do does did " +
    "what what's whats wat how much many who whom which when where why please pls plz show tell give get " +
    "me my our us we i you your it its this that these those there here any some all can could would " +
    "should will just now current currently today yesterday also only not no yes hi hey hello ok okay " +
    "kindly quickly quick check need want know let see find list total totals amount figure number " +
    "latest recent last next this month week year quarter fy financial " +
    // accounting scaffolding
    "balance balances bal ledger ledgers account accounts a/c acct owe owes owed owing due outstanding " +
    "payable payables receivable receivables position closing opening dr cr " +
    // Group words: a group is offered as its own `group:` option, so a copied
    // span of the same words would be a second, competing spelling of one
    // answer. Known v1 limitation: a party literally named "... Bank" is
    // offered without that last word.
    "sundry debtor debtors creditor creditors cash hand bank banks duties duty tax taxes gst " +
    "customer customers supplier suppliers vendor vendors party parties " +
    // Hinglish function words
    "ka ki ke ko se me mein hai hain tha thi kitna kitni kitne kya batao bata bataiye dikhao dikha " +
    "abhi aaj kal humko hume humein hamara hamare hamari apna apne unka uska iska yeh woh wo " +
    "paisa paise bacha baki baaki dena lena hua hui"
  ).split(/\s+/),
);

/** Characters stripped from the edges of a token (keeps inner & . - '). */
const EDGE = /^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&.]+$/gu;

function tokens(question) {
  return String(question || "")
    .split(/\s+/)
    .map((raw) => raw.replace(EDGE, "").replace(/['’]s$/i, ""))
    .filter((t) => t.length > 0);
}

const isStop = (t) => STOP.has(t.toLowerCase());
const hasLetter = (t) => /\p{L}/u.test(t);

const MAX_SPAN_TOKENS = 4;
const MAX_SPANS = 10;

/**
 * Candidate spans copied from the question: contiguous runs of 1–4 tokens that
 * neither start nor end with a stop word and contain at least one letter.
 * Longer spans first (a full party name beats its first word), then by
 * position, deduplicated case-insensitively, capped at MAX_SPANS.
 */
function proposeSpans(question) {
  const toks = tokens(question);
  const spans = [];
  const seen = new Set();
  for (let len = MAX_SPAN_TOKENS; len >= 1; len -= 1) {
    for (let i = 0; i + len <= toks.length; i += 1) {
      const run = toks.slice(i, i + len);
      if (isStop(run[0]) || isStop(run[run.length - 1])) continue;
      if (!run.some(hasLetter)) continue;
      // A span that is all stop words inside is noise too ("of the").
      if (run.every(isStop)) continue;
      const text = run.join(" ");
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push(text);
    }
  }
  return spans.slice(0, MAX_SPANS);
}

const A = schema.arguments;

/** The ordered option list for one argument question on one utterance. */
function argumentOptions(argName, question) {
  if (argName === "account") {
    const opts = proposeSpans(question).map((s) => ({ name: `text: ${s}`, description: null }));
    for (const g of A.account.groups) {
      opts.push({ name: `group: ${g}`, description: A.account.group_descriptions[g] });
    }
    opts.push({ name: "none", description: A.account.none_description });
    return opts;
  }
  const spec = A[argName];
  if (!spec || !spec.options) throw new Error(`unknown argument ${argName}`);
  return Object.entries(spec.options).map(([name, description]) => ({ name, description }));
}

/** Render options the way Open-Jev's compile_request does: "name: description". */
function renderOption({ name, description }) {
  return description == null ? name : `${name}: ${description}`;
}

module.exports = { proposeSpans, argumentOptions, renderOption, tokens, STOP, MAX_SPANS };
