// services/crmGarmentProfile.js
//
// Server-side reference checks for the Garment Sales Profile's commercial
// party fields (spec §7.2A / §11: "Default PO issuer, bill-to,
// importer/consignee, agent, nominated laboratory, and nominated supplier
// must reference valid active Accounts"). Schema-level `ref` only gives you
// the right TYPE at cast time — it does not confirm the id actually exists or
// is active, so this runs as an explicit async check before save, mirroring
// how services/crmHierarchy.js guards parent/child cycles.

"use strict";

class GarmentProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = "GarmentProfileError";
    this.status = 400;
  }
}

const SINGLE_REF_FIELDS = [
  ["defaultPoIssuerAccountId", "Default PO issuer"],
  ["defaultBillToAccountId", "Default bill-to party"],
  ["defaultImporterAccountId", "Default importer/consignee"],
  ["defaultAgentAccountId", "Default agent"],
];

const LIST_REF_FIELDS = [
  ["nominatedLaboratoryAccountIds", "Nominated laboratory"],
  ["nominatedSupplierAccountIds", "Nominated supplier"],
];

/**
 * Verify every Account reference on a (possibly partial) garmentSalesProfile
 * payload points at an existing, active account.
 * @throws {GarmentProfileError}
 */
async function assertValidGarmentProfileRefs(Account, profile) {
  if (!profile || typeof profile !== "object") return;

  const ids = new Set();
  for (const [field] of SINGLE_REF_FIELDS) {
    if (profile[field]) ids.add(String(profile[field]));
  }
  for (const [field] of LIST_REF_FIELDS) {
    if (Array.isArray(profile[field])) {
      for (const id of profile[field]) if (id) ids.add(String(id));
    }
  }
  if (ids.size === 0) return;

  const found = await Account.find({ _id: { $in: [...ids] } })
    .select("_id isActive")
    .lean();
  const byId = new Map(found.map((a) => [String(a._id), a]));

  const missingOrInactive = [];
  for (const [field, label] of [...SINGLE_REF_FIELDS, ...LIST_REF_FIELDS]) {
    const value = profile[field];
    const check = (id) => {
      const acct = byId.get(String(id));
      if (!acct) missingOrInactive.push(`${label} (${id}) does not exist.`);
      else if (acct.isActive === false) missingOrInactive.push(`${label} (${id}) is archived and cannot be used.`);
    };
    if (Array.isArray(value)) value.filter(Boolean).forEach(check);
    else if (value) check(value);
  }

  if (missingOrInactive.length) {
    throw new GarmentProfileError(missingOrInactive.join(" "));
  }
}

module.exports = { GarmentProfileError, assertValidGarmentProfileRefs };
