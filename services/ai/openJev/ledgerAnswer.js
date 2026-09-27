"use strict";
/**
 * services/ai/openJev/ledgerAnswer.js — the deterministic answer to
 * "what is the balance of X?".
 *
 * NO SECOND MODEL RUNS HERE. Jev chose the tool; everything below is GRAV
 * reading its own records and writing one sentence from them. There is nothing
 * for a language model to add to "Sundry Debtors – ABC: ₹1,23,456.00 Dr", and
 * a great deal for it to get wrong.
 *
 * WHAT AN ANSWER MUST CARRY, and why each part is not optional:
 *
 *   the exact matched ledger name   the user's wording may be a misspelling or
 *                                   a mishearing; the answer names the ledger
 *                                   GRAV actually read, so a wrong match is
 *                                   visible rather than hidden behind the
 *                                   user's own words
 *   the amount                      exact, not rounded to lakhs — an accountant
 *                                   reconciling needs the figure
 *   the currency                    read from the company profile, never
 *                                   assumed; a report without a unit is not a
 *                                   figure
 *   Dr or Cr                        the sign IS the meaning in a ledger
 *   the effective time              a running balance is only true as at a
 *                                   moment, and the moment is when GRAV
 *                                   computed it from posted vouchers
 *
 * WHEN NOT TO ANSWER. The existing resolver falls back to fuzzy name matching
 * and returns its best guesses in similarity order. Taking the first of those
 * is how an assistant confidently reports the wrong company's balance. So a
 * fuzzy result is never answered from — it is offered back as a question. The
 * same goes for a term that matched several ledgers when the plan asked for one
 * account. A validated group/ranking plan may intentionally return several.
 *
 * A GENUINE ZERO IS AN ANSWER. A ledger that exists and nets to nothing is
 * reported as zero, with its name and Dr/Cr, because "the account is empty" and
 * "I could not find the account" are different facts and an accountant needs to
 * tell them apart. Nothing in this file treats 0 as absent — every check is
 * against `found`, never against the amount's truthiness.
 */

const OUTCOME = Object.freeze({
  ANSWERED: "answered",
  CLARIFY: "clarify",
  UNSUPPORTED: "unsupported",
  FAILED: "failed",
});

/** At most this many names are offered back when asking which one was meant. */
const MAX_CHOICES = 5;

/** "1,23,456.00" — Indian grouping, two decimals, exact. */
function formatAmount(value, currency) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const formatted = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));
  return currency === "INR" ? `₹${formatted}` : `${formatted} ${currency}`;
}

/** "25 Sep 2026, 09:20 IST" — the company's own clock, stated. */
function formatEffective(now, timeZone) {
  try {
    const text = new Intl.DateTimeFormat("en-IN", {
      timeZone,
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(now);
    return `${text} ${zoneAbbreviation(timeZone)}`.trim();
  } catch {
    return now.toISOString();
  }
}

function zoneAbbreviation(timeZone) {
  return timeZone === "Asia/Kolkata" ? "IST" : timeZone || "";
}

/**
 * @param {object} input
 * @param {string} input.message            the user's original question, passed
 *   to the existing resolver unchanged — it does its own mishearing repair and
 *   proper-noun extraction, and a paraphrase of ours would only lose signal
 * @param {(args:{query:string,hint:string})=>Promise<object>} input.lookupLedger
 *   the EXISTING permission-gated resolver (buildLedgerLookup)
 * @param {()=>Promise<object>} input.companyProfile   buildCompanyInfo
 * @param {Date} input.now
 * @param {string} [input.timeZone]
 * @returns {Promise<{outcome:string, reply?:string, reason?:string, evidence?:object}>}
 */
async function answerLedgerBalance({
  message,
  resolvedArguments,
  lookupLedger,
  companyProfile,
  now,
  timeZone = "Asia/Kolkata",
}) {
  let result;
  try {
    // Normally the ORIGINAL question goes through unchanged. When that safe
    // deterministic attempt could not resolve the wording, the hybrid pilot
    // may retry with a Qwen-extracted ledger name. That name is still only a
    // search term: this resolver must find one real ledger before any balance
    // can be reported, and fuzzy/multiple matches remain clarifications.
    const query = resolvedArguments && resolvedArguments.ledgerName
      ? resolvedArguments.ledgerName
      : message;
    result = await lookupLedger({ query, hint: query });
  } catch {
    return { outcome: OUTCOME.FAILED, reason: "ledger_read_failed" };
  }

  if (!result || typeof result !== "object") {
    return { outcome: OUTCOME.FAILED, reason: "ledger_read_invalid" };
  }

  if (result.found !== true) {
    return {
      outcome: OUTCOME.CLARIFY,
      reason: "ledger_not_found",
      reply:
        "I could not find an account with that name in this company's ledgers. " +
        "Could you give me the exact ledger name as it appears in the books?",
    };
  }

  const matches = Array.isArray(result.matches) ? result.matches : [];
  if (matches.length === 0) {
    return { outcome: OUTCOME.FAILED, reason: "ledger_read_empty" };
  }

  // A fuzzy hit is a GUESS, however confident the similarity score. Offering
  // the guesses back is the whole difference between a useful assistant and one
  // that quietly reports the wrong party's balance.
  if (result.fuzzy === true) {
    return {
      outcome: OUTCOME.CLARIFY,
      reason: "ledger_fuzzy",
      reply: askWhich(matches, "I could not match that name exactly."),
    };
  }

  const isGroupPlan = resolvedArguments && ["group", "all"].includes(resolvedArguments.ledgerMode);
  // Several accounts matched accidentally — a vague term or several similarly
  // named parties. Only an explicit, validated group plan may turn that into a
  // list; a single-ledger request never silently picks one.
  if (matches.length > 1 && !isGroupPlan) {
    return {
      outcome: OUTCOME.CLARIFY,
      reason: "ledger_ambiguous",
      reply: askWhich(
        matches,
        `That matched ${result.totalMatched || matches.length} accounts rather than one.`,
      ),
    };
  }

  let currency = null;
  try {
    const profile = await companyProfile();
    currency = profile && profile.available !== false ? profile.baseCurrency || null : null;
  } catch {
    currency = null;
  }
  if (!currency) {
    // A figure with no unit is not a figure. Better to say why than to guess.
    return { outcome: OUTCOME.FAILED, reason: "currency_unknown" };
  }

  if (isGroupPlan) {
    return answerLedgerGroup({ matches, result, resolvedArguments, currency, now, timeZone });
  }

  const ledger = matches[0];

  if (ledger.reconciliation && ledger.reconciliation.status === "source_incomplete") {
    return {
      outcome: OUTCOME.CLARIFY,
      reason: "ledger_balance_unreconciled",
      reply:
        `${ledger.name}${ledger.group ? ` (${ledger.group})` : ""} cannot be reported reliably yet: ` +
        "the posted vouchers contain settlement-side movement but no opening or normal-side posting. " +
        "Please reconcile the missing opening/accrual entries before using this figure.",
    };
  }

  // `=== undefined` and not `|| 0`: a real zero must survive, and a missing
  // amount must not be silently reported as an empty account.
  if (ledger.balance === undefined || ledger.balance === null) {
    return { outcome: OUTCOME.FAILED, reason: "balance_missing" };
  }
  const amount = formatAmount(ledger.balance, currency);
  if (amount === null) return { outcome: OUTCOME.FAILED, reason: "balance_not_a_number" };

  const drCr = ledger.drCr === "Cr" ? "Cr" : "Dr";
  const effectiveAt = formatEffective(now, timeZone);

  const reply =
    `${ledger.name}${ledger.group ? ` (${ledger.group})` : ""}: ` +
    `${amount} ${drCr}, as at ${effectiveAt}.`;

  return {
    outcome: OUTCOME.ANSWERED,
    reply,
    evidence: {
      schema: "grav.acc.ledger-balance.evidence/1",
      ledgerName: ledger.name,
      group: ledger.group || null,
      amount: ledger.balance,
      currency,
      drCr,
      effectiveAt: now.toISOString(),
      basis: "posted vouchers",
    },
  };
}

function answerLedgerGroup({ matches, result, resolvedArguments, currency, now, timeZone }) {
  const mismatches = matches.filter((row) =>
    row && row.reconciliation && row.reconciliation.status === "source_incomplete");
  if (mismatches.length) {
    return {
      outcome: OUTCOME.CLARIFY,
      reason: "ledger_ranking_unreconciled",
      reply:
        `I cannot give a reliable closing-balance ranking because ${mismatches.length} matching ` +
        `${mismatches.length === 1 ? "ledger has" : "ledgers have"} incomplete opening or normal-side postings. ` +
        "Reconcile those books first; I will not rank incomplete figures.",
    };
  }
  const rows = matches.filter((row) => row && row.balance !== undefined && row.balance !== null);
  if (!rows.length) return { outcome: OUTCOME.FAILED, reason: "balance_missing" };
  const ranking = resolvedArguments.ranking || "largest";
  const sorted = [...rows].sort((a, b) =>
    ranking === "smallest" ? Number(a.balance) - Number(b.balance) : Number(b.balance) - Number(a.balance));
  const limit = Math.max(1, Math.min(15, Number(resolvedArguments.limit) || 5));
  const selected = sorted.slice(0, limit);
  const described = selected.map((row, index) => {
    const amount = formatAmount(row.balance, currency);
    return `${index + 1}. ${row.name} — ${amount} ${row.drCr === "Cr" ? "Cr" : "Dr"}`;
  });
  if (described.some((line) => line.includes("null"))) {
    return { outcome: OUTCOME.FAILED, reason: "balance_not_a_number" };
  }
  const groupName = resolvedArguments.ledgerMode === "all"
    ? `${resolvedArguments.balanceSide === "cr" ? "credit" : "debit"}-balance`
    : resolvedArguments.groupName || resolvedArguments.ledgerName;
  const effectiveAt = formatEffective(now, timeZone);
  return {
    outcome: OUTCOME.ANSWERED,
    reply: `${ranking === "smallest" ? "Smallest" : "Largest"} ${selected.length} ${groupName} ledgers by closing balance: ${described.join("; ")}. As at ${effectiveAt}.`,
    evidence: {
      schema: "grav.acc.ledger-ranking.evidence/1",
      groupName,
      ranking,
      requestedLimit: limit,
      totalMatched: result.totalMatched || matches.length,
      rows: selected.map((row) => ({ name: row.name, group: row.group || null, amount: row.balance, drCr: row.drCr })),
      currency,
      effectiveAt: now.toISOString(),
      basis: "posted vouchers",
    },
  };
}

/** Ask which one was meant, naming them. Never picks. */
function askWhich(matches, preamble) {
  const names = matches
    .slice(0, MAX_CHOICES)
    .map((m) => (m.group ? `${m.name} (${m.group})` : m.name));
  const more = matches.length > MAX_CHOICES ? ", and others" : "";
  return `${preamble} Did you mean ${names.join(", ")}${more}? Tell me which one and I will read its balance.`;
}

module.exports = { answerLedgerBalance, answerLedgerGroup, formatAmount, formatEffective, OUTCOME, MAX_CHOICES };
