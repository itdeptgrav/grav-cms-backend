"use strict";
/**
 * services/access/hrScopeClassifier.js — what organisational scope does the
 * evidence on this record actually support?
 *
 * HRMS Chunk 2A. READ-ONLY AND PURE: nothing here saves, updates, backfills or
 * normalises anything. It takes evidence that a caller has already gathered and
 * returns a classification plus the provenance for it. Database orchestration
 * belongs to the audit runner (scripts/audits/hrOrganisationScope.js), which is
 * the only place that knows how to fetch.
 *
 * WHY A CLASSIFIER RATHER THAN A RESOLVER
 * ---------------------------------------
 * The tempting shape is `resolveCompanyFor(record)` returning an id. That shape
 * cannot express the answers that matter before a migration: "two companies are
 * equally consistent with this record", "the record says one thing and its
 * department says another", "the reference points at nothing". A resolver has
 * to pick, and picking is exactly what turns an unknown into a wrong answer
 * that is then written down.
 *
 * So this returns a STATUS, and only `SCOPED` and `DERIVABLE_UNAMBIGUOUS` carry
 * an id. Chunk 2B may populate from those two and must quarantine the rest.
 *
 * THE RULES, IN ONE PLACE
 *   • Never choose the first matching candidate. More than one distinct
 *     candidate is AMBIGUOUS, not a decision.
 *   • Direct evidence that disagrees with derived evidence is CONFLICT, never
 *     "the direct one wins" — a record whose own field contradicts its
 *     department is a data-quality fact, not a preference.
 *   • Missing stays missing. There is no default company.
 *   • Organisation placement never implies application access; this file has no
 *     concept of a capability and must never gain one.
 *   • Diagnostics carry ids and machine labels only — never a name, an address,
 *     an email, pay, a bank account or a government identifier.
 */

/* ── Outcomes ────────────────────────────────────────────────────────────────*/
const SCOPE_STATUS = Object.freeze({
  /** The record carries the scope itself, and it resolves. */
  SCOPED: "SCOPED",
  /** No direct scope, but exactly one candidate follows from other evidence. */
  DERIVABLE_UNAMBIGUOUS: "DERIVABLE_UNAMBIGUOUS",
  /** No evidence at all. Stays missing; nothing is invented. */
  MISSING: "MISSING",
  /** More than one distinct candidate. A choice, not an answer. */
  AMBIGUOUS: "AMBIGUOUS",
  /** Direct and derived evidence disagree. */
  CONFLICT: "CONFLICT",
  /** A scope reference that resolves to nothing. */
  DANGLING_REFERENCE: "DANGLING_REFERENCE",
  /** The evidence is in a shape this contract cannot read — e.g. a free-text
   *  site label with no reference behind it. */
  UNSUPPORTED_LEGACY_SHAPE: "UNSUPPORTED_LEGACY_SHAPE",
});

/** Statuses Chunk 2B may populate from. Everything else is quarantined. */
const POPULATABLE = Object.freeze([SCOPE_STATUS.SCOPED, SCOPE_STATUS.DERIVABLE_UNAMBIGUOUS]);

const SCOPE_LEVELS = Object.freeze([
  "company",
  "legalEntity",
  "establishment",
  "department",
  "line",
]);

/* ── Privacy ─────────────────────────────────────────────────────────────────
 *
 * An audit that leaks the thing it is auditing is worse than no audit. These
 * are the keys that must never appear anywhere in a diagnostic, at any depth,
 * and `containsPrivateData` is what the audit asserts against its own output
 * before printing it.
 */
const PROHIBITED_DIAGNOSTIC_KEYS = Object.freeze([
  "firstName", "middleName", "lastName", "name", "fullName", "employeeName",
  "email", "personalEmail", "phone", "alternatePhone", "workPhone",
  "address", "dateOfBirth", "placeOfBirth",
  "salary", "salaryCustomFields", "bankDetails", "accountNumber", "ifscCode",
  "aadharNumber", "panNumber", "uanNumber", "esicNumber", "pfNumber",
  "passportNumber", "voterIdNumber", "drivingLicenseNumber",
  "bloodGroup", "isPhysicallyChallenged",
  "password", "temporaryPassword", "passwordHash", "newPassword",
  "documents", "sopPoints",
]);

const PROHIBITED_KEY_SET = new Set(PROHIBITED_DIAGNOSTIC_KEYS);

/**
 * Does this value carry anything the audit must not print?
 *
 * Key-based, recursive, and deliberately not clever: it reports the PATHS it
 * objected to so a failure is actionable, and it never reports the values.
 */
function containsPrivateData(value, path = "", found = []) {
  if (value === null || value === undefined) return found;
  if (Array.isArray(value)) {
    value.forEach((v, i) => containsPrivateData(v, `${path}[${i}]`, found));
    return found;
  }
  if (typeof value !== "object" || value instanceof Date) return found;

  for (const [key, v] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (PROHIBITED_KEY_SET.has(key)) found.push(here);
    containsPrivateData(v, here, found);
  }
  return found;
}

/* ── Helpers ─────────────────────────────────────────────────────────────────*/

const idOf = (value) => (value === null || value === undefined ? null : String(value));

/** Present means present. `""`, `null` and `undefined` are all "no evidence". */
function isPresent(value) {
  return idOf(value) !== null && idOf(value).trim() !== "";
}

/* ── The classifier ──────────────────────────────────────────────────────────*/

/**
 * @param {object}  input
 * @param {string}  input.level         one of SCOPE_LEVELS, for the diagnostic
 * @param {*}       [input.direct]      the scope id ON the record itself
 * @param {boolean|null} [input.directExists]
 *        `true`  the direct id resolves to a record
 *        `false` it does not — a dangling reference
 *        `null`  existence was not checked (the classifier will not assume)
 * @param {Array<{id:*, via:string, exists?:boolean|null}>} [input.derived]
 *        candidates that FOLLOW from other evidence. `via` is a machine label
 *        naming the path the candidate came from, never a human value.
 * @param {string|null} [input.legacyShape]
 *        a named legacy encoding the contract cannot read, e.g.
 *        "free-text-work-location".
 *
 * @returns {{status:string, level:string, scopeId:string|null,
 *            evidence:Array, candidateIds:string[], populatable:boolean}}
 */
function classifyScope({ level, direct = null, directExists = null, derived = [], legacyShape = null } = {}) {
  const evidence = [];
  const answer = (status, scopeId = null, extra = {}) => ({
    status,
    level: level || "unknown",
    scopeId,
    evidence,
    populatable: POPULATABLE.includes(status),
    ...extra,
  });

  /* A shape the contract cannot read is not "missing" — missing invites a
     backfill, and this one needs a decision first. `Employee.workLocation` is
     the live example: a free-text label defaulting to a company name, which
     looks like a site and references nothing. */
  if (legacyShape) {
    evidence.push({ kind: "legacy-shape", detail: String(legacyShape) });
    return answer(SCOPE_STATUS.UNSUPPORTED_LEGACY_SHAPE, null, { candidateIds: [] });
  }

  const directId = isPresent(direct) ? idOf(direct) : null;

  /* Candidates, deduplicated by id. Two evidence paths arriving at the SAME
     company are one candidate found twice, not a choice — the same reasoning
     services/companyContext/companyMembership.service.js applies to
     memberships. */
  const byId = new Map();
  const dangling = [];
  for (const candidate of derived || []) {
    if (!candidate || !isPresent(candidate.id)) continue;
    const id = idOf(candidate.id);
    if (candidate.exists === false) {
      dangling.push({ kind: "derived-dangling", id, via: String(candidate.via || "unknown") });
      continue;
    }
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(String(candidate.via || "unknown"));
  }
  const candidateIds = [...byId.keys()].sort();
  for (const id of candidateIds) {
    evidence.push({ kind: "derived", id, via: byId.get(id).sort() });
  }
  evidence.push(...dangling);

  if (directId) {
    evidence.unshift({ kind: "direct", id: directId, exists: directExists });

    /* A reference that points at nothing cannot be reconciled against
       anything — including a derived candidate that happens to agree. */
    if (directExists === false) {
      return answer(SCOPE_STATUS.DANGLING_REFERENCE, null, { candidateIds });
    }

    /* Direct AND derived, disagreeing. NOT "the direct one wins": the record's
       own field and the department it sits in are two assertions about the same
       fact, and a migration that silently prefers one writes the disagreement
       down as truth. */
    const disagreeing = candidateIds.filter((id) => id !== directId);
    if (disagreeing.length) {
      return answer(SCOPE_STATUS.CONFLICT, null, { candidateIds, conflictingIds: disagreeing });
    }

    return answer(SCOPE_STATUS.SCOPED, directId, { candidateIds });
  }

  if (candidateIds.length === 1) {
    return answer(SCOPE_STATUS.DERIVABLE_UNAMBIGUOUS, candidateIds[0], { candidateIds });
  }
  if (candidateIds.length > 1) {
    /* Deliberately no `candidateIds[0]`. */
    return answer(SCOPE_STATUS.AMBIGUOUS, null, { candidateIds });
  }
  if (dangling.length) {
    return answer(SCOPE_STATUS.DANGLING_REFERENCE, null, { candidateIds });
  }

  return answer(SCOPE_STATUS.MISSING, null, { candidateIds });
}

/* ── Scoped uniqueness ───────────────────────────────────────────────────────
 *
 * Today `biometricId`, `identityId` and `email` are globally unique on Employee,
 * and a payroll run is unique on `{month, year}` for the whole platform. Under
 * the canonical contract those keys gain a scope prefix, which turns some of
 * today's would-be duplicates into legal records — and leaves the rest illegal.
 *
 * A duplicate group is only LEGAL_UNDER_SCOPE when every member resolves to a
 * DIFFERENT, KNOWN scope. Members whose scope is missing, ambiguous, conflicting
 * or dangling cannot be shown to be in different scopes, so the group stays
 * INVALID — an unknown is not a distinction.
 */
const DUPLICATE_VERDICT = Object.freeze({
  UNIQUE: "UNIQUE",
  LEGAL_UNDER_SCOPE: "LEGAL_UNDER_SCOPE",
  INVALID_UNDER_SCOPE: "INVALID_UNDER_SCOPE",
  UNDECIDABLE: "UNDECIDABLE",
});

/**
 * The uniqueness key a value would have once scope exists.
 *
 * JSON rather than a delimiter join, for the reason
 * services/access/hrAuthorization.js's cache key gives at length: a join is
 * injective only if no component can contain the delimiter, and these
 * components are data.
 */
function scopedUniquenessKey({ companyId = null, establishmentId = null, value }) {
  return JSON.stringify([idOf(companyId), idOf(establishmentId), idOf(value)]);
}

/**
 * @param {Array<{recordId:*, companyId?:*, establishmentId?:*, scopeStatus?:string}>} members
 *        every record sharing one value of the identifier under test
 * @returns {{verdict:string, groups:number, undecidableCount:number}}
 */
function classifyDuplicateGroup(members = []) {
  if (members.length <= 1) {
    return { verdict: DUPLICATE_VERDICT.UNIQUE, groups: members.length, undecidableCount: 0 };
  }

  const keys = new Set();
  let undecidable = 0;

  for (const m of members) {
    const known =
      isPresent(m.companyId) &&
      (m.scopeStatus === undefined || POPULATABLE.includes(m.scopeStatus));
    if (!known) {
      undecidable += 1;
      continue;
    }
    keys.add(scopedUniquenessKey({
      companyId: m.companyId,
      establishmentId: m.establishmentId,
      value: "",
    }));
  }

  /* Any member whose scope is not known keeps the group illegal: it might be in
     the same scope as another member, and "might" is not a distinction. */
  if (undecidable) {
    return {
      verdict: DUPLICATE_VERDICT.INVALID_UNDER_SCOPE,
      groups: keys.size,
      undecidableCount: undecidable,
    };
  }

  return {
    verdict:
      keys.size === members.length
        ? DUPLICATE_VERDICT.LEGAL_UNDER_SCOPE
        : DUPLICATE_VERDICT.INVALID_UNDER_SCOPE,
    groups: keys.size,
    undecidableCount: 0,
  };
}

module.exports = {
  SCOPE_STATUS,
  SCOPE_LEVELS,
  POPULATABLE,
  DUPLICATE_VERDICT,
  PROHIBITED_DIAGNOSTIC_KEYS,
  classifyScope,
  classifyDuplicateGroup,
  scopedUniquenessKey,
  containsPrivateData,
};
