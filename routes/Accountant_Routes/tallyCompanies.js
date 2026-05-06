// routes/Accountant_Routes/tallyCompanies.js
// =============================================================================
// TALLY COMPANIES — CRUD + group seeding
// =============================================================================

const express = require("express");
const router = express.Router();
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const {
  TallyCompany,
  TallyGroup,
  TALLY_DEFAULT_GROUPS,
} = require("../../models/Accountant_model/TallyMasterModels");

router.use(accountantAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Helper — seed Tally's 28 reserved groups for a brand-new company
// ─────────────────────────────────────────────────────────────────────────────
async function seedDefaultGroups(companyId, createdBy) {
  // Two-pass insert: first pass creates all primary groups (parent=null),
  // second pass creates the children referencing the parent ObjectIds.
  const byName = new Map();

  // Pass 1: primaries
  for (const g of TALLY_DEFAULT_GROUPS.filter(x => !x.parent)) {
    const doc = await TallyGroup.create({
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
  for (const g of TALLY_DEFAULT_GROUPS.filter(x => x.parent)) {
    const parent = byName.get(g.parent);
    if (!parent) continue;
    const doc = await TallyGroup.create({
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
    const companies = await TallyCompany.find({ isActive: true })
      .sort({ isPrimary: -1, createdAt: -1 })
      .lean();

    // Quick stats per company
    const withStats = await Promise.all(companies.map(async (c) => {
      const groupCount = await TallyGroup.countDocuments({ companyId: c._id });
      return { ...c, stats: { groupCount } };
    }));

    res.json({ success: true, companies: withStats, count: withStats.length });
  } catch (err) {
    console.error("GET tally companies:", err);
    res.status(500).json({ success: false, message: "Error fetching companies" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accountant/tally/companies — create a new company + seed groups
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      companyName, companyCode, gstin, pan, cin, tan,
      address, contact, booksFromDate, financialYearStart,
      isPrimary, isImportedFromTally, tallyCompanyGuid,
    } = req.body;

    if (!companyName) return res.status(400).json({ success: false, message: "companyName is required" });
    if (!booksFromDate) return res.status(400).json({ success: false, message: "booksFromDate is required" });

    // If marking primary, unset any existing primary
    if (isPrimary) {
      await TallyCompany.updateMany({ isPrimary: true }, { isPrimary: false });
    }

    // Compute current FY string
    const today = new Date();
    const fy = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    const fyString = `${fy}-${(fy + 1).toString().slice(2)}`;

    const company = await TallyCompany.create({
      companyName, companyCode, gstin, pan, cin, tan,
      address, contact,
      booksFromDate: new Date(booksFromDate),
      financialYearStart: financialYearStart ? new Date(financialYearStart) : new Date(fy, 3, 1),
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
    res.status(500).json({ success: false, message: err.message || "Error creating company" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/tally/companies/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const company = await TallyCompany.findById(req.params.id).lean();
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });
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
      await TallyCompany.updateMany({ _id: { $ne: req.params.id }, isPrimary: true }, { isPrimary: false });
    }

    const company = await TallyCompany.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });
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
    const company = await TallyCompany.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });
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
    const company = await TallyCompany.findById(req.params.id);
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const existing = await TallyGroup.countDocuments({ companyId: company._id, isReserved: true });
    if (existing > 0 && !req.body.force) {
      return res.status(400).json({
        success: false,
        message: `${existing} reserved groups already exist. Pass force=true to reseed.`,
      });
    }

    if (req.body.force) {
      await TallyGroup.deleteMany({ companyId: company._id, isReserved: true });
    }

    const seeded = await seedDefaultGroups(company._id, req.user?.id);
    res.json({ success: true, message: `Seeded ${seeded} default groups`, seededGroups: seeded });
  } catch (err) {
    console.error("Reseed groups:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
