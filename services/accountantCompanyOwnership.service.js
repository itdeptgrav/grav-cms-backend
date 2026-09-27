// services/accountantCompanyOwnership.service.js
//
// WHO OWNS AN ACCOUNTING COMPANY.
//
// Decision D2 (docs/decisions/accounting-metabase-self-service-reporting.md):
// **an Accounting company belongs to exactly one `Acc_Organization` at a time.**
//
// `Acc_Organization.tallyCompanyIds[]` stays the canonical ownership record —
// there is no second source, and no `organizationId` is copied onto financial
// documents. What changes is that the invariant is now enforced rather than
// assumed.
//
// ─── WHY A SERVICE AND NOT AN `if` AT EACH CALL SITE ─────────────────────────
// Ownership was assigned in exactly one production path (`sync-legacy` in
// routes/Accountant_Routes/Acc_auth.js), and it did this:
//
//     org.tallyCompanyIds = companies.map((c) => c._id);
//
// — every company in the database, assigned to whichever organisation asked
// first, with no check that another organisation already held them. That was
// harmless only because the deployment happens to have one organisation.
//
// A check written at the call site would be a read followed by a write, which
// two concurrent requests interleave: both read "unowned", both write, and the
// last one silently seizes the company. So the check lives here, and the
// authority is the unique index described below — this module's job is to ask
// politely first and to translate the index's refusal into an answer a route
// can return.
//
// ─── THE INDEX ───────────────────────────────────────────────────────────────
//     { tallyCompanyIds: 1 }
//     unique: true
//     partialFilterExpression: { tallyCompanyIds: { $type: "objectId" } }
//
// A unique index on an array field is a MULTIKEY unique index: MongoDB indexes
// one key per array element, so uniqueness is enforced per ELEMENT across
// documents. Two organisation documents cannot hold the same company id.
//
// The partial filter is what keeps empty ownership legal. MongoDB indexes an
// empty array as a single `undefined` key, so without the filter the second
// organisation with `tallyCompanyIds: []` would collide with the first. The
// filter admits only documents whose array holds at least one ObjectId, which
// excludes both `[]` and a missing field, and any number of organisations may
// own nothing.
//
// Within one document the index is not a constraint — multikey keys are
// de-duplicated — so `[A, A]` would be accepted. That is why every write here
// uses `$addToSet` rather than `$push`.
//
// `autoIndex` is on outside production (server.js:782), so tests and dev build
// this from the schema declaration. Production builds it through
// scripts/migrations/accounting-company-ownership-index.js, which refuses while
// conflicting data exists.

"use strict";

const mongoose = require("mongoose");

/** The index name is part of the contract — the migration verifies it by name. */
const OWNERSHIP_INDEX_NAME = "acc_org_company_ownership_unique";

const OWNERSHIP_INDEX_SPEC = Object.freeze({ tallyCompanyIds: 1 });

const OWNERSHIP_INDEX_OPTIONS = Object.freeze({
  unique: true,
  name: OWNERSHIP_INDEX_NAME,
  partialFilterExpression: { tallyCompanyIds: { $type: "objectId" } },
});

const COMPANY_OWNERSHIP_CODES = Object.freeze({
  /** Another organisation already owns this company. */
  ALREADY_OWNED: "ACCOUNTING_COMPANY_ALREADY_OWNED",
  /** Not a usable company id. */
  INVALID_ID: "ACCOUNTING_COMPANY_ID_INVALID",
  /** The organisation to attach to does not exist. */
  ORGANIZATION_NOT_FOUND: "ACCOUNTING_ORGANIZATION_NOT_FOUND",
});

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

function getOrgModel() {
  const { Acc_Organization } = require("../models/Accountant_model/Acc_OrgModels");
  return Acc_Organization;
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Turn whatever the caller passed into a de-duplicated list of 24-hex company
 * id strings, or say which value was unusable.
 *
 * Accepts a single value or an array; accepts ObjectIds, strings and documents
 * carrying `_id`, because the call sites hold all three shapes.
 *
 * @returns {{ok: true, ids: string[]}
 *         | {ok: false, status: 400, code: string, message: string, companyId: string|null}}
 */
function normaliseCompanyIds(input) {
  const raw = input === undefined || input === null ? [] : Array.isArray(input) ? input : [input];
  const ids = [];

  for (const value of raw) {
    // `{ _id }` covers a lean company document being handed straight in.
    const candidate =
      value && typeof value === "object" && !(value instanceof mongoose.Types.ObjectId) && value._id !== undefined
        ? value._id
        : value;

    if (candidate === undefined || candidate === null || candidate === "") {
      return invalid(null);
    }
    const asString = String(candidate).trim();
    if (!OBJECT_ID_RE.test(asString)) {
      // The offending value is NOT echoed back — it is caller-supplied and may
      // be anything at all. The code says what went wrong.
      return invalid(null);
    }
    if (!ids.includes(asString)) ids.push(asString);
  }

  return { ok: true, ids };

  function invalid(companyId) {
    return {
      ok: false,
      status: 400,
      code: COMPANY_OWNERSHIP_CODES.INVALID_ID,
      message: "One of the supplied company ids is not a valid id.",
      companyId,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Conflict detection                                                  */
/* ------------------------------------------------------------------ */

/**
 * The first of `companyIds` that some OTHER organisation owns, or null.
 *
 * Returns the company id only. The other organisation's id and name stay here:
 * a caller being refused has no business learning who holds the company, and a
 * refusal that named the holder would turn this into a directory of tenants.
 */
async function findForeignOwnedCompanyId(organizationId, companyIds) {
  if (companyIds.length === 0) return null;

  const owner = await getOrgModel()
    .findOne({
      _id: { $ne: new mongoose.Types.ObjectId(String(organizationId)) },
      tallyCompanyIds: { $in: companyIds.map((id) => new mongoose.Types.ObjectId(id)) },
    })
    .select("tallyCompanyIds")
    .lean();

  if (!owner) return null;

  const held = new Set((owner.tallyCompanyIds || []).map(String));
  return companyIds.find((id) => held.has(id)) || null;
}

/**
 * Every company id held by more than one organisation.
 *
 * Used by the readiness migration and by the tests; never by a request path.
 * @returns {Promise<Array<{companyId: string, organizationIds: string[]}>>}
 */
async function findOwnershipConflicts() {
  const rows = await getOrgModel().aggregate([
    { $match: { tallyCompanyIds: { $type: "objectId" } } },
    { $unwind: "$tallyCompanyIds" },
    { $group: { _id: "$tallyCompanyIds", organizationIds: { $addToSet: "$_id" } } },
    { $match: { "organizationIds.1": { $exists: true } } },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((r) => ({
    companyId: String(r._id),
    organizationIds: r.organizationIds.map(String).sort(),
  }));
}

/* ------------------------------------------------------------------ */
/* Attachment                                                          */
/* ------------------------------------------------------------------ */

function alreadyOwnedRefusal(companyId) {
  return {
    ok: false,
    status: 409,
    code: COMPANY_OWNERSHIP_CODES.ALREADY_OWNED,
    // Names the company — the caller supplied it and is entitled to know which
    // one was refused — and nothing about the organisation that holds it.
    message: "This company is already assigned to another accounting organization.",
    companyId: companyId || null,
  };
}

/**
 * Attach one or more companies to an organisation. All of them, or none.
 *
 * ALL-OR-NOTHING is a property of the write, not of a loop: the whole set goes
 * in one `$addToSet … $each` on one document, so MongoDB either applies the
 * update or rejects it whole. There is no partial state to unwind, and no
 * transaction is needed to get that.
 *
 * IDEMPOTENT for the current owner: companies this organisation already holds
 * are reported in `alreadyAttached` and the update is a no-op for them.
 * Re-running the same call — which `sync-legacy` does on every login — changes
 * nothing and succeeds.
 *
 * @returns {Promise<{ok: true, attached: string[], alreadyAttached: string[]}
 *                 | {ok: false, status, code, message, companyId}>}
 */
async function attachCompaniesToOrganization({ organizationId, companyIds }) {
  const normalised = normaliseCompanyIds(companyIds);
  if (!normalised.ok) return normalised;

  const orgIdString = String(organizationId || "");
  if (!OBJECT_ID_RE.test(orgIdString)) {
    return {
      ok: false,
      status: 400,
      code: COMPANY_OWNERSHIP_CODES.ORGANIZATION_NOT_FOUND,
      message: "Organization not found.",
      companyId: null,
    };
  }

  const Acc_Organization = getOrgModel();
  const organization = await Acc_Organization.findById(orgIdString).select("tallyCompanyIds").lean();
  if (!organization) {
    return {
      ok: false,
      status: 404,
      code: COMPANY_OWNERSHIP_CODES.ORGANIZATION_NOT_FOUND,
      message: "Organization not found.",
      companyId: null,
    };
  }

  const ids = normalised.ids;
  const owned = new Set((organization.tallyCompanyIds || []).map(String));
  const alreadyAttached = ids.filter((id) => owned.has(id));
  const toAttach = ids.filter((id) => !owned.has(id));

  if (toAttach.length === 0) {
    return { ok: true, attached: [], alreadyAttached };
  }

  // Ask first. This is courtesy, not enforcement — it produces a clear answer
  // naming the specific company in the ordinary case, and it is the index
  // below that actually holds the line when two requests race.
  const foreign = await findForeignOwnedCompanyId(orgIdString, toAttach);
  if (foreign) return alreadyOwnedRefusal(foreign);

  try {
    await Acc_Organization.updateOne(
      { _id: organization._id },
      {
        $addToSet: {
          tallyCompanyIds: {
            $each: toAttach.map((id) => new mongoose.Types.ObjectId(id)),
          },
        },
      },
    );
  } catch (err) {
    if (err && err.code === 11000) {
      // The race: another organisation claimed one of these between our check
      // and our write. The index refused the WHOLE update, so nothing was
      // attached — the caller sees the same refusal it would have seen had it
      // arrived a moment later, and the outcome is the same either way.
      const raced = await findForeignOwnedCompanyId(orgIdString, toAttach);
      return alreadyOwnedRefusal(raced || companyIdFromDuplicateKeyError(err));
    }
    throw err;
  }

  return { ok: true, attached: toAttach, alreadyAttached };
}

/** Best-effort read of the offending value out of an E11000. */
function companyIdFromDuplicateKeyError(err) {
  const value = err?.keyValue?.tallyCompanyIds;
  if (value === undefined || value === null) return null;
  const asString = String(value);
  return OBJECT_ID_RE.test(asString) ? asString : null;
}

module.exports = {
  OWNERSHIP_INDEX_NAME,
  OWNERSHIP_INDEX_SPEC,
  OWNERSHIP_INDEX_OPTIONS,
  COMPANY_OWNERSHIP_CODES,
  normaliseCompanyIds,
  attachCompaniesToOrganization,
  findForeignOwnedCompanyId,
  findOwnershipConflicts,
};
