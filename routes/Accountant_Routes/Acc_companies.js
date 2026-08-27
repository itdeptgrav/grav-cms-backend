// routes/Accountant_Routes/Acc_companies.js
// =============================================================================
// TALLY COMPANIES — CRUD + group seeding
// =============================================================================

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const creditTerms = require("../../services/creditTerms.service");
const {
  Acc_Company,
  Acc_Group,
  ACC_DEFAULT_GROUPS,
} = require("../../models/Accountant_model/Acc_MasterModels");

// `/:id/default-credit-days` self-protects with `accountantAuth` +
// `creditTerms.canEditTerms` below — the SAME permission the party-level
// credit-terms editor and C0-F's backfill apply already require, not
// owner-only. It is excluded from the owner-only gate rather than folded
// into it, because the rest of this router (company CRUD, group reseeding)
// is deliberately more restrictive than this one field.
router.use((req, res, next) => {
  if (req.method === "GET") return next();
  if (req.path.endsWith("/default-credit-days")) return next();
  const isOwner =
    req.user?.role === "owner" || req.user?.isLegacy || req.user?.isDev;
  if (!isOwner) {
    return res.status(403).json({
      success: false,
      message: "Only the owner can add or manage companies.",
    });
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper — seed Tally's 28 reserved groups for a brand-new company
// ─────────────────────────────────────────────────────────────────────────────
async function seedDefaultGroups(companyId, createdBy) {
  // Two-pass insert: first pass creates all primary groups (parent=null),
  // second pass creates the children referencing the parent ObjectIds.
  const byName = new Map();

  // Pass 1: primaries
  for (const g of ACC_DEFAULT_GROUPS.filter((x) => !x.parent)) {
    const doc = await Acc_Group.create({
      companyId,
      name: g.name,
      parent: null,
      parentName: null,
      isPrimary: true,
      isReserved: g.isReserved || false,
      nature: g.nature,
      level: 1,
      fullPath: g.name,
      createdBy,
    });
    byName.set(g.name, doc);
  }

  // Pass 2: children
  for (const g of ACC_DEFAULT_GROUPS.filter((x) => x.parent)) {
    const parent = byName.get(g.parent);
    if (!parent) continue;
    const doc = await Acc_Group.create({
      companyId,
      name: g.name,
      parent: parent._id,
      parentName: parent.name,
      isPrimary: false,
      isReserved: g.isReserved || false,
      nature: g.nature,
      level: 2,
      fullPath: `${parent.name} > ${g.name}`,
      createdBy,
    });
    byName.set(g.name, doc);
  }

  return byName.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/tally/companies
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const companies = await Acc_Company.find({ isActive: true })
      .sort({ isPrimary: -1, createdAt: -1 })
      .lean();

    // Quick stats per company
    const withStats = await Promise.all(
      companies.map(async (c) => {
        const groupCount = await Acc_Group.countDocuments({ companyId: c._id });
        return { ...c, stats: { groupCount } };
      }),
    );

    res.json({ success: true, companies: withStats, count: withStats.length });
  } catch (err) {
    console.error("GET tally companies:", err);
    res
      .status(500)
      .json({ success: false, message: "Error fetching companies" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accountant/tally/companies — create a new company + seed groups
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      companyName,
      companyCode,
      gstin,
      pan,
      cin,
      tan,
      address,
      contact,
      booksFromDate,
      financialYearStart,
      isPrimary,
      isImportedFromTally,
      tallyCompanyGuid,
    } = req.body;

    if (!companyName)
      return res
        .status(400)
        .json({ success: false, message: "companyName is required" });
    if (!booksFromDate)
      return res
        .status(400)
        .json({ success: false, message: "booksFromDate is required" });

    // If marking primary, unset any existing primary
    if (isPrimary) {
      await Acc_Company.updateMany({ isPrimary: true }, { isPrimary: false });
    }

    // Compute current FY string
    const today = new Date();
    const fy =
      today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    const fyString = `${fy}-${(fy + 1).toString().slice(2)}`;

    const company = await Acc_Company.create({
      companyName,
      companyCode,
      gstin,
      pan,
      cin,
      tan,
      address,
      contact,
      booksFromDate: new Date(booksFromDate),
      financialYearStart: financialYearStart
        ? new Date(financialYearStart)
        : new Date(fy, 3, 1),
      currentFinancialYear: fyString,
      isPrimary: !!isPrimary,
      isImportedFromTally: !!isImportedFromTally,
      tallyCompanyGuid,
      createdBy: req.user?.id,
    });

    // Seed the 28 default groups
    const seeded = await seedDefaultGroups(company._id, req.user?.id);

    res.status(201).json({
      success: true,
      message: "Company created and default chart-of-accounts groups seeded.",
      company,
      seededGroups: seeded,
    });
  } catch (err) {
    console.error("POST tally company:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Error creating company",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/tally/companies/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const company = await Acc_Company.findById(req.params.id).lean();
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });
    res.json({ success: true, company });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/accountant/tally/companies/:id
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const updates = { ...req.body };
    delete updates._id;
    delete updates.createdAt;

    if (updates.isPrimary) {
      await Acc_Company.updateMany(
        { _id: { $ne: req.params.id }, isPrimary: true },
        { isPrimary: false },
      );
    }

    // The `address` sub-document is partial when it comes from the Settings
    // "Company GST" section (it only manages city/state/stateCode/pincode and
    // leaves line1/line2 alone). A raw findByIdAndUpdate would REPLACE the
    // whole sub-doc and wipe the other address fields, so deep-merge it onto
    // the existing record. Also auto-derive stateCode from the GSTIN when the
    // accountant left it blank, so intra/inter-state tax always resolves.
    //
    // Same problem with `contact`: the Organization tab in Settings sends
    // `{ contact: { phone, email, website } }` and another caller might send
    // `{ contact: { phone: "..." } }` alone. Without merging, the partial
    // write would clobber the unspecified fields. Deep-merge contact too.
    if (
      (updates.address && typeof updates.address === "object") ||
      (updates.contact && typeof updates.contact === "object")
    ) {
      const existing = await Acc_Company.findById(req.params.id)
        .select("address contact gstin")
        .lean();

      if (updates.address && typeof updates.address === "object") {
        const prevAddr = (existing && existing.address) || {};
        const mergedAddr = { ...prevAddr, ...updates.address };

        const gstinForDerive =
          updates.gstin != null ? updates.gstin : existing && existing.gstin;
        const resolved = gstState.resolveState({
          gstin: gstinForDerive,
          state: mergedAddr.state,
          stateCode: mergedAddr.stateCode,
        });
        if (!mergedAddr.stateCode && resolved.stateCode)
          mergedAddr.stateCode = resolved.stateCode;
        if (!mergedAddr.state && resolved.state)
          mergedAddr.state = resolved.state;

        updates.address = mergedAddr;
      }

      if (updates.contact && typeof updates.contact === "object") {
        const prevContact = (existing && existing.contact) || {};
        updates.contact = { ...prevContact, ...updates.contact };
      }
    }

    const company = await Acc_Company.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true },
    );
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });
    res.json({ success: true, company });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/accountant/tally/companies/:id (soft delete)
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const company = await Acc_Company.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true },
    );
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });
    res.json({ success: true, message: "Company deactivated" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accountant/tally/companies/:id/reseed-groups
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/reseed-groups", async (req, res) => {
  try {
    const company = await Acc_Company.findById(req.params.id);
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });

    const existing = await Acc_Group.countDocuments({
      companyId: company._id,
      isReserved: true,
    });
    if (existing > 0 && !req.body.force) {
      return res.status(400).json({
        success: false,
        message: `${existing} reserved groups already exist. Pass force=true to reseed.`,
      });
    }

    if (req.body.force) {
      await Acc_Group.deleteMany({ companyId: company._id, isReserved: true });
    }

    const seeded = await seedDefaultGroups(company._id, req.user?.id);
    res.json({
      success: true,
      message: `Seeded ${seeded} default groups`,
      seededGroups: seeded,
    });
  } catch (err) {
    console.error("Reseed groups:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/accountant/tally/companies/:id/default-credit-days
//
// The ONLY writer of `Acc_Company.defaultCreditDays` — a dedicated, narrowly
// scoped endpoint rather than a field smuggled through the broad `PUT /:id`
// above, for the same reason the party-level credit-terms editor
// (Acc_parties.js `PATCH /:ledgerId/credit-terms`) is its own route and not
// a field on a general ledger-update endpoint: a number that will later date
// real obligations deserves its own validated, whitelisted, audited path.
//
//   - Validation reuses `creditTerms.parseCreditDays` — the exact same rule
//     C0-B's party-level editor enforces: "", null, undefined and 0 all mean
//     "cleared" (stored as `null`, never as 0 — `defaultCreditDays` has no
//     schema default to fall back to, so `null` is the only spelling of
//     "unset"); 1..365 stores that number; anything else (negative,
//     fractional, >365, boolean, object, array, non-numeric string) is
//     REJECTED, not coerced.
//   - Whitelist-only body: `defaultCreditDays` is the only accepted key. No
//     `req.body` spreading anywhere in this handler.
//   - `creditTerms.canEditTerms` gates this write — see the router-level
//     comment above for why this route is carved out of the owner-only gate.
//   - Provenance (`defaultCreditDaysUpdatedAt/By/ByName`) is written from the
//     authenticated user and the clock, never trusted from the body.
router.patch("/:id/default-credit-days", accountantAuth, async (req, res) => {
  try {
    if (!creditTerms.canEditTerms(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid company id." });
    }

    const body = req.body || {};
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Expected an object body.", code: "INVALID_BODY" });
    }
    const unknown = Object.keys(body).filter((k) => k !== "defaultCreditDays");
    if (unknown.length > 0) {
      return res.status(400).json({
        error: `This endpoint only updates defaultCreditDays. Refused: ${unknown.join(", ")}.`,
        code: "UNSUPPORTED_FIELD",
      });
    }
    if (!Object.prototype.hasOwnProperty.call(body, "defaultCreditDays")) {
      return res.status(400).json({ error: "defaultCreditDays required.", code: "NOTHING_TO_UPDATE" });
    }

    let days;
    try {
      days = creditTerms.parseCreditDays(body.defaultCreditDays);
    } catch (e) {
      if (e instanceof creditTerms.CreditTermsError) {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      throw e;
    }

    // Scoped by `_id` — for `Acc_Company` itself, the company IS the tenant
    // boundary, so matching `:id` exactly is the whole of "scope by company
    // id" here (there is no separate parent-company field to also check, the
    // way a ledger checks `{ _id, companyId }` together).
    const company = await Acc_Company.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          defaultCreditDays: days, // null when cleared — never 0, there is no schema default to fall back to
          defaultCreditDaysUpdatedAt: new Date(),
          defaultCreditDaysUpdatedBy: req.user?.id || null,
          defaultCreditDaysUpdatedByName: req.user?.name || req.user?.email || null,
        },
      },
      {
        new: true,
        runValidators: true,
        // Belt and braces: only these keys can reach the response, whatever
        // this handler's `$set` might grow to include later.
        fields:
          "_id companyName defaultCreditDays defaultCreditDaysUpdatedAt defaultCreditDaysUpdatedByName",
      },
    ).lean();

    if (!company) {
      return res.status(404).json({ error: "Company not found." });
    }

    res.json({
      ok: true,
      company: {
        _id: company._id,
        companyName: company.companyName,
        defaultCreditDays: company.defaultCreditDays ?? null,
        defaultCreditDaysSet: creditTerms.isTermSet(company.defaultCreditDays),
        defaultCreditDaysUpdatedAt: company.defaultCreditDaysUpdatedAt || null,
        defaultCreditDaysUpdatedByName: company.defaultCreditDaysUpdatedByName || null,
      },
    });
  } catch (e) {
    console.error("[companies/default-credit-days]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
