/**
 * GRAV-CMS-BACKEND/services/recurringItems.service.js
 *
 * Validating and normalising a recurring cash item. PURE — no Mongo, no
 * clock of its own, no knowledge of HTTP. The route
 * (routes/Accountant_Routes/Acc_recurringItems.js) owns the database and the
 * request; this file owns every decision about whether a value is allowed to
 * become one.
 *
 * Same pure/Mongo split as creditTerms.service.js (pure) /
 * voucherDueDateDefault.service.js (Mongo) and
 * billTermsBackfillPlanner.service.js (pure) /
 * billTermsBackfillOrchestrator.service.js (Mongo), for the same reason: the
 * part with real decisions in it should be testable without a database.
 *
 * ── WHY THIS IS STRICT ──────────────────────────────────────────────────────
 * Every row here is a number that a later forecast engine will multiply
 * across twelve months and present as a cash position. A silently coerced
 * `true` becoming ₹1, or an amount arriving as `"8,00,000"` and being read as
 * NaN, does not fail loudly — it produces a forecast that is confidently
 * wrong. So the same discipline `parseCreditDays` established applies to
 * every field: booleans, objects and arrays are REFUSED rather than coerced,
 * and unknown body keys are REFUSED rather than dropped, because silently
 * ignoring a field lets a caller believe a change was saved when it was not.
 *
 * ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────
 * It does not project occurrences, generate forecast rows, advance
 * `nextDueDate`, or touch a voucher. C0-E is the register only; Chunk 1's
 * forecast engine is deliberately not started.
 */

const { canEditTerms } = require("./creditTerms.service");

const TYPE = Object.freeze(["payroll", "rent", "emi", "utility", "statutory", "other"]);
const DIRECTION = Object.freeze(["inflow", "outflow"]);
const FREQUENCY = Object.freeze(["monthly", "weekly", "quarterly", "yearly"]);
const STATUS = Object.freeze(["active", "paused", "ended"]);
const SOURCE = Object.freeze(["manual", "seeded_from_history"]);

/**
 * Fields a client may supply on create.
 *
 * `source` is deliberately absent — it is provenance, set by the server, and
 * a client claiming `seeded_from_history` for something a person typed would
 * be asserting an origin the data does not have. Same rule, same reason, as
 * `creditTermsSource` in creditTerms.service.js. `createdBy`/`updatedBy` are
 * absent for the identical reason.
 */
const CREATE_FIELDS = Object.freeze([
  "companyId",
  "name",
  "type",
  "direction",
  "ledgerId",
  "ledgerName",
  "amount",
  "frequency",
  "dayOfMonth",
  "dayOfWeek",
  "nextDueDate",
  "startDate",
  "endDate",
  "status",
  "notes",
]);

/**
 * Fields a client may change afterwards.
 *
 * `companyId` is absent on purpose: moving an existing row to another company
 * is not an edit, it is a cross-tenant write wearing an edit's clothes. The
 * route scopes the update by `{ _id, companyId }` together; letting the body
 * also name a company would give a caller two ways to say which tenant they
 * meant, and the disagreement between them is exactly where a scoping bug
 * lives.
 */
const UPDATE_FIELDS = Object.freeze([
  "name",
  "type",
  "direction",
  "ledgerId",
  "ledgerName",
  "amount",
  "frequency",
  "dayOfMonth",
  "dayOfWeek",
  "nextDueDate",
  "startDate",
  "endDate",
  "status",
  "notes",
]);

class RecurringItemError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecurringItemError";
    this.code = code;
  }
}

/** The shapes JS will happily turn into a plausible number or date. */
function rejectCoercibles(value, field) {
  if (typeof value === "boolean") {
    throw new RecurringItemError("INVALID_TYPE", `${field} must not be a boolean.`);
  }
  if (typeof value === "object" && value !== null) {
    // Arrays included: `new Date([2026,1,1])` and `Number([5])` both produce
    // something that looks like a real answer.
    throw new RecurringItemError("INVALID_TYPE", `${field} must not be an object or array.`);
  }
}

/** A required, non-empty, trimmed string. */
function parseRequiredString(value, field, maxLength = 200) {
  if (value === null || value === undefined) {
    throw new RecurringItemError("REQUIRED", `${field} is required.`);
  }
  rejectCoercibles(value, field);
  if (typeof value !== "string") {
    throw new RecurringItemError("INVALID_TYPE", `${field} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new RecurringItemError("REQUIRED", `${field} is required.`);
  }
  if (trimmed.length > maxLength) {
    throw new RecurringItemError("TOO_LONG", `${field} cannot exceed ${maxLength} characters.`);
  }
  return trimmed;
}

/** An optional string; "" and null both normalise to the same empty value. */
function parseOptionalString(value, field, { emptyAs = "", maxLength = 500 } = {}) {
  if (value === null || value === undefined || value === "") return emptyAs;
  rejectCoercibles(value, field);
  if (typeof value !== "string") {
    throw new RecurringItemError("INVALID_TYPE", `${field} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed === "") return emptyAs;
  if (trimmed.length > maxLength) {
    throw new RecurringItemError("TOO_LONG", `${field} cannot exceed ${maxLength} characters.`);
  }
  return trimmed;
}

/** One of a fixed set, or an error naming what was allowed. */
function parseEnum(value, allowed, field) {
  if (value === null || value === undefined || value === "") {
    throw new RecurringItemError("REQUIRED", `${field} is required.`);
  }
  rejectCoercibles(value, field);
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new RecurringItemError(
      "INVALID_ENUM",
      `${field} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

/**
 * A cash magnitude: positive, finite.
 *
 * Unsigned on purpose — `direction` carries the sign (see the model's own
 * note). Zero is refused rather than stored: a recurring movement of nothing
 * is an empty row, and it would add a silent no-op line to every future
 * forecast that reads this register.
 *
 * Decimal places are deliberately NOT constrained. A "max 2dp" rule reads as
 * obvious money hygiene but also rejects `0.1 + 0.2` — a value a client can
 * legitimately arrive at through ordinary float arithmetic — and refusing
 * real input is a worse failure here than storing a long decimal that only
 * ever renders rounded.
 */
function parseAmount(value, field = "amount") {
  if (value === null || value === undefined || value === "") {
    throw new RecurringItemError("REQUIRED", `${field} is required.`);
  }
  rejectCoercibles(value, field);
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new RecurringItemError("INVALID_TYPE", `${field} must be a number.`);
  }
  if (n <= 0) {
    throw new RecurringItemError("NOT_POSITIVE", `${field} must be greater than zero.`);
  }
  return n;
}

/** An integer within an inclusive range, or null when genuinely absent. */
function parseIntInRange(value, min, max, field) {
  if (value === null || value === undefined || value === "") return null;
  rejectCoercibles(value, field);
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new RecurringItemError("INVALID_TYPE", `${field} must be a number.`);
  }
  if (!Number.isInteger(n)) {
    throw new RecurringItemError("NOT_INTEGER", `${field} must be a whole number.`);
  }
  if (n < min || n > max) {
    throw new RecurringItemError("OUT_OF_RANGE", `${field} must be between ${min} and ${max}.`);
  }
  return n;
}

/**
 * A real date, or null when genuinely absent.
 *
 * `new Date(null)` is the Unix epoch, not an Invalid Date — a trap that has
 * bitten this codebase before (budgetNegotiation.service.js,
 * leadNextAction.js, and guarded explicitly in creditTerms.resolveDueDate).
 * Null is therefore handled BEFORE anything is constructed, and booleans are
 * refused outright because `new Date(true)` is a valid moment in 1970.
 */
function parseDate(value, field) {
  if (value === null || value === undefined || value === "") return null;

  // A real Date is checked FIRST and on its own terms. `rejectCoercibles`
  // refuses every object, and a Date IS an object — running it first would
  // reject the perfectly good `Date` mongoose hands back from a stored row,
  // which is exactly what `buildUpdate` re-reads when it validates a merged
  // result. (Found by services/recurringItems.test.js, not by inspection.)
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RecurringItemError("INVALID_DATE", `${field} is not a valid date.`);
    }
    return new Date(value.getTime());
  }

  rejectCoercibles(value, field);
  if (typeof value !== "string" && typeof value !== "number") {
    throw new RecurringItemError("INVALID_TYPE", `${field} must be a date.`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new RecurringItemError("INVALID_DATE", `${field} is not a valid date.`);
  }
  return d;
}

/** As `parseDate`, but absence is an error. */
function parseRequiredDate(value, field) {
  const d = parseDate(value, field);
  if (d === null) {
    throw new RecurringItemError("REQUIRED", `${field} is required.`);
  }
  return d;
}

/**
 * The schedule fields that a given frequency does and does not use.
 *
 * ── WHY AN INAPPLICABLE FIELD IS REFUSED, NOT IGNORED ───────────────────────
 * A monthly item carrying `dayOfWeek` means the sender misunderstood the
 * schedule they were describing. Storing it and ignoring it leaves a row that
 * reads, to the next person, as though a weekday rule is in force. Refusing
 * is the same "refuse rather than silently drop" rule `buildUpdate` applies
 * to unknown keys, applied to keys that are known but nonsensical here.
 *
 * ── WHY THESE ARE NOT CROSS-VALIDATED AGAINST nextDueDate ───────────────────
 * It is tempting to require that a monthly item's `nextDueDate` fall on its
 * own `dayOfMonth`. That rejects two legitimate cases: a pro-rated or
 * deferred FIRST occurrence (rent starting mid-month, an EMI holiday), and
 * any month-end rule that has already been clamped (dayOfMonth 31 with a
 * nextDueDate of 28 Feb is correct, not contradictory). `nextDueDate` is the
 * next occurrence; the day field is the rule for the ones after it. They are
 * allowed to differ, and a register that refused real schedules would be a
 * worse instrument than one that lets a visible, on-screen date be wrong.
 */
function parseSchedule(body, frequency) {
  const hasDayOfMonth =
    Object.prototype.hasOwnProperty.call(body, "dayOfMonth") &&
    body.dayOfMonth !== null &&
    body.dayOfMonth !== undefined &&
    body.dayOfMonth !== "";
  const hasDayOfWeek =
    Object.prototype.hasOwnProperty.call(body, "dayOfWeek") &&
    body.dayOfWeek !== null &&
    body.dayOfWeek !== undefined &&
    body.dayOfWeek !== "";

  if (frequency === "monthly") {
    if (hasDayOfWeek) {
      throw new RecurringItemError(
        "INAPPLICABLE_FIELD",
        "dayOfWeek does not apply to a monthly item — use dayOfMonth.",
      );
    }
    if (!hasDayOfMonth) {
      throw new RecurringItemError("REQUIRED", "dayOfMonth is required for a monthly item.");
    }
    return { dayOfMonth: parseIntInRange(body.dayOfMonth, 1, 31, "dayOfMonth"), dayOfWeek: null };
  }

  if (frequency === "weekly") {
    if (hasDayOfMonth) {
      throw new RecurringItemError(
        "INAPPLICABLE_FIELD",
        "dayOfMonth does not apply to a weekly item — use dayOfWeek.",
      );
    }
    if (!hasDayOfWeek) {
      throw new RecurringItemError("REQUIRED", "dayOfWeek is required for a weekly item.");
    }
    // NOTE: 0 is Sunday, a real value — `hasDayOfWeek` above tests presence
    // explicitly rather than truthiness for exactly this reason.
    return { dayOfMonth: null, dayOfWeek: parseIntInRange(body.dayOfWeek, 0, 6, "dayOfWeek") };
  }

  // Quarterly and yearly: `nextDueDate` alone carries the anchor, so
  // `dayOfMonth` is genuinely OPTIONAL rather than required — a quarterly GST
  // payment on the 20th can say so, or can leave the rule implicit in its
  // next due date. `dayOfWeek` remains meaningless and is refused.
  if (hasDayOfWeek) {
    throw new RecurringItemError(
      "INAPPLICABLE_FIELD",
      `dayOfWeek does not apply to a ${frequency} item.`,
    );
  }
  return {
    dayOfMonth: hasDayOfMonth ? parseIntInRange(body.dayOfMonth, 1, 31, "dayOfMonth") : null,
    dayOfWeek: null,
  };
}

/**
 * The two date invariants worth enforcing.
 *
 * Both are unambiguous: a window that closes before it opens is nonsense, and
 * an occurrence cannot precede the schedule that produces it. Deliberately
 * NOT enforced: `nextDueDate <= endDate`. An item whose next occurrence has
 * passed its end date is simply finished, which `status: "ended"` already
 * expresses — turning it into a validation error would block the ordinary act
 * of shortening a schedule.
 */
function assertDateOrder({ startDate, nextDueDate, endDate }) {
  if (startDate && nextDueDate && nextDueDate.getTime() < startDate.getTime()) {
    throw new RecurringItemError(
      "DATE_ORDER",
      "nextDueDate cannot be earlier than startDate.",
    );
  }
  if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
    throw new RecurringItemError("DATE_ORDER", "endDate cannot be earlier than startDate.");
  }
}

/** Refuse rather than ignore — see the file header. */
function assertNoUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new RecurringItemError(
      "UNSUPPORTED_FIELD",
      `Unsupported field(s): ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`,
    );
  }
}

function assertPlainObject(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RecurringItemError("INVALID_BODY", "Expected an object.");
  }
}

/**
 * Build the exact document to insert. Whitelist-only by construction: the
 * returned object is assembled field by field from `CREATE_FIELDS`, so a
 * caller cannot smuggle `source`, `createdBy`, or anything else through the
 * body. Provenance comes from `actor`, never from `body`.
 *
 * `companyId` is validated for PRESENCE here and cast/scoped by the route —
 * this file has no mongoose dependency and deliberately keeps none.
 *
 * No `now` parameter: unlike `creditTerms.buildUpdate`, which stamps its own
 * `creditTermsUpdatedAt`, this model carries no hand-rolled timestamp field.
 * `timestamps: true` on the schema is the single source of createdAt/updatedAt,
 * so there is no clock here to inject and none to get out of step.
 *
 * @param {object} body  the untrusted request body
 * @param {object} actor { id, name, email } — the authenticated user
 */
function buildCreate(body = {}, actor = {}) {
  assertPlainObject(body);
  assertNoUnknownFields(body, CREATE_FIELDS);

  if (!body.companyId) {
    throw new RecurringItemError("REQUIRED", "companyId is required.");
  }
  rejectCoercibles(body.companyId, "companyId");

  const frequency = parseEnum(body.frequency, FREQUENCY, "frequency");
  const { dayOfMonth, dayOfWeek } = parseSchedule(body, frequency);

  const startDate = parseRequiredDate(body.startDate, "startDate");
  const nextDueDate = parseRequiredDate(body.nextDueDate, "nextDueDate");
  const endDate = parseDate(body.endDate, "endDate");
  assertDateOrder({ startDate, nextDueDate, endDate });

  return {
    // companyId is passed through as given; the route casts it to an
    // ObjectId and is the only place that decides what company means.
    companyId: body.companyId,
    name: parseRequiredString(body.name, "name"),
    type: parseEnum(body.type, TYPE, "type"),
    direction: parseEnum(body.direction, DIRECTION, "direction"),
    ledgerId: body.ledgerId === "" || body.ledgerId === undefined ? null : body.ledgerId,
    ledgerName: parseOptionalString(body.ledgerName, "ledgerName", { emptyAs: null }),
    amount: parseAmount(body.amount),
    frequency,
    dayOfMonth,
    dayOfWeek,
    nextDueDate,
    startDate,
    endDate,
    status: Object.prototype.hasOwnProperty.call(body, "status")
      ? parseEnum(body.status, STATUS, "status")
      : "active",
    // Server-owned. C0-E never writes the other enum value; see the model.
    source: "manual",
    notes: parseOptionalString(body.notes, "notes"),
    createdBy: actor?.id || null,
    createdByName: actor?.name || actor?.email || null,
    updatedBy: actor?.id || null,
    updatedByName: actor?.name || actor?.email || null,
  };
}

/**
 * Build the exact `$set` for an update.
 *
 * PARTIAL by design — only the keys actually present in `body` are returned,
 * so a caller changing just `status` cannot blank out `notes` by omission.
 *
 * ── THE ONE PLACE THIS NEEDS THE EXISTING ROW ───────────────────────────────
 * Schedule validation is frequency-dependent, and a PATCH may change the
 * frequency, the day field, or only one of the two. `existing` supplies
 * whichever half the body omits, so changing `frequency` from weekly to
 * monthly correctly demands a `dayOfMonth`, and changing only `dayOfMonth` on
 * an already-monthly item is correctly allowed. Validating the merged result
 * rather than the patch alone is the only way to keep an item that was valid
 * before an edit still valid after it.
 *
 * @param {object} body     the untrusted request body
 * @param {object} existing the stored row (lean), for merge-then-validate
 * @param {object} actor    the authenticated user
 */
function buildUpdate(body = {}, existing = {}, actor = {}) {
  assertPlainObject(body);
  assertNoUnknownFields(body, UPDATE_FIELDS);

  const touched = Object.keys(body);
  if (touched.length === 0) {
    throw new RecurringItemError("NOTHING_TO_UPDATE", "No fields supplied.");
  }

  const $set = {};

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    $set.name = parseRequiredString(body.name, "name");
  }
  if (Object.prototype.hasOwnProperty.call(body, "type")) {
    $set.type = parseEnum(body.type, TYPE, "type");
  }
  if (Object.prototype.hasOwnProperty.call(body, "direction")) {
    $set.direction = parseEnum(body.direction, DIRECTION, "direction");
  }
  if (Object.prototype.hasOwnProperty.call(body, "amount")) {
    $set.amount = parseAmount(body.amount);
  }
  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    $set.status = parseEnum(body.status, STATUS, "status");
  }
  if (Object.prototype.hasOwnProperty.call(body, "notes")) {
    $set.notes = parseOptionalString(body.notes, "notes");
  }
  if (Object.prototype.hasOwnProperty.call(body, "ledgerId")) {
    rejectCoercibles(body.ledgerId, "ledgerId");
    $set.ledgerId = body.ledgerId === "" || body.ledgerId === undefined ? null : body.ledgerId;
  }
  if (Object.prototype.hasOwnProperty.call(body, "ledgerName")) {
    $set.ledgerName = parseOptionalString(body.ledgerName, "ledgerName", { emptyAs: null });
  }

  // ── Schedule: merge with `existing`, then validate the RESULT ────────────
  const touchesSchedule =
    Object.prototype.hasOwnProperty.call(body, "frequency") ||
    Object.prototype.hasOwnProperty.call(body, "dayOfMonth") ||
    Object.prototype.hasOwnProperty.call(body, "dayOfWeek");

  if (touchesSchedule) {
    const frequency = Object.prototype.hasOwnProperty.call(body, "frequency")
      ? parseEnum(body.frequency, FREQUENCY, "frequency")
      : parseEnum(existing.frequency, FREQUENCY, "frequency");

    // Only carry a stored day field forward when the body did not speak
    // about it AND it still applies to the (possibly new) frequency —
    // otherwise switching weekly → monthly would drag a stale `dayOfWeek`
    // into the merged shape and be refused as inapplicable, when what the
    // caller actually did was supply the right field for the new frequency.
    const merged = {};
    if (Object.prototype.hasOwnProperty.call(body, "dayOfMonth")) {
      merged.dayOfMonth = body.dayOfMonth;
    } else if (
      existing.dayOfMonth !== null &&
      existing.dayOfMonth !== undefined &&
      (frequency === "monthly" || frequency === "quarterly" || frequency === "yearly")
    ) {
      merged.dayOfMonth = existing.dayOfMonth;
    }
    if (Object.prototype.hasOwnProperty.call(body, "dayOfWeek")) {
      merged.dayOfWeek = body.dayOfWeek;
    } else if (
      existing.dayOfWeek !== null &&
      existing.dayOfWeek !== undefined &&
      frequency === "weekly"
    ) {
      merged.dayOfWeek = existing.dayOfWeek;
    }

    const schedule = parseSchedule(merged, frequency);
    $set.frequency = frequency;
    $set.dayOfMonth = schedule.dayOfMonth;
    $set.dayOfWeek = schedule.dayOfWeek;
  }

  // ── Dates: same merge-then-validate, so order invariants hold after the
  //    edit rather than only within the patch.
  const touchesDates =
    Object.prototype.hasOwnProperty.call(body, "startDate") ||
    Object.prototype.hasOwnProperty.call(body, "nextDueDate") ||
    Object.prototype.hasOwnProperty.call(body, "endDate");

  if (touchesDates) {
    if (Object.prototype.hasOwnProperty.call(body, "startDate")) {
      $set.startDate = parseRequiredDate(body.startDate, "startDate");
    }
    if (Object.prototype.hasOwnProperty.call(body, "nextDueDate")) {
      $set.nextDueDate = parseRequiredDate(body.nextDueDate, "nextDueDate");
    }
    if (Object.prototype.hasOwnProperty.call(body, "endDate")) {
      // An explicit null/"" here CLEARS the end date — an open-ended
      // schedule is a real thing a person may want back.
      $set.endDate = parseDate(body.endDate, "endDate");
    }

    assertDateOrder({
      startDate: $set.startDate ?? parseDate(existing.startDate, "startDate"),
      nextDueDate: $set.nextDueDate ?? parseDate(existing.nextDueDate, "nextDueDate"),
      endDate: Object.prototype.hasOwnProperty.call($set, "endDate")
        ? $set.endDate
        : parseDate(existing.endDate, "endDate"),
    });
  }

  $set.updatedBy = actor?.id || null;
  $set.updatedByName = actor?.name || actor?.email || null;

  return $set;
}

/**
 * May this user change recurring items?
 *
 * Delegates to `creditTerms.canEditTerms` rather than re-deriving the rule.
 * The predicate is "does this accounting role have canEdit", which is not
 * specific to credit terms — re-implementing it here would create a second
 * copy free to drift from the first, which is precisely what the shared
 * `isTermSet` treatment was meant to avoid elsewhere in C0. The alias exists
 * only so the call site in a recurring-items route reads honestly.
 */
const canEdit = canEditTerms;

module.exports = {
  TYPE,
  DIRECTION,
  FREQUENCY,
  STATUS,
  SOURCE,
  CREATE_FIELDS,
  UPDATE_FIELDS,
  RecurringItemError,
  parseAmount,
  parseIntInRange,
  parseDate,
  parseRequiredDate,
  parseEnum,
  parseRequiredString,
  parseOptionalString,
  parseSchedule,
  assertDateOrder,
  buildCreate,
  buildUpdate,
  canEdit,
};
