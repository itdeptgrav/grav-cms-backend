// services/companyContext/canonicalCompany.service.js
//
// THE GRAV CLOTHING LEGAL PROFILE — THE ONE COMPANY INTERNAL WORK HAPPENS IN.
//
// GAC-AR1 (25 Sep 2026). GRAV is one organisation
// (docs/decisions/single-organisation-access-control.md). Internal
// applications no longer ask the person which company they are in, and no
// longer require an `SpCompanyMembership` row: once an application has
// authorised the person (services/access/appAccess.service.js), the company
// every retained `companyId` field refers to is resolved HERE, server-side,
// from the `Acc_Company` row flagged `isPrimary` ("set on the GRAV Clothing
// record itself", Acc_MasterModels.js).
//
// It is a legal/partition reference, not authority. A browser-supplied company
// id can only ever NAME this company; naming any other one is refused.
//
// Outcomes:
//   · exactly one primary row     → that company
//   · no primary row              → null (the caller keeps its legacy path;
//                                    in-memory test databases have none)
//   · more than one primary row   → ambiguous: refused as a configuration fault
//   · lookup failure              → thrown; callers answer 503, never "any row"
"use strict";

const CANONICAL_SOURCE = "CANONICAL_GRAV_ORGANISATION";

class CanonicalCompanyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const companyModel = () => require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;

/**
 * @returns {Promise<{ _id, companyName } | null>}
 * @throws CanonicalCompanyError(CANONICAL_COMPANY_AMBIGUOUS) for two primaries;
 *         the raw driver error on an outage (callers map it).
 */
async function getCanonicalCompany() {
  const rows = await companyModel().find({ isPrimary: true }).select("_id companyName").limit(2).lean();
  if (rows.length > 1) {
    throw new CanonicalCompanyError(
      "CANONICAL_COMPANY_AMBIGUOUS",
      "More than one company is marked as the GRAV Clothing primary profile.",
    );
  }
  return rows[0] || null;
}

module.exports = { getCanonicalCompany, CanonicalCompanyError, CANONICAL_SOURCE };
