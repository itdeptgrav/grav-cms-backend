"use strict";
/**
 * services/ai/openJev/voucherAnswer.js — the deterministic answer to
 * "how many sales this year?", "recent payments", "biggest invoice".
 *
 * NO SECOND MODEL AND NO SECOND CALCULATION. Jev chose the tool; the counting,
 * totalling and ranking are all done by the EXISTING `buildVouchers`, which is
 * the same service the ordinary assistant calls. This file decides what to ask
 * it for and writes one sentence from what comes back.
 *
 * TWO ARGUMENTS HAVE TO BE RESOLVED WITHOUT A MODEL, and the two are resolved
 * very differently.
 *
 * The voucher TYPE is resolved by `normVoucherType` — the accounting module's
 * own alias table, imported rather than copied. A second list of what "invoice"
 * means would drift from that one and the two would eventually disagree. The
 * one thing this file adds is a check the shared table cannot make on its own:
 * if the question names MORE THAN ONE type, `normVoucherType` silently returns
 * whichever appears first in its table, so "sales and purchase totals" would
 * quietly become a sales-only answer. That is asked about instead.
 *
 * The DATE RANGE is resolved only when it is written out in full. An explicit
 * `2026-04-01` or `1st July 2026` is passed through; "last month", "this quarter" and "recently"
 * are not. They are resolvable in principle, but only by choosing a boundary —
 * whose month, whose quarter, whose timezone, calendar or financial year — that
 * neither this file nor `buildVouchers` defines. A guessed range produces a
 * confident, wrong count, which is worse than a question. So a date expression
 * that is not explicit produces a clarification saying what would be accepted.
 *
 * NO DATE AT ALL IS NOT AMBIGUOUS. "How many sales vouchers" means all of them,
 * which is what `buildVouchers` does with no range, so it is answered.
 *
 * A GENUINE ZERO IS AN ANSWER. A filter that matches nothing reports nothing
 * found, with the filter stated, because "there were none" and "I could not
 * look" are different facts.
 */

const OUTCOME = Object.freeze({
  ANSWERED: "answered",
  CLARIFY: "clarify",
  UNSUPPORTED: "unsupported",
  FAILED: "failed",
});

/** Default and service-supported maximum number of ranked entries to name. */
const DEFAULT_SHOW = 3;
const MAX_SHOW = 15;

/** A written-out date this file will pass through: 2026-04-01. */
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MONTHS = Object.freeze({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
});
const MONTH_WORD = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const DAY_MONTH_YEAR = new RegExp(`\\b([0-3]?\\d)(?:st|nd|rd|th)?\\s+(${MONTH_WORD})\\s*,?\\s*(\\d{4})\\b`, "gi");
const MONTH_DAY_YEAR = new RegExp(`\\b(${MONTH_WORD})\\s+([0-3]?\\d)(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})\\b`, "gi");

/**
 * Date expressions that mean something, but not something this file may decide.
 *
 * Each needs a boundary nobody here owns: which month, whose quarter, calendar
 * or financial year, which timezone the day ends in.
 *
 * "Recent" and "latest" are deliberately NOT here. They ask for a RANKING, not
 * a period — `buildVouchers` already returns the most recent entries with no
 * date filter at all, so there is no boundary to guess and nothing to ask
 * about. Treating them as vague dates made "recent payments", an ordinary
 * question with an exact answer, come back as a clarification.
 */
const VAGUE_DATE =
  /\b(today|yesterday|tomorrow|this (week|month|quarter|year|fy|financial year)|last (week|month|quarter|year|fy|financial year)|past \d+ (days?|weeks?|months?|years?)|last \d+ (days?|weeks?|months?|years?)|so far|to date|ytd|q[1-4]\b|fy\s?\d{2}|current (month|quarter|year)|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}|\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b)/i;

/** "recent"/"latest" as a RANKING word rather than a date. */
const WANTS_RECENT = /\b(recent|recently|latest|last few|newest)\b/i;
// A bare "top" supplies a count/order request, but it does not override an
// explicit recency word. Amount ranking must either say so or use an amount
// superlative. Thus "top five latest" means five newest vouchers, while
// "top five by amount" means five largest vouchers.
const WANTS_AMOUNT_RANK =
  /\b(biggest|largest|highest|maximum|max)\b|\btop\b[^.?!]*\b(by\s+)?(amount|value)\b/i;
const WANTS_TOP = /\btop\b/i;
const COUNT_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
});

function requestedListCount(message) {
  // Ignore ISO dates: a year or day is not a requested row count.
  const text = String(message || "").toLowerCase().replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ");
  const numeric = text.match(/\b(\d{1,3})\b/);
  if (numeric) return Math.max(1, Math.min(MAX_SHOW, Number(numeric[1])));
  for (const [word, count] of Object.entries(COUNT_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) return count;
  }
  return DEFAULT_SHOW;
}

function resolveListRequest(message) {
  const recent = WANTS_RECENT.test(message);
  const amount = WANTS_AMOUNT_RANK.test(message);
  if (recent && amount) return { kind: "ambiguous", limit: requestedListCount(message) };
  if (recent) return { kind: "recent", limit: requestedListCount(message) };
  if (amount || WANTS_TOP.test(message)) return { kind: "largest", limit: requestedListCount(message) };
  return { kind: "none", limit: 0 };
}

/**
 * Which voucher types the question names, using the accounting module's own
 * alias table so there is exactly one definition of "invoice" in the codebase.
 */
function namedTypes(message, aliases) {
  const text = String(message || "").toLowerCase();
  const found = [];
  for (const [canon, words] of Object.entries(aliases)) {
    if (words.some((w) => text.includes(w))) found.push(canon);
  }
  return found;
}

/**
 * The date range, or a reason there isn't one.
 *
 * @returns {{kind:"none"}|{kind:"range",from:string,to:string}|{kind:"ambiguous"}}
 */
function resolveRange(message) {
  const text = String(message || "");
  const parsed = [];
  let sawExplicit = false;
  for (const match of text.matchAll(ISO_DATE)) {
    sawExplicit = true;
    parsed.push({ index: match.index, iso: isRealDate(match[0]) ? match[0] : null });
  }
  for (const match of text.matchAll(DAY_MONTH_YEAR)) {
    sawExplicit = true;
    parsed.push({ index: match.index, iso: toIso(Number(match[3]), MONTHS[match[2].toLowerCase()], Number(match[1])) });
  }
  for (const match of text.matchAll(MONTH_DAY_YEAR)) {
    sawExplicit = true;
    parsed.push({ index: match.index, iso: toIso(Number(match[3]), MONTHS[match[1].toLowerCase()], Number(match[2])) });
  }
  if (sawExplicit && parsed.some((value) => !value.iso)) return { kind: "ambiguous" };
  const explicitDates = parsed
    .sort((a, b) => a.index - b.index)
    .filter((value, index, all) => index === 0 || value.index !== all[index - 1].index)
    .map((value) => value.iso);

  if (explicitDates.length >= 2) {
    const sorted = [...explicitDates].sort();
    return { kind: "range", from: sorted[0], to: sorted[sorted.length - 1] };
  }
  if (explicitDates.length === 1) {
    // One written-out date is that single day, which is unambiguous.
    return { kind: "range", from: explicitDates[0], to: explicitDates[0] };
  }
  // A malformed written-out date ("2026-13-45") is a date the user meant and we
  // could not read — a question, not a silent all-time answer.
  if (/\b\d{4}-\d{1,2}-\d{1,2}\b/.test(text)) return { kind: "ambiguous" };
  if (VAGUE_DATE.test(text)) return { kind: "ambiguous" };
  return { kind: "none" };
}

/** Is this turn only a fully specified date modifying the prior request? */
function isDateOnlyConstraint(message) {
  const text = String(message || "");
  if (resolveRange(text).kind !== "range") return false;
  const remainder = text
    .replace(ISO_DATE, " ")
    .replace(DAY_MONTH_YEAR, " ")
    .replace(MONTH_DAY_YEAR, " ")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .replace(/\b(what|about|and|on|date|for|as|of|instead|then|now|please)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return remainder === "";
}

function toIso(year, month, day) {
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isRealDate(iso) ? iso : null;
}

/** A calendar date that exists — "2026-02-30" does not. */
function isRealDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * @param {object} input
 * @param {string} input.message
 * @param {(args:object)=>Promise<object>} input.buildVouchers  the EXISTING service
 * @param {object} input.aliases    VOUCHER_ALIASES, from the same module
 * @param {Date} input.now
 */
async function answerVouchers({ message, resolvedArguments, buildVouchers, resolveLedger, aliases, now }) {
  const interpreted = resolvedArguments && typeof resolvedArguments === "object" ? resolvedArguments : null;
  const types = interpreted
    ? interpreted.voucherType === "all" ? [] : [interpreted.voucherType]
    : namedTypes(message, aliases);

  // `normVoucherType` would silently pick the first of these.
  if (types.length > 1) {
    return {
      outcome: OUTCOME.CLARIFY,
      reason: "voucher_type_ambiguous",
      reply:
        `That names more than one kind of voucher (${types.join(", ").replace(/_/g, " ")}). ` +
        "Which one would you like — or say 'all vouchers' for the whole summary?",
    };
  }

  // Explicit calendar words in the current message are authoritative. The
  // language model may help with intent, but it cannot drop or rewrite a date
  // the deterministic parser can read.
  const explicitRange = resolveRange(message);
  const range = explicitRange.kind !== "none"
    ? explicitRange
    : interpreted && interpreted.from && interpreted.to
      ? { kind: "range", from: interpreted.from, to: interpreted.to }
      : { kind: "none" };
  if (range.kind === "ambiguous") {
    return {
      outcome: OUTCOME.CLARIFY,
      reason: "date_range_ambiguous",
      reply:
        "I can only use dates written out in full, so that I do not guess which " +
        "period you mean. Give me a range like 2026-04-01 to 2026-06-30, or ask " +
        "without a date for the whole period.",
    };
  }

  const listRequest = interpreted
    ? { kind: interpreted.ranking, limit: interpreted.ranking === "none" ? 0 : interpreted.limit }
    : resolveListRequest(message);
  if (listRequest.kind === "ambiguous") {
    return {
      outcome: OUTCOME.CLARIFY,
      reason: "voucher_ranking_ambiguous",
      reply: "Should I list the newest vouchers, or the largest vouchers by amount?",
    };
  }
  const wantsDetails = interpreted && interpreted.view === "details";

  let partyName = null;
  if (interpreted && interpreted.partyName) {
    let lookup;
    try {
      lookup = await resolveLedger({ query: interpreted.partyName, hint: interpreted.partyName });
    } catch {
      return { outcome: OUTCOME.FAILED, reason: "party_lookup_failed" };
    }
    if (!lookup || lookup.found !== true || !Array.isArray(lookup.matches) || lookup.matches.length === 0) {
      return {
        outcome: OUTCOME.CLARIFY,
        reason: "party_not_found",
        reply: `I could not find an account matching “${interpreted.partyName}” in this company's ledgers.`,
      };
    }
    if (lookup.matches.length !== 1) {
      const options = lookup.matches.slice(0, 5).map((row) => row.name).join(", ");
      return {
        outcome: OUTCOME.CLARIFY,
        reason: "party_ambiguous",
        reply: `That matches more than one account: ${options}. Which one do you mean?`,
      };
    }
    partyName = lookup.matches[0].name;
  }

  let result;
  try {
    result = await buildVouchers({
      // The message itself: `normVoucherType` inside the service does the
      // mapping, exactly as it does for the ordinary assistant.
      voucherType: types.length === 1 ? (interpreted ? types[0] : message) : undefined,
      partyName,
      from: range.kind === "range" ? range.from : undefined,
      to: range.kind === "range" ? range.to : undefined,
    });
  } catch {
    return { outcome: OUTCOME.FAILED, reason: "voucher_read_failed" };
  }

  if (!result || typeof result !== "object" || !Array.isArray(result.summary)) {
    return { outcome: OUTCOME.FAILED, reason: "voucher_read_invalid" };
  }

  const period =
    range.kind === "range"
      ? range.from === range.to
        ? ` on ${range.from}`
        : ` between ${range.from} and ${range.to}`
      : "";
  const filter = result.filterType && result.filterType !== "all" ? `${result.filterType} ` : "";
  const party = result.filterParty ? ` for ${result.filterParty}` : "";

  // Nothing matched. A real answer, and stated as one.
  if (result.summary.length === 0) {
    return {
      outcome: OUTCOME.ANSWERED,
      reply: `No ${filter}vouchers were recorded${party}${period}.`,
      evidence: evidenceFor(result, range, now, { count: 0, total: 0 }),
    };
  }

  const count = result.summary.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  const total = result.summary.reduce((sum, row) => sum + (Number(row.total) || 0), 0);

  const parts = [
    `${count} ${filter}voucher${count === 1 ? "" : "s"}${party}${period}, totalling ${money(total)}`,
  ];

  if (result.summary.length > 1) {
    parts.push(
      `By type: ${result.summary
        .map((row) => `${row.type} ${row.count} (${money(row.total)})`)
        .join(", ")}`,
    );
  }

  // Only the list the question actually asked for, so a plain count stays a
  // plain count rather than turning into a wall of rows.
  if (wantsDetails && Array.isArray(result.recent) && result.recent.length) {
    parts.push(`Details: ${result.recent.slice(0, interpreted.limit).map(describe).join("; ")}`);
  } else if (listRequest.kind === "largest" && Array.isArray(result.largest) && result.largest.length) {
    parts.push(`Largest: ${result.largest.slice(0, listRequest.limit).map(describe).join("; ")}`);
  } else if (listRequest.kind === "recent" && Array.isArray(result.recent) && result.recent.length) {
    parts.push(`Most recent: ${result.recent.slice(0, listRequest.limit).map(describe).join("; ")}`);
  }

  return {
    outcome: OUTCOME.ANSWERED,
    reply: `${parts.join(". ")}.`,
    evidence: evidenceFor(result, range, now, { count, total }),
  };
}

function describe(row) {
  return `${row.type} ${row.number || "—"} on ${row.date || "an unrecorded date"} ${money(row.amount)}`;
}

/** Exact, Indian-grouped. The service already rounds to whole rupees. */
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "an unreadable amount";
  return `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}`;
}

function evidenceFor(result, range, now, totals) {
  return {
    schema: "grav.acc.vouchers.evidence/1",
    filterType: result.filterType || "all",
    filterParty: result.filterParty || null,
    from: range.kind === "range" ? range.from : null,
    to: range.kind === "range" ? range.to : null,
    voucherCount: totals.count,
    total: totals.total,
    byType: result.summary.map((row) => ({
      type: row.type,
      count: row.count,
      total: row.total,
    })),
    effectiveAt: now.toISOString(),
    basis: "posted vouchers",
  };
}

module.exports = { answerVouchers, resolveRange, isDateOnlyConstraint, resolveListRequest, namedTypes, OUTCOME, VAGUE_DATE };
