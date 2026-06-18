// routes/Accountant_Routes/Acc_gstr2b.js
// =============================================================================
// GSTR-2B IMPORT + RECONCILIATION
// -----------------------------------------------------------------------------
// Free alternative to GSP API integration. The accountant downloads the
// GSTR-2B JSON from the GST portal monthly (already part of their workflow)
// and uploads it here. We parse, persist, and reconcile against the company's
// purchase vouchers to produce supplier-wise matched / mismatched / missing
// buckets — same output a paid GSP-API reconciliation would produce.
//
// ENDPOINTS:
//   POST  /upload           → upload + parse + persist a 2B JSON file
//   GET   /periods          → list all imported 2B periods for this company
//   GET   /:period          → full 2B records for a period (paginated)
//   GET   /:period/recon    → reconciliation buckets vs books
//   GET   /:period/supplier-summary → supplier-wise rollup with filing status
//   DELETE /:period          → remove an imported 2B period
//
// All routes are mounted at /api/accountant/gstr2b/* (see server.js).
// =============================================================================

const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const { Acc_GSTR2B } = require("../../models/Accountant_model/Acc_GSTR2B");

// Books side — purchase vouchers + expenses
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Ledger,
  Acc_Company,
} = require("../../models/Accountant_model/Acc_MasterModels");
// Acc_Expense is in the operational models; not all installs have it
let Acc_Expense = null;
try {
  ({
    Acc_Expense,
  } = require("../../models/Accountant_model/Acc_OperationalModels"));
} catch {
  /* expenses model not present — purchase voucher path will still work */
}

const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const router = express.Router();

// Multer for file upload — memory storage, 10MB cap (GSTR-2B for a busy month
// can be 2-3MB; 10MB leaves comfortable headroom).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME INDEX MIGRATION
// ─────────────────────────────────────────────────────────────────────────────
// When 2A support was added, the unique index on the Acc_GSTR2B collection
// changed from `{companyId, returnPeriod}` to `{companyId, returnPeriod,
// returnType}`. Mongoose's schema change doesn't drop the old index — it just
// queues the new one. If the old 2-field index is still present, every
// upload (even for a different returnType than the existing doc) will fail
// with E11000.
//
// This runs once on the first request, drops any stale `companyId_1_returnPeriod_1`
// index, and lets Mongoose's auto-indexing create the new 3-field one.
// Subsequent requests skip this work (memoized in the module).
//
// Also fixes any legacy documents that don't have a `returnType` field set
// (created before the migration) by defaulting them to "GSTR2B".
let __indexMigrationDone = false;
async function ensureIndexMigration() {
  if (__indexMigrationDone) return;
  __indexMigrationDone = true; // optimistic — if it fails we'll see in logs
  try {
    const coll = Acc_GSTR2B.collection;
    const existing = await coll.indexes();
    const stale = existing.find(
      (ix) =>
        ix.unique &&
        Object.keys(ix.key).length === 2 &&
        ix.key.companyId === 1 &&
        ix.key.returnPeriod === 1,
    );
    if (stale) {
      console.log("[gstr2b] Dropping stale index", stale.name);
      await coll.dropIndex(stale.name);
    }
    // Backfill returnType on legacy documents that don't have it.
    const r = await Acc_GSTR2B.updateMany(
      { returnType: { $exists: false } },
      { $set: { returnType: "GSTR2B" } },
    );
    if (r.modifiedCount > 0) {
      console.log(
        `[gstr2b] Backfilled returnType="GSTR2B" on ${r.modifiedCount} legacy docs`,
      );
    }
    // Let Mongoose ensure the new 3-field index exists.
    await Acc_GSTR2B.syncIndexes();
  } catch (e) {
    // Don't crash the route on migration failure — just log and continue.
    // The next request will retry because we set the flag before running;
    // reset it so retry is possible.
    console.error("[gstr2b] Index migration failed:", e.message);
    __indexMigrationDone = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Normalize an invoice number for matching: uppercase, strip whitespace,
// strip leading zeros, strip common separators that vary between systems
// (some accountants type "INV/001/26-27", suppliers file "INV-001-26-27").
function normInvNum(s) {
  if (!s) return "";
  return String(s)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[\/\-\_\.]/g, "")
    .replace(/^0+/, "");
}

// Parse GSTN's "dt" date format. GSTR-2B uses "DD-MM-YYYY" (e.g. "25-04-2026").
function parseGstnDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const m = String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) {
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  }
  // Fallback — let JS try
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Parse GSTN's "rtnprd" — MMYYYY string. e.g. "042026" → { month: 4, year: 2026 }.
function parseReturnPeriod(s) {
  if (!s || typeof s !== "string" || s.length !== 6) return null;
  const month = Number(s.slice(0, 2));
  const year = Number(s.slice(2));
  if (!month || !year || month < 1 || month > 12) return null;
  return { month, year };
}

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-2B JSON PARSER
// ─────────────────────────────────────────────────────────────────────────────
// Flattens the nested GSTN JSON into our flat `records[]` array. Handles
// minor shape variations across GSTN portal versions and is tolerant of
// missing optional fields (returns warnings rather than failing the import).
function parseGstr2bJson(raw) {
  const warnings = [];

  // GSTN sometimes wraps the actual payload inside { data: {...} }, sometimes
  // it's at the top level. Handle both.
  const root = raw?.data || raw;
  if (!root || typeof root !== "object") {
    throw new Error("Invalid GSTR-2B JSON: no `data` object found");
  }

  const taxpayerGSTIN = (root.gstin || raw.gstin || "").toUpperCase().trim();
  const returnPeriod = (root.rtnprd || raw.rtnprd || "").trim();
  if (
    !taxpayerGSTIN ||
    !/^[0-9]{2}[A-Z0-9]{10}[A-Z0-9]{3}$/.test(taxpayerGSTIN)
  ) {
    throw new Error(
      "Invalid GSTR-2B JSON: missing or malformed taxpayer GSTIN",
    );
  }
  const periodParts = parseReturnPeriod(returnPeriod);
  if (!periodParts) {
    throw new Error(
      `Invalid GSTR-2B JSON: return period "${returnPeriod}" is not in MMYYYY format`,
    );
  }

  const generationDate = parseGstnDate(root.gendt || raw.gendt);

  // ITC summary block. The real GSTN structure is hierarchical:
  //   itcsumm.itcavl.revsup.{b2b, cdnr, ...}.{cgst, sgst, igst, cess, txval}
  //   itcsumm.itcavl.othersup.{...}
  //   itcsumm.itcavl.nonrevsup.{...}
  // We aggregate across the three top-level groups (revsup + othersup +
  // nonrevsup) to produce a single "ITC available" tally. There's no
  // explicit "ITC unavailable" sub-tree in the modern format — the per-record
  // `itcavl: "Y"/"N"` flag drives that. We synthesise it from the records.
  const summaryTotals = {
    itcAvailable: { cgst: 0, sgst: 0, igst: 0, cess: 0 },
    itcUnavailable: { cgst: 0, sgst: 0, igst: 0, cess: 0 },
  };
  const summBlocks = root.itcsumm || raw.itcsumm || null;
  if (summBlocks) {
    const itcavl = summBlocks.itcavl || summBlocks.itcAvailable || {};
    const accumulate = (target, src) => {
      target.cgst += Number(src.cgst ?? src.camt ?? 0);
      target.sgst += Number(src.sgst ?? src.samt ?? 0);
      target.igst += Number(src.igst ?? src.iamt ?? 0);
      target.cess += Number(src.cess ?? src.csamt ?? 0);
    };
    // Modern hierarchical structure
    if (itcavl.revsup || itcavl.othersup || itcavl.nonrevsup) {
      for (const grp of ["revsup", "othersup", "nonrevsup"]) {
        if (itcavl[grp]) accumulate(summaryTotals.itcAvailable, itcavl[grp]);
      }
    } else {
      // Legacy flat structure
      accumulate(summaryTotals.itcAvailable, itcavl);
    }
    // Legacy ITC-unavailable block (if present)
    const itcunavl = summBlocks.itcunavl || summBlocks.itcUnavailable || {};
    if (itcunavl.revsup || itcunavl.othersup || itcunavl.nonrevsup) {
      for (const grp of ["revsup", "othersup", "nonrevsup"]) {
        if (itcunavl[grp])
          accumulate(summaryTotals.itcUnavailable, itcunavl[grp]);
      }
    } else if (Object.keys(itcunavl).length) {
      accumulate(summaryTotals.itcUnavailable, itcunavl);
    }
  }

  const docdata = root.docdata || raw.docdata || {};
  const records = [];

  // ── B2B + B2BA: invoices grouped by supplier ──
  for (const section of ["b2b", "b2ba"]) {
    const arr = docdata[section] || [];
    for (const supplier of arr) {
      const supplierGSTIN = (supplier.ctin || "").toUpperCase().trim();
      const supplierName = supplier.trdnm || supplier.name || "";
      const supplierFilingStatus = supplier.supfildt
        ? "Filed"
        : supplier.flprdr1 || "";
      const supplierFilingDate = parseGstnDate(supplier.supfildt);
      const supplierReturnPeriod = supplier.supprd || "";
      const invs = supplier.inv || [];
      for (const inv of invs) {
        // Read tax amounts. Modern GSTN GSTR-2B uses the long names
        // (`cgst`, `sgst`, `igst`, `cess`); legacy GSTR-1-style downloads used
        // the abbreviated forms (`camt`, `samt`, `iamt`, `csamt`). Try long
        // names first since that's what the current portal returns.
        const taxableValue = Number(inv.txval ?? inv.val ?? 0);
        const cgst = Number(inv.cgst ?? inv.camt ?? 0);
        const sgst = Number(inv.sgst ?? inv.samt ?? 0);
        const igst = Number(inv.igst ?? inv.iamt ?? 0);
        const cess = Number(inv.cess ?? inv.csamt ?? 0);

        records.push({
          section,
          supplierGSTIN,
          supplierName,
          docNumber: String(inv.inum || "").trim(),
          docDate: parseGstnDate(inv.dt),
          // GSTN ships single-letter type codes:
          //   R  = Regular
          //   SEWP = SEZ supplies with payment of tax
          //   SEWOP = SEZ supplies without payment of tax
          //   DE = Deemed Export
          //   CBW = Customs Bonded Warehouse
          docType: inv.typ || "R",
          taxableValue,
          cgst,
          sgst,
          igst,
          cess,
          invoiceValue: Number(
            inv.val ?? taxableValue + cgst + sgst + igst + cess,
          ),
          itcAvailable: (inv.itcavl || "Y").toUpperCase() === "Y",
          itcUnavailReason: inv.rsn || "",
          supplierFilingStatus,
          supplierFilingDate,
          supplierReturnPeriod,
          placeOfSupply: inv.pos || "",
          reverseCharge: (inv.rev || "N").toUpperCase() === "Y",
          // IMS status — current portal uses `imsStatus`; older may use `imsaction`
          imsAction: inv.imsStatus || inv.imsaction || inv.imsAction || "",
          originalDocNumber:
            section === "b2ba" ? String(inv.oinum || "").trim() : "",
          originalDocDate: section === "b2ba" ? parseGstnDate(inv.oidt) : null,
          raw: inv,
        });
      }
    }
  }

  // ── CDNR + CDNRA: credit/debit notes ──
  for (const section of ["cdnr", "cdnra"]) {
    const arr = docdata[section] || [];
    for (const supplier of arr) {
      const supplierGSTIN = (supplier.ctin || "").toUpperCase().trim();
      const supplierName = supplier.trdnm || supplier.name || "";
      const supplierFilingDate = parseGstnDate(supplier.supfildt);
      const supplierReturnPeriod = supplier.supprd || "";
      const notes = supplier.nt || supplier.cdnr || [];
      for (const nt of notes) {
        // Note type: typ="C" credit / "D" debit. Some files also expose
        // it on the supplier-level via `nttyp` (seen in cpsumm sections).
        const noteType = (nt.typ || nt.ntty || nt.nttyp || "C").toUpperCase();
        const taxableValue = Number(nt.txval ?? nt.val ?? 0);
        // Credit notes reduce ITC, so amounts are stored signed-negative.
        const sign = noteType === "C" ? -1 : 1;
        records.push({
          section,
          supplierGSTIN,
          supplierName,
          docNumber: String(nt.ntnum || nt.inum || "").trim(),
          docDate: parseGstnDate(nt.dt),
          docType: nt.suptyp || "R",
          noteType: noteType === "C" ? "Credit" : "Debit",
          taxableValue: sign * taxableValue,
          cgst: sign * Number(nt.cgst ?? nt.camt ?? 0),
          sgst: sign * Number(nt.sgst ?? nt.samt ?? 0),
          igst: sign * Number(nt.igst ?? nt.iamt ?? 0),
          cess: sign * Number(nt.cess ?? nt.csamt ?? 0),
          invoiceValue: sign * Number(nt.val ?? 0),
          itcAvailable: (nt.itcavl || "Y").toUpperCase() === "Y",
          itcUnavailReason: nt.rsn || "",
          supplierFilingDate,
          supplierReturnPeriod,
          placeOfSupply: nt.pos || "",
          reverseCharge: (nt.rev || "N").toUpperCase() === "Y",
          imsAction: nt.imsStatus || nt.imsaction || nt.imsAction || "",
          originalDocNumber:
            section === "cdnra" ? String(nt.ontnum || "").trim() : "",
          originalDocDate: section === "cdnra" ? parseGstnDate(nt.ontdt) : null,
          raw: nt,
        });
      }
    }
  }

  // ── IMPG + IMPGSEZ: import of goods ──
  for (const section of ["impg", "impgsez"]) {
    const arr = docdata[section] || [];
    for (const imp of arr) {
      records.push({
        section,
        supplierGSTIN: "", // imports don't have supplier GSTIN
        supplierName: imp.txprd || imp.portcd || "Import",
        docNumber: String(imp.boenum || "").trim(),
        docDate: parseGstnDate(imp.boedt),
        docType: "Bill of Entry",
        taxableValue: Number(imp.txval ?? 0),
        cgst: 0,
        sgst: 0,
        igst: Number(imp.igst ?? imp.iamt ?? 0),
        cess: Number(imp.cess ?? imp.csamt ?? 0),
        invoiceValue: Number(imp.val ?? 0),
        itcAvailable: true,
        placeOfSupply: imp.portcd || "",
        imsAction: imp.imsStatus || imp.imsaction || imp.imsAction || "",
        raw: imp,
      });
    }
  }

  // ── ISD: input service distributor ──
  for (const section of ["isd", "isda"]) {
    const arr = docdata[section] || [];
    for (const isd of arr) {
      const supplierGSTIN = (isd.ctin || isd.isdgstin || "")
        .toUpperCase()
        .trim();
      const supplierName = isd.trdnm || isd.name || "";
      const docs = isd.doclist || isd.nt || isd.docs || [];
      for (const d of docs) {
        records.push({
          section,
          supplierGSTIN,
          supplierName,
          docNumber: String(d.docnum || "").trim(),
          docDate: parseGstnDate(d.docdt),
          docType: d.doctyp || "ISD",
          taxableValue: 0,
          cgst: Number(d.cgst ?? d.camt ?? 0),
          sgst: Number(d.sgst ?? d.samt ?? 0),
          igst: Number(d.igst ?? d.iamt ?? 0),
          cess: Number(d.cess ?? d.csamt ?? 0),
          invoiceValue: 0,
          itcAvailable: (d.itcavl || "Y").toUpperCase() === "Y",
          imsAction: d.imsStatus || d.imsaction || d.imsAction || "",
          raw: d,
        });
      }
    }
  }

  if (records.length === 0) {
    warnings.push(
      "No records found in B2B/CDNR/IMPG/ISD sections. The file parsed but appears empty — verify the return period has supplier filings.",
    );
  }

  return {
    taxpayerGSTIN,
    returnPeriod,
    periodMonth: periodParts.month,
    periodYear: periodParts.year,
    generationDate,
    summaryTotals,
    records,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /upload — receive a GSTR-2B JSON file
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/upload",
  accountantAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      await ensureIndexMigration();
      const { companyId } = req.body;
      if (!companyId) {
        return res
          .status(400)
          .json({ success: false, message: "companyId is required" });
      }
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No file uploaded (field name 'file')",
        });
      }

      // Parse JSON
      let raw;
      try {
        raw = JSON.parse(req.file.buffer.toString("utf8"));
      } catch (e) {
        return res.status(400).json({
          success: false,
          message:
            "Could not parse uploaded file as JSON. Ensure you downloaded the GSTR-2A or GSTR-2B 'JSON' format (not Excel) from the GST portal.",
        });
      }

      // Run the parser
      let parsed;
      try {
        parsed = parseGstr2bJson(raw);
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }

      // Detect 2A vs 2B from the filename. GSTN names downloads as
      // `returns_R2A_<GSTIN>_<MMYYYY>.json` or `returns_R2B_<GSTIN>_<MMYYYY>.json`.
      // Caller can override via req.body.returnType. Default to 2B since that's
      // the canonical one for ITC claims.
      //
      // We could also detect from the JSON itself — 2B has a `chksum` at root
      // and `itcsumm` is a locked snapshot; 2A is dynamic and doesn't include
      // `chksum`. But the filename signal is reliable and explicit.
      const fname = (req.file.originalname || "").toUpperCase();
      let returnType = (req.body.returnType || "").toUpperCase();
      if (returnType !== "GSTR2A" && returnType !== "GSTR2B") {
        if (/R2A|GSTR-?2A|GSTR_?2A/.test(fname)) returnType = "GSTR2A";
        else returnType = "GSTR2B"; // default
      }

      // Sanity check: the GSTIN in the file must match the company we're importing into.
      const company = await Acc_Company.findById(companyId).lean();
      if (!company) {
        return res
          .status(404)
          .json({ success: false, message: "Company not found" });
      }
      if (
        company.gstin &&
        parsed.taxpayerGSTIN !== company.gstin.toUpperCase()
      ) {
        return res.status(400).json({
          success: false,
          message: `GSTIN mismatch. Uploaded file is for ${parsed.taxpayerGSTIN}, but the selected company's GSTIN is ${company.gstin}. Did you upload the wrong file?`,
        });
      }

      // Upsert — re-uploading the same (period, type) replaces the prior import.
      // A company can hold both a 2A and a 2B for the same period.
      // Legacy 2B docs may lack a `returnType` field; treat absent as GSTR2B.
      const existingTypeQuery =
        returnType === "GSTR2B"
          ? {
              $or: [
                { returnType: "GSTR2B" },
                { returnType: { $exists: false } },
              ],
            }
          : { returnType };
      const existing = await Acc_GSTR2B.findOne({
        companyId: new mongoose.Types.ObjectId(companyId),
        returnPeriod: parsed.returnPeriod,
        ...existingTypeQuery,
      });

      const payload = {
        companyId: new mongoose.Types.ObjectId(companyId),
        returnType,
        taxpayerGSTIN: parsed.taxpayerGSTIN,
        returnPeriod: parsed.returnPeriod,
        periodMonth: parsed.periodMonth,
        periodYear: parsed.periodYear,
        generationDate: parsed.generationDate,
        importedAt: new Date(),
        importedBy: req.accountant?.email || "",
        importedFilename: req.file.originalname || "",
        summaryTotals: parsed.summaryTotals,
        records: parsed.records,
        importWarnings: parsed.warnings,
      };

      let doc;
      if (existing) {
        Object.assign(existing, payload);
        // Re-uploading replaces the source data, so any cached reconciliation
        // result is now stale. Clear it so the next page open will recompute.
        existing.lastReconAt = undefined;
        existing.lastReconBy = undefined;
        existing.lastReconSummary = undefined;
        existing.lastReconBuckets = undefined;
        await existing.save();
        doc = existing;
      } else {
        doc = await Acc_GSTR2B.create(payload);
      }

      res.json({
        success: true,
        replaced: !!existing,
        summary: {
          period: parsed.returnPeriod,
          month: parsed.periodMonth,
          year: parsed.periodYear,
          returnType, // GSTR2A or GSTR2B
          recordCount: parsed.records.length,
          sectionCounts: parsed.records.reduce((acc, r) => {
            acc[r.section] = (acc[r.section] || 0) + 1;
            return acc;
          }, {}),
          totalITCAvailable:
            parsed.summaryTotals.itcAvailable.cgst +
            parsed.summaryTotals.itcAvailable.sgst +
            parsed.summaryTotals.itcAvailable.igst +
            parsed.summaryTotals.itcAvailable.cess,
          warnings: parsed.warnings,
        },
        gstr2b: {
          _id: doc._id,
          returnPeriod: doc.returnPeriod,
          returnType: doc.returnType,
        },
      });
    } catch (e) {
      console.error("[gstr2b/upload]", e);
      res.status(500).json({
        success: false,
        message: "Failed to import GSTR-2B: " + e.message,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /periods — list all imported 2B periods for this company
// ─────────────────────────────────────────────────────────────────────────────
router.get("/periods", accountantAuth, async (req, res) => {
  try {
    await ensureIndexMigration();
    const { companyId, returnType } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    // Filter by returnType if specified; otherwise return both 2A and 2B
    // (UI can filter client-side if it wants).
    const match = { companyId: new mongoose.Types.ObjectId(companyId) };
    if (returnType === "GSTR2A" || returnType === "GSTR2B")
      match.returnType = returnType;

    const periods = await Acc_GSTR2B.aggregate([
      { $match: match },
      {
        $project: {
          returnPeriod: 1,
          returnType: 1,
          periodMonth: 1,
          periodYear: 1,
          generationDate: 1,
          importedAt: 1,
          importedFilename: 1,
          recordCount: { $size: "$records" },
          totalITC: {
            $add: [
              "$summaryTotals.itcAvailable.cgst",
              "$summaryTotals.itcAvailable.sgst",
              "$summaryTotals.itcAvailable.igst",
              "$summaryTotals.itcAvailable.cess",
            ],
          },
          lastReconAt: 1,
          lastReconBy: 1,
          lastReconSummary: 1,
        },
      },
      // 2B before 2A within the same period (2B is canonical), then by date desc
      { $sort: { periodYear: -1, periodMonth: -1, returnType: 1 } },
    ]);

    res.json({ success: true, periods });
  } catch (e) {
    console.error("[gstr2b/periods]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /recon-range — multi-period reconciliation rollup for Excel export
// ─────────────────────────────────────────────────────────────────────────────
// Returns the combined reconciliation result for every imported 2B/2A whose
// period intersects the requested date range. Used by the frontend when the
// accountant selects a multi-month range (e.g. full FY) and clicks Export.
//
// Returns cached recon results only — if a period in the range hasn't been
// reconciled yet, it's listed in `missingPeriods` so the frontend can decide
// whether to prompt the user to run those recons first.
//
// Query params:
//   companyId    — required, the company being reported on
//   from         — required, YYYY-MM-DD (inclusive start of range)
//   to           — required, YYYY-MM-DD (inclusive end of range)
//   returnType   — optional, GSTR2B | GSTR2A | (omit for both, defaults to GSTR2B)
//
// Period-in-range logic: a 2B/2A doc is "in range" if any part of its
// calendar month overlaps the request range. This means a range starting
// April 5 still includes April's 2B (which is for April 1–30).
router.get("/recon-range", accountantAuth, async (req, res) => {
  try {
    await ensureIndexMigration();
    const { companyId, from, to, returnType } = req.query;
    if (!companyId || !from || !to) {
      return res.status(400).json({
        success: false,
        message: "companyId, from, and to are all required",
      });
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "from/to must be valid dates (YYYY-MM-DD)",
      });
    }
    if (fromDate > toDate) {
      return res
        .status(400)
        .json({ success: false, message: "from must be <= to" });
    }

    // Enumerate every (year, month) tuple between the two dates inclusive.
    // We work in calendar months because 2B/2A periods are monthly.
    const periodsInRange = [];
    let y = fromDate.getFullYear(),
      m = fromDate.getMonth() + 1; // 1-12
    const endY = toDate.getFullYear(),
      endM = toDate.getMonth() + 1;
    while (y < endY || (y === endY && m <= endM)) {
      periodsInRange.push({
        periodMonth: m,
        periodYear: y,
        returnPeriod: String(m).padStart(2, "0") + String(y), // "MMYYYY"
        label: new Date(y, m - 1).toLocaleString("en-IN", {
          month: "long",
          year: "numeric",
        }),
      });
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }

    // Query all matching docs in one shot — faster than N round trips.
    const docQuery = {
      companyId: new mongoose.Types.ObjectId(companyId),
      returnPeriod: { $in: periodsInRange.map((p) => p.returnPeriod) },
    };
    if (returnType === "GSTR2A") {
      docQuery.returnType = "GSTR2A";
    } else if (returnType === "GSTR2B") {
      // Legacy docs without returnType are implicitly GSTR2B — accept both.
      docQuery.$or = [
        { returnType: "GSTR2B" },
        { returnType: { $exists: false } },
      ];
    }
    // If returnType omitted, return both 2A and 2B docs in range.

    const docs = await Acc_GSTR2B.find(docQuery).lean();

    // Index docs by (period, type) for easy lookup
    const docKey = (p, t) => `${p}__${t || "GSTR2B"}`;
    const docMap = new Map();
    for (const d of docs)
      docMap.set(docKey(d.returnPeriod, d.returnType || "GSTR2B"), d);

    // Categorize: each requested period either has cached recon, has imported
    // 2B but no recon yet (needs to be run), or has no import at all.
    const ready = []; // {period, returnType, label, summary, buckets, lastReconAt, recordCount, tolerance}
    const missingRecon = []; // period imported but not yet reconciled
    const notImported = []; // period has no import at all

    for (const p of periodsInRange) {
      // Look up matching doc(s) — could be 2B, 2A, or both if returnType wasn't filtered
      const candidateTypes = returnType ? [returnType] : ["GSTR2B", "GSTR2A"];
      for (const t of candidateTypes) {
        const doc = docMap.get(docKey(p.returnPeriod, t));
        if (!doc) {
          // Only track "not imported" for 2B (canonical) unless 2A explicitly requested
          if (t === "GSTR2B" || returnType === "GSTR2A") {
            notImported.push({ ...p, returnType: t });
          }
          continue;
        }
        if (doc.lastReconAt && doc.lastReconBuckets) {
          ready.push({
            period: doc.returnPeriod,
            returnType: doc.returnType || "GSTR2B",
            label: p.label,
            recordCount: doc.records.length,
            lastReconAt: doc.lastReconAt,
            tolerance: doc.lastReconTolerance || { amount: 1, days: 3 },
            summary: doc.lastReconSummary,
            buckets: doc.lastReconBuckets,
          });
        } else {
          missingRecon.push({
            ...p,
            returnType: doc.returnType || "GSTR2B",
            _id: doc._id,
          });
        }
      }
    }

    // Aggregate summary across all ready periods so the frontend can show
    // single-number headlines for the range (e.g. "Per books across FY:
    // ₹X, Per portal: ₹Y, diff: ₹Z").
    const rangeSummary = {
      periodCount: ready.length,
      matched: { count: 0, totalTax: 0 },
      mismatched: { count: 0, totalTaxDiff: 0 },
      onlyIn2B: { count: 0, totalTax: 0, availableITC: 0 },
      onlyInBooks: { count: 0, totalTax: 0 },
      portalTotalTax: 0,
      booksTotalTax: 0,
    };
    for (const r of ready) {
      const s = r.summary || {};
      rangeSummary.matched.count += s.matched?.count || 0;
      rangeSummary.matched.totalTax += s.matched?.totalTax || 0;
      rangeSummary.mismatched.count += s.mismatched?.count || 0;
      rangeSummary.mismatched.totalTaxDiff += s.mismatched?.totalTaxDiff || 0;
      rangeSummary.onlyIn2B.count += s.onlyIn2B?.count || 0;
      rangeSummary.onlyIn2B.totalTax += s.onlyIn2B?.totalTax || 0;
      rangeSummary.onlyIn2B.availableITC += s.onlyIn2B?.availableITC || 0;
      rangeSummary.onlyInBooks.count += s.onlyInBooks?.count || 0;
      rangeSummary.onlyInBooks.totalTax += s.onlyInBooks?.totalTax || 0;
      rangeSummary.portalTotalTax += s.portalTotalTax || 0;
      rangeSummary.booksTotalTax += s.booksTotalTax || 0;
    }

    res.json({
      success: true,
      from,
      to,
      rangeLabel: `${fromDate.toLocaleString("en-IN", { month: "short", year: "numeric" })} – ${toDate.toLocaleString("en-IN", { month: "short", year: "numeric" })}`,
      requestedReturnType: returnType || "ANY",
      periodsRequested: periodsInRange.length,
      periodsReady: ready.length,
      missingRecon: missingRecon.map(({ _id, ...rest }) => rest),
      notImported,
      rangeSummary,
      periods: ready, // each with its own summary + buckets
    });
  } catch (e) {
    console.error("[gstr2b/recon-range]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// GET /:period — fetch records for a period (with optional pagination + filter)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:period", accountantAuth, async (req, res) => {
  try {
    const {
      companyId,
      section,
      page = 1,
      limit = 100,
      returnType = "GSTR2B",
    } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const doc = await Acc_GSTR2B.findOne({
      companyId: new mongoose.Types.ObjectId(companyId),
      returnPeriod: req.params.period,
      returnType,
    }).lean();
    if (!doc) {
      return res.status(404).json({
        success: false,
        message: `No ${returnType === "GSTR2A" ? "GSTR-2A" : "GSTR-2B"} imported for this period`,
      });
    }

    let records = doc.records;
    if (section) records = records.filter((r) => r.section === section);

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(1000, Math.max(1, Number(limit)));
    const start = (pageNum - 1) * limitNum;
    const paged = records.slice(start, start + limitNum);

    res.json({
      success: true,
      gstr2b: {
        _id: doc._id,
        returnPeriod: doc.returnPeriod,
        periodMonth: doc.periodMonth,
        periodYear: doc.periodYear,
        generationDate: doc.generationDate,
        importedAt: doc.importedAt,
        summaryTotals: doc.summaryTotals,
        totalRecords: doc.records.length,
        sectionCounts: doc.records.reduce((acc, r) => {
          acc[r.section] = (acc[r.section] || 0) + 1;
          return acc;
        }, {}),
        importWarnings: doc.importWarnings,
      },
      records: paged,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: records.length,
        totalPages: Math.ceil(records.length / limitNum),
      },
    });
  } catch (e) {
    console.error("[gstr2b/get]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:period/recon — RECONCILIATION (the headline feature)
// ─────────────────────────────────────────────────────────────────────────────
// Compares 2B records against the company's purchase vouchers + expenses and
// produces four buckets:
//   - matched:        same supplier GSTIN + invoice number, amounts within tolerance
//   - mismatched:     same supplier GSTIN + invoice number, amounts differ
//   - only_in_2b:     supplier filed but no entry in our books → potential missing ITC
//   - only_in_books:  in our books but supplier hasn't filed → ITC at risk
//
// Tolerance defaults (configurable via query params):
//   amount:  ₹1 (rounding-induced differences ignored)
//   date:    ±3 days (suppliers sometimes file with off-by-a-day dates)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:period/recon", accountantAuth, async (req, res) => {
  try {
    await ensureIndexMigration();
    const {
      companyId,
      amountTolerance = 1,
      dateTolerance = 3,
      cache,
      returnType = "GSTR2B",
    } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const amtTol = Number(amountTolerance) || 1;
    const dayTol = Number(dateTolerance) || 3;

    // `cache=true` means: if we have a stored result, return it instantly
    // without recomputing. The frontend uses this for the initial page open;
    // a manual "Refresh" call omits the param to force a fresh computation.
    const useCache = cache === "true" || cache === "1";

    // Look for the doc matching this period + returnType. Legacy docs
    // created before the 2A migration don't have a `returnType` field — those
    // are implicitly GSTR-2B, so we accept them when the caller asks for 2B.
    const baseQuery = {
      companyId: new mongoose.Types.ObjectId(companyId),
      returnPeriod: req.params.period,
    };
    const typeQuery =
      returnType === "GSTR2B"
        ? {
            $or: [{ returnType: "GSTR2B" }, { returnType: { $exists: false } }],
          }
        : { returnType };
    const doc = await Acc_GSTR2B.findOne({ ...baseQuery, ...typeQuery }).lean();
    if (!doc)
      return res.status(404).json({
        success: false,
        message: `No ${returnType === "GSTR2A" ? "GSTR-2A" : "GSTR-2B"} imported for this period`,
      });

    // ── Cache hit path ─────────────────────────────────────────────────
    if (useCache && doc.lastReconAt && doc.lastReconBuckets) {
      return res.json({
        success: true,
        cached: true,
        returnType: doc.returnType,
        period: doc.returnPeriod,
        periodLabel: new Date(
          doc.periodYear,
          doc.periodMonth - 1,
        ).toLocaleString("en-IN", { month: "long", year: "numeric" }),
        tolerance: doc.lastReconTolerance || { amount: amtTol, days: dayTol },
        lastReconAt: doc.lastReconAt,
        lastReconBy: doc.lastReconBy,
        summary: doc.lastReconSummary,
        buckets: doc.lastReconBuckets,
      });
    }

    // Build the books-side dataset. We pull purchase vouchers for an extended
    // window (period start − 1 month to period end + 1 month) to catch
    // invoices the supplier may have filed in a different return period than
    // we booked them.
    const startOfPeriod = new Date(doc.periodYear, doc.periodMonth - 1, 1);
    const endOfPeriod = new Date(
      doc.periodYear,
      doc.periodMonth,
      0,
      23,
      59,
      59,
    );
    const windowStart = new Date(startOfPeriod);
    windowStart.setMonth(windowStart.getMonth() - 1);
    const windowEnd = new Date(endOfPeriod);
    windowEnd.setMonth(windowEnd.getMonth() + 1);

    // Fetch ledgers once to map party-name → GSTIN
    const ledgers = await Acc_Ledger.find({
      companyId: new mongoose.Types.ObjectId(companyId),
    })
      .select("name gstin")
      .lean();
    const gstinByLedger = {};
    for (const l of ledgers) {
      if (l.gstin) gstinByLedger[l.name] = l.gstin.toUpperCase().trim();
    }

    // Purchase vouchers (Tally import path)
    const purchaseTypes = ["purchase", "debit_note", "journal"]; // journal covers freight/expense entries posted directly
    const vouchers = await Acc_Voucher.find({
      companyId: new mongoose.Types.ObjectId(companyId),
      voucherType: { $in: purchaseTypes },
      voucherDate: { $gte: windowStart, $lte: windowEnd },
      status: "posted",
    })
      .select(
        "voucherNumber voucherDate voucherType partyLedgerName partyLedgerId ledgerEntries inventoryEntries",
      )
      .lean();

    // Flatten vouchers into bookRecords matching the 2B record shape
    const bookRecords = [];
    for (const v of vouchers) {
      let supplierGSTIN = gstinByLedger[v.partyLedgerName] || "";

      // For journal vouchers, partyLedgerName may be empty (freight entries).
      // Scan Cr ledger entries to find a vendor/creditor with a GSTIN.
      if (!supplierGSTIN && v.voucherType === "journal") {
        for (const le of v.ledgerEntries || []) {
          const g = gstinByLedger[le.ledgerName];
          if (g) {
            supplierGSTIN = g;
            break;
          }
        }
      } // Sum GST line amounts from ledgerEntries that look like tax ledgers.
      // Everything else on a purchase voucher (purchase/expense/discount
      // ledger, etc.) contributes to the taxable base — NOT just lines named
      // "purchase". A telephone expense voucher posts to "Telephone Expenses"
      // or similar, but its base is still the taxable portion that 2B records.
      // The party ledger is excluded (that's the credit side total).
      let cgst = 0,
        sgst = 0,
        igst = 0,
        cess = 0;
      let taxableValue = 0;
      for (const le of v.ledgerEntries || []) {
        const lname = (le.ledgerName || "").toLowerCase();
        // Tally import uses amount + type; newer entries use signedAmount
        const amt =
          le.signedAmount != null
            ? Math.abs(Number(le.signedAmount))
            : Number(le.amount || 0);
        if (/cgst/.test(lname)) cgst += amt;
        else if (/sgst|utgst/.test(lname)) sgst += amt;
        else if (/igst/.test(lname)) igst += amt;
        else if (/cess/.test(lname)) cess += amt;
        // Skip the party ledger (credit side, equals the invoice total)
        else if (lname === (v.partyLedgerName || "").toLowerCase()) continue;
        // Skip round-off / tcs / tds noise so they don't inflate the taxable base
        else if (/round\s*off|rounding|tcs|tds|profit\s*&\s*loss/.test(lname))
          continue;
        // Everything else (purchase, expense, discount, fees, etc.) is base
        else taxableValue += amt;
      }
      bookRecords.push({
        _id: v._id,
        partyLedgerId: v.partyLedgerId ? String(v.partyLedgerId) : null,
        voucherType: v.voucherType,
        bookDocNumber: v.voucherNumber || "",
        bookDocDate: v.voucherDate,
        partyLedgerName: v.partyLedgerName || "",
        supplierGSTIN,
        taxableValue,
        cgst,
        sgst,
        igst,
        cess,
        totalTax: cgst + sgst + igst + cess,
        invoiceValue: taxableValue + cgst + sgst + igst + cess,
      });
    }

    // Expenses (operational path) — optional, only if model exists
    if (Acc_Expense) {
      const expenses = await Acc_Expense.find({
        gstApplicable: true,
        createdAt: { $gte: windowStart, $lte: windowEnd },
      })
        .select(
          "expenseId description gstDetails totalAmount vendorName vendorGstin createdAt",
        )
        .lean();
      for (const e of expenses) {
        const g = e.gstDetails || {};
        bookRecords.push({
          _id: e._id,
          voucherType: "expense",
          bookDocNumber: e.expenseId || "",
          bookDocDate: e.createdAt,
          partyLedgerName: e.vendorName || "",
          supplierGSTIN: (e.vendorGstin || "").toUpperCase().trim(),
          taxableValue: Number(e.totalAmount || 0),
          cgst: Number(g.cgst || 0),
          sgst: Number(g.sgst || 0),
          igst: Number(g.igst || 0),
          cess: Number(g.cess || 0),
          totalTax:
            Number(g.cgst || 0) +
            Number(g.sgst || 0) +
            Number(g.igst || 0) +
            Number(g.cess || 0),
          invoiceValue: Number(e.totalAmount || 0),
        });
      }
    }

    // Build a fast lookup: (normalized GSTIN + invoice number) → bookRecord
    // ── Live GSTIN + name refresh from current ledger state ───────────────────
    // Problem 1: Vouchers booked BEFORE a supplier's GSTIN was added to
    // their ledger have partyGstin="" and supplierGSTIN="". The match key
    // becomes "::INV-001" which can never match "19AADFK6889N1ZC::INV-001"
    // from the portal, so these entries land in "Only in Books" forever.
    //
    // Problem 2: The voucher snapshot has the OLD party name ("Kishore rothers")
    // even after the ledger was renamed ("Kishore Brothers"). The reconciliation
    // display shows stale names until the voucher itself is re-saved.
    //
    // Fix: after all bookRecords are built (vouchers + expenses), do a single
    // batch lookup against the CURRENT ledger master and back-fill:
    //   a) missing GSTINs (by ledgerId first, then by normalized name)
    //   b) stale party display names → current ledger name
    // This is a read-only pass — vouchers in MongoDB are NOT modified.
    const _liveledgers = await Acc_Ledger.find({
      companyId: new mongoose.Types.ObjectId(companyId),
      isActive: true,
    })
      .select("_id name gstin")
      .lean();

    const _gstinById = new Map(); // ledgerId   → current GSTIN (upper)
    const _gstinByName = new Map(); // lower(name) → current GSTIN (upper)
    const _nameById = new Map(); // ledgerId   → current display name

    for (const l of _liveledgers) {
      const lid = l._id.toString();
      const g = (l.gstin || "").toUpperCase().trim();
      const nm = (l.name || "").trim();
      if (g) {
        _gstinById.set(lid, g);
        _gstinByName.set(nm.toLowerCase(), g);
      }
      _nameById.set(lid, nm);
    }

    for (const br of bookRecords) {
      // a) Back-fill GSTIN missing from voucher snapshot
      if (!br.supplierGSTIN) {
        if (br.partyLedgerId)
          br.supplierGSTIN = _gstinById.get(br.partyLedgerId) || "";
        if (!br.supplierGSTIN && br.partyLedgerName)
          br.supplierGSTIN =
            _gstinByName.get((br.partyLedgerName || "").trim().toLowerCase()) ||
            "";
      }
      // b) Refresh party display name to current ledger name (fixes renames)
      if (br.partyLedgerId) {
        const currentName = _nameById.get(br.partyLedgerId);
        if (currentName) br.partyLedgerName = currentName;
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Build a fast lookup: (normalized GSTIN + invoice number) → bookRecord
    const bookByKey = new Map();
    for (const br of bookRecords) {
      const key = `${br.supplierGSTIN}::${normInvNum(br.bookDocNumber)}`;
      // If duplicates exist, keep the first; mark for review.
      if (!bookByKey.has(key)) bookByKey.set(key, br);
    }

    // Walk 2B records and bucket them
    const matched = [];
    const mismatched = [];
    const onlyIn2B = [];
    const matchedBookIds = new Set();

    // Only reconcile invoices/credit-notes — IMPG/ISD don't have a books counterpart
    // in the typical SMB workflow; surface them separately if needed.
    const recordsForRecon = doc.records.filter((r) =>
      ["b2b", "b2ba", "cdnr", "cdnra"].includes(r.section),
    );

    for (const r2b of recordsForRecon) {
      const key = `${r2b.supplierGSTIN}::${normInvNum(r2b.docNumber)}`;
      const book = bookByKey.get(key);

      if (!book) {
        onlyIn2B.push({
          ...r2b,
          severity: r2b.itcAvailable ? "warn" : "info",
          reason:
            "Supplier filed this in their GSTR-1 but it's not in your books.",
          impactRupees: r2b.cgst + r2b.sgst + r2b.igst,
        });
        continue;
      }

      matchedBookIds.add(String(book._id));

      // ── Match criteria ─────────────────────────────────────────────────
      // A record MATCHES when it agrees with the book on exactly these four
      // parameters: GSTIN, Invoice number, Taxable value, Tax amount.
      //   • GSTIN + Invoice number → already enforced by the pairing key
      //     (`${supplierGSTIN}::${normInvNum(docNumber)}`); if we reached here
      //     they already agree.
      //   • Taxable value and total Tax amount → checked within tolerance below.
      // Document date and the individual CGST/SGST/IGST/Cess split are NOT part
      // of the match decision — they're computed only for on-screen display.
      const taxR2b = r2b.cgst + r2b.sgst + r2b.igst + r2b.cess;
      const diffTaxable = Math.abs(r2b.taxableValue - book.taxableValue);
      const diffTotalTax = Math.abs(taxR2b - book.totalTax);

      const amountsMatch = diffTaxable <= amtTol && diffTotalTax <= amtTol;

      // Date diff — informational only (shown in the UI, never affects match).
      let daysDiff = null;
      if (r2b.docDate && book.bookDocDate) {
        daysDiff = Math.round(
          Math.abs(new Date(r2b.docDate) - new Date(book.bookDocDate)) /
            (1000 * 60 * 60 * 24),
        );
      }

      const entry = {
        gstr2b: r2b,
        book,
        diffs: {
          taxableValue: r2b.taxableValue - book.taxableValue,
          cgst: r2b.cgst - book.cgst,
          sgst: r2b.sgst - book.sgst,
          igst: r2b.igst - book.igst,
          cess: r2b.cess - book.cess,
          totalTax: taxR2b - book.totalTax,
          dateDiffDays: daysDiff,
        },
      };

      if (amountsMatch) {
        matched.push(entry);
      } else {
        // Mismatch reasons are limited to the two amount parameters we match
        // on — Taxable value and Tax amount. (GSTIN + Invoice number already
        // agree; date and tax-split differences never drive the bucket.)
        const reasons = [];
        if (diffTaxable > amtTol)
          reasons.push(`taxable value differs by ₹${diffTaxable.toFixed(2)}`);
        if (diffTotalTax > amtTol)
          reasons.push(`tax amount differs by ₹${diffTotalTax.toFixed(2)}`);
        mismatched.push({ ...entry, reasons });
      }
    }

    // Books entries that didn't get matched against any 2B record.
    // Filter to only purchase-side entries that have a supplier GSTIN
    // (intra-period only — outside-period would be false positives).
    const inPeriodBookIds = new Set(
      bookRecords
        .filter((b) => {
          const d = new Date(b.bookDocDate);
          return d >= startOfPeriod && d <= endOfPeriod;
        })
        .map((b) => String(b._id)),
    );
    const onlyInBooks = bookRecords
      .filter(
        (b) =>
          inPeriodBookIds.has(String(b._id)) &&
          !matchedBookIds.has(String(b._id)),
      )
      .filter((b) => b.supplierGSTIN || b.partyLedgerName)
      .map((b) => ({
        ...b,
        severity: b.totalTax > 0 ? "warn" : "info",
        reason: b.supplierGSTIN
          ? "In your books but the supplier hasn't filed this in their GSTR-1. Follow up — ITC at risk."
          : "In your books but party has no GSTIN on file. Verify supplier registration to claim ITC.",
        impactRupees: b.totalTax,
      }));

    // ── Build summary rollup ─────────────────────────────────────────
    const sum = (arr, getter) => arr.reduce((s, x) => s + getter(x), 0);

    const summary = {
      matched: {
        count: matched.length,
        totalTaxableValue: sum(matched, (e) => e.gstr2b.taxableValue),
        totalTax: sum(
          matched,
          (e) => e.gstr2b.cgst + e.gstr2b.sgst + e.gstr2b.igst + e.gstr2b.cess,
        ),
      },
      mismatched: {
        count: mismatched.length,
        totalTaxDiff: sum(mismatched, (e) => Math.abs(e.diffs.totalTax)),
        // 2B-side total for mismatched rows (still part of "what portal says")
        totalTax2B: sum(
          mismatched,
          (e) => e.gstr2b.cgst + e.gstr2b.sgst + e.gstr2b.igst + e.gstr2b.cess,
        ),
        // Books-side total for mismatched rows (still part of "what your books say")
        totalTaxBooks: sum(mismatched, (e) => e.book.totalTax || 0),
      },
      onlyIn2B: {
        count: onlyIn2B.length,
        totalTax: sum(onlyIn2B, (e) => e.cgst + e.sgst + e.igst + e.cess),
        availableITC: sum(
          onlyIn2B.filter((e) => e.itcAvailable),
          (e) => e.cgst + e.sgst + e.igst + e.cess,
        ),
      },
      onlyInBooks: {
        count: onlyInBooks.length,
        totalTax: sum(onlyInBooks, (e) => e.totalTax),
      },
      // Grand totals to make the variance card math obvious to anyone
      // who reads the API response directly.
      portalTotalTax:
        sum(
          matched,
          (e) => e.gstr2b.cgst + e.gstr2b.sgst + e.gstr2b.igst + e.gstr2b.cess,
        ) +
        sum(
          mismatched,
          (e) => e.gstr2b.cgst + e.gstr2b.sgst + e.gstr2b.igst + e.gstr2b.cess,
        ) +
        sum(onlyIn2B, (e) => e.cgst + e.sgst + e.igst + e.cess),
      booksTotalTax:
        sum(matched, (e) => e.book.totalTax || 0) +
        sum(mismatched, (e) => e.book.totalTax || 0) +
        sum(onlyInBooks, (e) => e.totalTax || 0),
    };

    const buckets = { matched, mismatched, onlyIn2B, onlyInBooks };
    const reconAt = new Date();

    // Persist the fresh result onto the 2B document so subsequent page loads
    // can serve from cache (see `?cache=true` path above). Fire-and-forget —
    // the user gets the result regardless of whether the save succeeds.
    Acc_GSTR2B.updateOne(
      { _id: doc._id },
      {
        $set: {
          lastReconAt: reconAt,
          lastReconBy: req.accountant?.email || "",
          lastReconSummary: summary,
          lastReconBuckets: buckets,
          lastReconTolerance: { amount: amtTol, days: dayTol },
        },
      },
    ).catch((e) =>
      console.error("[gstr2b/recon] cache write failed:", e.message),
    );

    res.json({
      success: true,
      cached: false,
      returnType: doc.returnType,
      period: doc.returnPeriod,
      periodLabel: new Date(doc.periodYear, doc.periodMonth - 1).toLocaleString(
        "en-IN",
        { month: "long", year: "numeric" },
      ),
      tolerance: { amount: amtTol, days: dayTol },
      lastReconAt: reconAt,
      summary,
      buckets,
    });
  } catch (e) {
    console.error("[gstr2b/recon]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:period/supplier-summary — supplier-wise rollup with filing status
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:period/supplier-summary", accountantAuth, async (req, res) => {
  try {
    const { companyId, returnType = "GSTR2B" } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const doc = await Acc_GSTR2B.findOne({
      companyId: new mongoose.Types.ObjectId(companyId),
      returnPeriod: req.params.period,
      returnType,
    }).lean();
    if (!doc)
      return res.status(404).json({
        success: false,
        message: `No ${returnType === "GSTR2A" ? "GSTR-2A" : "GSTR-2B"} imported for this period`,
      });

    // Aggregate by supplier GSTIN
    const bySupplier = new Map();
    for (const r of doc.records) {
      if (!r.supplierGSTIN) continue;
      const k = r.supplierGSTIN;
      const s = bySupplier.get(k) || {
        supplierGSTIN: k,
        supplierName: r.supplierName,
        supplierFilingDate: r.supplierFilingDate,
        invoiceCount: 0,
        totalTaxableValue: 0,
        totalCGST: 0,
        totalSGST: 0,
        totalIGST: 0,
        totalCess: 0,
        totalTax: 0,
        itcAvailable: 0,
        itcUnavailable: 0,
      };
      s.invoiceCount += 1;
      s.totalTaxableValue += r.taxableValue;
      s.totalCGST += r.cgst;
      s.totalSGST += r.sgst;
      s.totalIGST += r.igst;
      s.totalCess += r.cess;
      const recordTax = r.cgst + r.sgst + r.igst + r.cess;
      s.totalTax += recordTax;
      if (r.itcAvailable) s.itcAvailable += recordTax;
      else s.itcUnavailable += recordTax;
      bySupplier.set(k, s);
    }

    const suppliers = Array.from(bySupplier.values()).sort(
      (a, b) => b.totalTax - a.totalTax,
    );

    res.json({ success: true, suppliers, period: doc.returnPeriod });
  } catch (e) {
    console.error("[gstr2b/supplier-summary]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:period — remove an imported 2B period (in case of bad upload)
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:period", accountantAuth, async (req, res) => {
  try {
    const { companyId, returnType = "GSTR2B" } = req.query;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const r = await Acc_GSTR2B.deleteOne({
      companyId: new mongoose.Types.ObjectId(companyId),
      returnPeriod: req.params.period,
      returnType,
    });
    if (r.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: `No ${returnType === "GSTR2A" ? "GSTR-2A" : "GSTR-2B"} found for this period`,
      });
    }
    res.json({ success: true, deleted: 1 });
  } catch (e) {
    console.error("[gstr2b/delete]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
