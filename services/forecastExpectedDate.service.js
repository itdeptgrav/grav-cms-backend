/**
 * GRAV-CMS-BACKEND/services/forecastExpectedDate.service.js
 *
 * CHUNK 1-C — validating a manual expected-settlement date for an overdue
 * bill. PURE: no Mongo, no clock of its own, no HTTP.
 *
 * ── WHAT THIS FIELD IS, AND WHAT IT IS NOT ──────────────────────────────────
 * It is NOT an accounting due date. `Acc_BillTerms.dueDate` stays the
 * contractual date the money was owed; this is a forecasting assumption about
 * when an ALREADY-LATE bill will really move. The two only diverge once a bill
 * is overdue, which is exactly the case Chunk 1-C exists for.
 *
 * ── WHY THIS IS STRICT ──────────────────────────────────────────────────────
 * The whole point of the feature is that an overdue bill enters the forecast
 * only when a person has said, on the record, when they expect it. A value
 * that arrived by coercion — `true` becoming a date in 1970, a stray object
 * parsing to something plausible — would put money on a date nobody chose,
 * which is precisely the silent guessing the Base forecast refuses to do
 * everywhere else. So booleans, objects and arrays are REFUSED rather than
 * coerced, and unknown body keys are refused rather than dropped.
 *
 * ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
 * It does not predict a date, suggest one, or derive one from ageing or
 * payment history. That is the behavioural collection model, which Chunk 1-C
 * deliberately does not build.
 */

const { canEditTerms } = require("./creditTerms.service");

/** Long enough for a real note, short enough not to become a document store. */
const MAX_NOTES_LENGTH = 500;

/** Exactly the keys a caller may send when SETTING an expected date. */
const SET_FIELDS = Object.freeze([
  "companyId",
  "ledgerId",
  "billName",
  "forecastExpectedDate",
  "asOfDate",
  "notes",
]);

/** Exactly the keys a caller may send when CLEARING one. */
const CLEAR_FIELDS = Object.freeze(["companyId", "ledgerId", "billName"]);

class ForecastExpectedDateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ForecastExpectedDateError";
    this.code = code;
  }
}

/** The shapes JS will happily turn into a plausible number, string or date. */
function rejectCoercibles(value, field) {
  if (typeof value === "boolean") {
    throw new ForecastExpectedDateError("INVALID_TYPE", `${field} must not be a boolean.`);
  }
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    throw new ForecastExpectedDateError(
      "INVALID_TYPE",
      `${field} must not be an object or array.`,
    );
  }
}

function assertPlainObject(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ForecastExpectedDateError("INVALID_BODY", "Expected an object.");
  }
}

/** Refuse rather than ignore — a dropped field reads to the caller as saved. */
function assertNoUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new ForecastExpectedDateError(
      "UNSUPPORTED_FIELD",
      `Unsupported field(s): ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`,
    );
  }
}

/** A required identifier, as an opaque non-empty string. Casting is the route's job. */
function parseRequiredId(value, field) {
  if (value === null || value === undefined || value === "") {
    throw new ForecastExpectedDateError("REQUIRED", `${field} is required.`);
  }
  rejectCoercibles(value, field);
  const s = String(value).trim();
  if (s === "") {
    throw new ForecastExpectedDateError("REQUIRED", `${field} is required.`);
  }
  return s;
}

/**
 * A real date at UTC midnight, or null when genuinely absent.
 *
 * `new Date(null)` is the Unix epoch, not an Invalid Date — a trap this
 * codebase has hit before. Null is handled BEFORE anything is constructed,
 * and booleans are refused because `new Date(true)` is a valid moment in 1970.
 */
function parseDate(value, field) {
  if (value === null || value === undefined || value === "") return null;
  rejectCoercibles(value, field);
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) {
    throw new ForecastExpectedDateError("INVALID_TYPE", `${field} must be a date.`);
  }
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ForecastExpectedDateError("INVALID_DATE", `${field} is not a valid date.`);
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseNotes(value) {
  if (value === null || value === undefined || value === "") return "";
  rejectCoercibles(value, "notes");
  if (typeof value !== "string") {
    throw new ForecastExpectedDateError("INVALID_TYPE", "notes must be text.");
  }
  const t = value.trim();
  if (t.length > MAX_NOTES_LENGTH) {
    throw new ForecastExpectedDateError(
      "TOO_LONG",
      `notes cannot exceed ${MAX_NOTES_LENGTH} characters.`,
    );
  }
  return t;
}

/**
 * Validate a SET request and build the exact `$set` for it.
 *
 * ── WHY A PAST EXPECTED DATE IS REFUSED ─────────────────────────────────────
 * The forecast projects forward from `asOfDate`. An expected date already in
 * the past cannot be placed on any row, so accepting one would record an
 * expectation that silently does nothing — the caller would believe the bill
 * had been brought into the forecast when it had not. Refusing says so.
 *
 * Provenance (`...UpdatedBy`, `...UpdatedByName`, `...UpdatedAt`) is written
 * from the authenticated actor and the supplied clock, NEVER from the body:
 * a client that could set them could claim any author it liked for an
 * assumption it had just invented.
 *
 * @param {object} body  the untrusted request body
 * @param {object} actor { id, name, email } — the authenticated user
 * @param {Date}   now   injected, so the function stays testable
 */
function buildSet(body = {}, actor = {}, now = new Date()) {
  assertPlainObject(body);
  assertNoUnknownFields(body, SET_FIELDS);

  const companyId = parseRequiredId(body.companyId, "companyId");
  const ledgerId = parseRequiredId(body.ledgerId, "ledgerId");
  const billName = parseRequiredId(body.billName, "billName");

  const expected = parseDate(body.forecastExpectedDate, "forecastExpectedDate");
  if (expected === null) {
    throw new ForecastExpectedDateError("REQUIRED", "forecastExpectedDate is required.");
  }

  // `asOfDate` is the caller's own "today" — the same day the forecast it is
  // looking at starts from. Defaulted from the injected clock when absent so
  // the rule still holds for a caller that does not send one.
  const asOf =
    parseDate(body.asOfDate, "asOfDate") ||
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (expected.getTime() < asOf.getTime()) {
    throw new ForecastExpectedDateError(
      "DATE_IN_PAST",
      "forecastExpectedDate must be today or later — an earlier date cannot appear in the forecast.",
    );
  }

  return {
    scope: { companyId, ledgerId, billName },
    $set: {
      forecastExpectedDate: expected,
      forecastExpectedDateSource: "manual",
      forecastExpectedDateNotes: parseNotes(body.notes),
      forecastExpectedDateUpdatedBy: actor?.id || null,
      forecastExpectedDateUpdatedByName: actor?.name || actor?.email || null,
      forecastExpectedDateUpdatedAt: now,
    },
  };
}

/**
 * Validate a CLEAR request and build the exact `$set` for it.
 *
 * Clearing wipes every forecast field including the note and the provenance:
 * a note explaining an expectation that no longer exists is worse than no
 * note, and provenance pointing at a decision that has been withdrawn is
 * misleading. It does NOT touch `dueDate` or anything else on the row.
 */
function buildClear(body = {}) {
  assertPlainObject(body);
  assertNoUnknownFields(body, CLEAR_FIELDS);

  return {
    scope: {
      companyId: parseRequiredId(body.companyId, "companyId"),
      ledgerId: parseRequiredId(body.ledgerId, "ledgerId"),
      billName: parseRequiredId(body.billName, "billName"),
    },
    $set: {
      forecastExpectedDate: null,
      forecastExpectedDateSource: null,
      forecastExpectedDateNotes: "",
      forecastExpectedDateUpdatedBy: null,
      forecastExpectedDateUpdatedByName: null,
      forecastExpectedDateUpdatedAt: null,
    },
  };
}

/**
 * May this user record a forecast expectation?
 *
 * Delegates to `creditTerms.canEditTerms` rather than re-deriving the rule —
 * "does this accounting role have canEdit" is not specific to credit terms,
 * and a second copy would be free to drift. Same treatment
 * `recurringItems.service.js` gives it.
 */
const canEdit = canEditTerms;

module.exports = {
  MAX_NOTES_LENGTH,
  SET_FIELDS,
  CLEAR_FIELDS,
  ForecastExpectedDateError,
  parseDate,
  parseNotes,
  parseRequiredId,
  buildSet,
  buildClear,
  canEdit,
};
