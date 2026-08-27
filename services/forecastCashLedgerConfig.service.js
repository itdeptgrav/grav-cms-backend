/**
 * GRAV-CMS-BACKEND/services/forecastCashLedgerConfig.service.js
 *
 * CHUNK 1-D — validating and suggesting the operating-cash ledger selection.
 * PURE: no Mongo, no clock of its own, no HTTP.
 *
 * Two jobs, both decisions rather than plumbing:
 *   1. `buildUpdate` — validate a finance-supplied selection, strictly.
 *   2. `suggestRole` / `buildCandidates` — propose a starting point for a
 *      company that has never saved one.
 *
 * ── THE SUGGESTION IS A SUGGESTION ──────────────────────────────────────────
 * Nothing here decides what counts as cash. A heuristic that silently removed
 * an account from a company's opening balance would be exactly as wrong as the
 * behaviour this chunk fixes, just in the other direction. Suggestions are
 * rendered as pre-selected controls a person confirms; until they save, the
 * forecast's existing behaviour is unchanged and the UI says the selection is
 * unsaved.
 */

const { canEditTerms } = require("./creditTerms.service");

const ROLE = Object.freeze({
  INCLUDED: "included",
  EXCLUDED: "excluded",
  OD: "od",
});
const ROLES = Object.freeze([ROLE.INCLUDED, ROLE.EXCLUDED, ROLE.OD]);

/** Exactly the keys a caller may send. `companyId` is scope, not a field. */
const UPDATE_FIELDS = Object.freeze([
  "companyId",
  "includedLedgerIds",
  "excludedLedgerIds",
  "odLedgerIds",
  "notes",
]);

const MAX_NOTES_LENGTH = 1000;

/** A 24-character hex ObjectId, as a string. Casting is the route's job. */
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * Group names that make a ledger a candidate at all.
 *
 * Quoted from `Acc_books.js`'s own cash-flow report rather than re-derived, so
 * the forecast's idea of "cash-shaped" cannot drift from the report a person
 * would check it against.
 */
const CASH_GROUP_NAMES = Object.freeze(["Cash-in-Hand", "Bank Accounts", "Bank OD A/c"]);

/** The group that means "this is borrowing, not cash". A structural signal. */
const OD_GROUP_NAMES = Object.freeze(["Bank OD A/c"]);

/**
 * Name patterns that suggest an account belongs to a PERSON rather than the
 * company. Suggestion only — never a decision.
 *
 * ── WHY THESE, AND WHY NOT MORE ─────────────────────────────────────────────
 * Each is a signal actually present in this company's chart, not a guess at
 * what one might look like:
 *
 *   · `PA-1234` — the chart distinguishes personal accounts from current
 *     accounts by a numbering convention: "CEO Bank A/c (PA-6353)" beside
 *     "INDIAN BANK (CA-3512)". PA/CA is a real, load-bearing convention here.
 *   · `personal` — literal, as in "CEO's Personal Cash".
 *   · a POSSESSIVE officer title ("CEO's …", "Director's …"). The apostrophe
 *     is the discriminator on purpose: "CEO's HDFC Bank A/c" reads as an
 *     account belonging to a person, while "CEO Operations Account" does not,
 *     and matching a bare title would flag the second.
 *
 * The asymmetry justifies leaning slightly towards flagging: a wrongly
 * suggested exclusion is one click to undo, while a missed personal account
 * silently inflates opening cash — the exact defect this chunk exists to fix.
 * Nothing broader (a person's first name, "savings", an account number shape)
 * is matched, because those are guesses rather than signals, and a suggestion
 * that is usually wrong trains people to click past it.
 */
const PERSONAL_PATTERNS = Object.freeze([
  /\bPA[-\s]?\d/i,
  /\bpersonal\b/i,
  /\b(ceo|md|director|proprietor|partner|owner)['’]s\b/i,
]);

class ForecastCashLedgerConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ForecastCashLedgerConfigError";
    this.code = code;
  }
}

function assertPlainObject(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ForecastCashLedgerConfigError("INVALID_BODY", "Expected an object.");
  }
}

function assertNoUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new ForecastCashLedgerConfigError(
      "UNSUPPORTED_FIELD",
      `Unsupported field(s): ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`,
    );
  }
}

/** A required, non-empty identifier string. */
function parseRequiredId(value, field) {
  if (value === null || value === undefined || value === "") {
    throw new ForecastCashLedgerConfigError("REQUIRED", `${field} is required.`);
  }
  if (typeof value === "boolean" || (typeof value === "object" && value !== null)) {
    throw new ForecastCashLedgerConfigError("INVALID_TYPE", `${field} must be an id.`);
  }
  const s = String(value).trim();
  if (!OBJECT_ID_RE.test(s)) {
    throw new ForecastCashLedgerConfigError("INVALID_ID", `${field} is not a valid id.`);
  }
  return s;
}

/**
 * An array of distinct, well-formed ledger ids. Absent means an empty list.
 *
 * A duplicate is refused rather than de-duplicated: it means the caller's own
 * state was inconsistent, and quietly collapsing it hides that from them.
 */
function parseLedgerIdArray(value, field) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ForecastCashLedgerConfigError("INVALID_TYPE", `${field} must be an array.`);
  }

  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw === "boolean" || (typeof raw === "object" && raw !== null)) {
      throw new ForecastCashLedgerConfigError(
        "INVALID_TYPE",
        `${field} must contain only ids.`,
      );
    }
    const s = String(raw).trim();
    if (!OBJECT_ID_RE.test(s)) {
      throw new ForecastCashLedgerConfigError(
        "INVALID_ID",
        `${field} contains an id that is not valid: ${s}.`,
      );
    }
    if (seen.has(s)) {
      throw new ForecastCashLedgerConfigError(
        "DUPLICATE_ID",
        `${field} lists the same ledger twice: ${s}.`,
      );
    }
    seen.add(s);
    out.push(s);
  }
  return out;
}

function parseNotes(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "string") {
    throw new ForecastCashLedgerConfigError("INVALID_TYPE", "notes must be text.");
  }
  const t = value.trim();
  if (t.length > MAX_NOTES_LENGTH) {
    throw new ForecastCashLedgerConfigError(
      "TOO_LONG",
      `notes cannot exceed ${MAX_NOTES_LENGTH} characters.`,
    );
  }
  return t;
}

/**
 * A ledger may hold exactly one role.
 *
 * Both conflicts are refused rather than resolved by precedence. "Included and
 * excluded" and "cash and overdraft" are contradictions about what a ledger
 * IS; picking a winner would silently keep half of a selection the caller
 * plainly did not mean, and the money moves either way.
 */
function assertNoRoleConflicts({ includedLedgerIds, excludedLedgerIds, odLedgerIds }) {
  const inc = new Set(includedLedgerIds);

  for (const id of excludedLedgerIds) {
    if (inc.has(id)) {
      throw new ForecastCashLedgerConfigError(
        "ROLE_CONFLICT",
        `A ledger cannot be both included and excluded: ${id}.`,
      );
    }
  }
  for (const id of odLedgerIds) {
    if (inc.has(id)) {
      throw new ForecastCashLedgerConfigError(
        "ROLE_CONFLICT",
        `A ledger cannot be both operating cash and OD: ${id}.`,
      );
    }
  }
  const exc = new Set(excludedLedgerIds);
  for (const id of odLedgerIds) {
    if (exc.has(id)) {
      throw new ForecastCashLedgerConfigError(
        "ROLE_CONFLICT",
        `A ledger cannot be both excluded and OD: ${id}.`,
      );
    }
  }
}

/**
 * Validate a PATCH and build the exact document to store.
 *
 * Whitelist-only by construction. Provenance comes from `actor`, never the
 * body — a client that could set `updatedByName` could attribute a change to
 * whoever it liked.
 */
function buildUpdate(body = {}, actor = {}) {
  assertPlainObject(body);
  assertNoUnknownFields(body, UPDATE_FIELDS);

  const companyId = parseRequiredId(body.companyId, "companyId");
  const includedLedgerIds = parseLedgerIdArray(body.includedLedgerIds, "includedLedgerIds");
  const excludedLedgerIds = parseLedgerIdArray(body.excludedLedgerIds, "excludedLedgerIds");
  const odLedgerIds = parseLedgerIdArray(body.odLedgerIds, "odLedgerIds");

  assertNoRoleConflicts({ includedLedgerIds, excludedLedgerIds, odLedgerIds });

  return {
    scope: { companyId },
    $set: {
      includedLedgerIds,
      excludedLedgerIds,
      odLedgerIds,
      notes: parseNotes(body.notes),
      updatedBy: actor?.id || null,
      updatedByName: actor?.name || actor?.email || null,
    },
  };
}

/** Does this ledger's name look like it belongs to a person? Suggestion only. */
function looksPersonal(name) {
  if (!name || typeof name !== "string") return false;
  return PERSONAL_PATTERNS.some((re) => re.test(name));
}

/**
 * The role to PRE-SELECT for a ledger nobody has ruled on yet.
 *
 * Order matters: the group is a structural fact and outranks a name pattern,
 * so an OD account named anything at all is still suggested as OD.
 */
function suggestRole(ledger = {}) {
  if (OD_GROUP_NAMES.includes(ledger.groupName)) return ROLE.OD;
  if (looksPersonal(ledger.name)) return ROLE.EXCLUDED;
  return ROLE.INCLUDED;
}

/**
 * Pair every candidate ledger with its suggested role and its currently
 * selected one.
 *
 * With no saved config, `selectedRole` mirrors the suggestion — the UI shows
 * a filled-in form the person confirms, not a blank one they must build. With
 * a config, a ledger the config has never heard of (newly created since it
 * was saved) falls back to its suggestion rather than vanishing.
 *
 * @param {Array}  ledgers `[{ _id, name, groupName, balance }]`
 * @param {object|null} config the saved config, or null
 */
function buildCandidates(ledgers = [], config = null) {
  const inc = new Set((config?.includedLedgerIds || []).map(String));
  const exc = new Set((config?.excludedLedgerIds || []).map(String));
  const od = new Set((config?.odLedgerIds || []).map(String));
  const hasConfig = !!config;

  return (ledgers || []).map((l) => {
    const id = String(l._id);
    const suggestedRole = suggestRole(l);

    let selectedRole;
    if (!hasConfig) selectedRole = suggestedRole;
    else if (inc.has(id)) selectedRole = ROLE.INCLUDED;
    else if (exc.has(id)) selectedRole = ROLE.EXCLUDED;
    else if (od.has(id)) selectedRole = ROLE.OD;
    else selectedRole = suggestedRole; // created after the config was saved

    return {
      ledgerId: id,
      name: l.name || null,
      groupName: l.groupName || null,
      currentBalance: typeof l.balance === "number" ? l.balance : null,
      suggestedRole,
      selectedRole,
      // Surfaced so the screen can say WHY a row is pre-set to excluded,
      // rather than appearing to have an opinion out of nowhere.
      personalNameSignal: looksPersonal(l.name),
    };
  });
}

/** May this user change the selection? Same predicate as everywhere in C0/1. */
const canEdit = canEditTerms;

module.exports = {
  ROLE,
  ROLES,
  UPDATE_FIELDS,
  MAX_NOTES_LENGTH,
  CASH_GROUP_NAMES,
  OD_GROUP_NAMES,
  PERSONAL_PATTERNS,
  ForecastCashLedgerConfigError,
  parseRequiredId,
  parseLedgerIdArray,
  parseNotes,
  assertNoRoleConflicts,
  buildUpdate,
  looksPersonal,
  suggestRole,
  buildCandidates,
  canEdit,
};
