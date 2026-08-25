/**
 * GRAV-CMS-BACKEND/services/creditTerms.service.js
 *
 * Validating and normalising a party's credit terms.
 *
 * ── WHY THIS IS A SERVICE AND NOT AN `if` IN A ROUTE ────────────────────────
 * Credit days are the input that a later slice will use to DATE roughly ₹1.36
 * crore of open obligations. A wrong value here does not fail loudly — it
 * quietly moves a due date, and therefore quietly decides whether a bill reads
 * as current or as overdue. That deserves a tested function rather than an
 * inline coercion.
 *
 * ── THE RULE THAT MATTERS MOST: 0 MEANS UNSET ───────────────────────────────
 * `creditPeriodDays` has `default: 0` on all 441 ledgers, and every single one
 * currently holds that default. So 0 is the value of "nobody has said", not the
 * value of "due on receipt". Anything that treats 0 as same-day terms would
 * date every open item to its own invoice date and manufacture an overdue
 * crisis out of an empty field.
 *
 * Due-on-receipt, when someone actually wants it, must be an explicit and
 * separate concept — not the accidental shadow of a schema default.
 *
 * ── SCOPE (C0-B1) ──────────────────────────────────────────────────────────
 * Validation and normalisation only. This module does not derive a due date,
 * does not touch a voucher, and does not know what a bill is.
 */

/** Nobody negotiates a year of credit. Beyond this it is a typo or an attack. */
const MAX_CREDIT_DAYS = 365;

/** A field this slice is allowed to write. Anything else is refused, not ignored. */
const EDITABLE_FIELDS = Object.freeze(["creditPeriodDays"]);

class CreditTermsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CreditTermsError";
    this.code = code;
  }
}

/**
 * Read a credit-days input into either a number of days, or `null` for unset.
 *
 * Deliberately strict. This is a human-entered number that will move money
 * dates, so silent coercion is the wrong instinct everywhere here:
 *
 *   - `""`, `null`, `undefined` → unset (the user cleared the field)
 *   - `0`                       → unset (see the header)
 *   - `"30"`                    → 30 (form inputs arrive as strings)
 *   - `30.5`, `"abc"`, `true`,
 *     `[]`, `{}`, `NaN`, `-1`,
 *     `366`                     → throw
 *
 * `true` is rejected explicitly: `Number(true) === 1` would otherwise write
 * one-day credit terms from a checkbox sent by mistake.
 */
function parseCreditDays(value) {
  if (value === null || value === undefined || value === "") return null;

  // Reject the shapes JS will happily coerce into a plausible number.
  if (typeof value === "boolean") {
    throw new CreditTermsError("INVALID_TYPE", "Credit days must be a number.");
  }
  if (typeof value === "object") {
    throw new CreditTermsError("INVALID_TYPE", "Credit days must be a number.");
  }
  if (typeof value === "string" && value.trim() === "") return null;

  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new CreditTermsError("INVALID_TYPE", "Credit days must be a number.");
  }
  if (!Number.isInteger(n)) {
    throw new CreditTermsError("NOT_INTEGER", "Credit days must be a whole number of days.");
  }
  if (n < 0) {
    throw new CreditTermsError("NEGATIVE", "Credit days cannot be negative.");
  }
  if (n > MAX_CREDIT_DAYS) {
    throw new CreditTermsError(
      "TOO_LARGE",
      `Credit days cannot exceed ${MAX_CREDIT_DAYS}.`,
    );
  }

  // 0 is not an error — it is how the field is cleared.
  return n === 0 ? null : n;
}

/** Is this stored value a real, usable term? */
function isTermSet(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * May this user change credit terms?
 *
 * A pure predicate rather than an inline check in the route, because "who may
 * change the input that dates ₹1.36cr of obligations" is exactly the kind of
 * rule that should be pinned by a test rather than re-typed per endpoint.
 *
 * Read-only accounting roles are refused. The shape is defensive because the
 * auth middleware builds `permissions` through several paths (legacy role map,
 * new role map, dev bypass) and a missing object must never read as allowed.
 */
function canEditTerms(user) {
  if (!user || typeof user !== "object") return false;
  const p = user.permissions;
  if (!p || typeof p !== "object") return false;
  return p.canEdit === true;
}

/**
 * Build the exact `$set` for a credit-terms update.
 *
 * Whitelist-only by construction: the returned object is assembled field by
 * field from a fixed list, so a caller cannot smuggle `openingBalance`,
 * `nature`, `groupId` or anything else through the request body. The route
 * hands the raw body in; only recognised keys come out.
 *
 * Provenance is written by this function from the actor, never read from the
 * body — a client that could set `creditTermsSource` could claim any origin
 * it liked for a number it just invented.
 *
 * @param {object} body   the untrusted request body
 * @param {object} actor  { id, name, email } — the authenticated user
 * @param {Date}   now    injected, so the function stays testable
 */
function buildUpdate(body = {}, actor = {}, now = new Date()) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new CreditTermsError("INVALID_BODY", "Expected an object of credit terms.");
  }

  // Refuse rather than ignore. Silently dropping an unexpected field lets a
  // caller believe a change was saved when it was not.
  const unknown = Object.keys(body).filter((k) => !EDITABLE_FIELDS.includes(k));
  if (unknown.length > 0) {
    throw new CreditTermsError(
      "UNSUPPORTED_FIELD",
      `This endpoint only updates ${EDITABLE_FIELDS.join(", ")}. Refused: ${unknown.join(", ")}.`,
    );
  }

  if (!Object.prototype.hasOwnProperty.call(body, "creditPeriodDays")) {
    throw new CreditTermsError("NOTHING_TO_UPDATE", "No credit terms supplied.");
  }

  const days = parseCreditDays(body.creditPeriodDays);

  return {
    // Stored as 0 when unset, matching the schema default that every other
    // reader already understands. `creditTermsSource: null` is what
    // distinguishes "explicitly cleared" from "never touched".
    creditPeriodDays: days === null ? 0 : days,
    creditTermsSource: days === null ? null : "manual",
    creditTermsUpdatedAt: now,
    creditTermsUpdatedBy: actor?.id || null,
    creditTermsUpdatedByName: actor?.name || actor?.email || null,
  };
}

/**
 * ── C0-C — DUE-DATE DEFAULTING ───────────────────────────────────────────────
 *
 * `dueDate = voucherDate + effectiveCreditDays(partyLedger)`
 *
 * This is the resolver named directly in the C0-C plan. It is deliberately
 * the NARROWEST possible version of the priority ladder sketched in the
 * original cash-flow forecast spec (§4.1 there lists bill-level overrides,
 * group defaults, company defaults, …) — none of that is built here. C0-C
 * reads exactly one thing: the party ledger's own `creditPeriodDays`. Group
 * and company fallback defaults are a separate, later decision — the forecast
 * spec's own correction pass established that a default must be explicit and
 * finance-approved, never silently invented in code, and nothing here invents
 * one.
 */

/**
 * The effective credit days for a party ledger, or `null` if none is set.
 *
 * Reuses `isTermSet` — the exact same "0 means unset" rule this module
 * already enforces for the credit-terms editor (C0-B1/B2). A ledger's stored
 * `creditPeriodDays` of 0 is the schema default every one of the 441 ledgers
 * started with, not a deliberate "due on receipt".
 *
 * @param {object} partyLedger — anything carrying a `creditPeriodDays` field
 *   (a lean Mongoose doc, a plain object, a populated document). Absent or
 *   malformed input returns `null` rather than throwing — a missing party
 *   means no default can be computed, not an error.
 */
function effectiveCreditDays(partyLedger) {
  if (!partyLedger || typeof partyLedger !== "object") return null;
  return isTermSet(partyLedger.creditPeriodDays) ? partyLedger.creditPeriodDays : null;
}

/**
 * `voucherDate + effectiveCreditDays(partyLedger)`, or `null` when nothing
 * can be safely computed.
 *
 * Returns `null` — NEVER a guessed or fallback date — when:
 *   - the party carries no set term (`effectiveCreditDays` is `null`)
 *   - `voucherDate` is missing, or does not parse to a valid date
 *   - `partyLedger` is absent (no party on this line at all)
 *
 * A `null` return is an instruction to every caller: leave `dueDate` exactly
 * as it already was. It must never be read as "clear the due date" — that
 * would turn a resolver that only ever ADDS information into one that can
 * also silently erase a value nobody asked to erase.
 *
 * Arithmetic uses the UTC calendar-date components (`setUTCDate`), not local
 * time. Millisecond arithmetic (`voucherDate.getTime() + days * 86400000`)
 * would land on the wrong local calendar day for a server whose `TZ`
 * observes DST across the interval being added; UTC has no DST, so this is
 * correct regardless of the deployment's timezone configuration, and also
 * correctly rolls over month/year boundaries (31 Jan + 5 days → 5 Feb) the
 * same way `setDate` does.
 */
function resolveDueDate({ voucherDate, partyLedger } = {}) {
  const days = effectiveCreditDays(partyLedger);
  if (days === null) return null;

  // `new Date(null)` is the Unix epoch, not an Invalid Date — this exact trap
  // has bitten this codebase before (services/budgetNegotiation.service.js,
  // services/leadNextAction.js). A missing voucherDate must not silently
  // become "1970-01-01 + N days".
  if (voucherDate === null || voucherDate === undefined || voucherDate === "") {
    return null;
  }

  const base = voucherDate instanceof Date ? voucherDate : new Date(voucherDate);
  if (Number.isNaN(base.getTime())) return null;

  const due = new Date(base.getTime());
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}

module.exports = {
  MAX_CREDIT_DAYS,
  canEditTerms,
  EDITABLE_FIELDS,
  CreditTermsError,
  parseCreditDays,
  isTermSet,
  buildUpdate,
  effectiveCreditDays,
  resolveDueDate,
};
