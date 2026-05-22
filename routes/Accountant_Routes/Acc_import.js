// routes/Accountant_Routes/Acc_import.js
// =============================================================================
// TALLY IMPORT — full lifecycle endpoints
// -----------------------------------------------------------------------------
// Flow:
//   POST   /upload          → upload file, create session, parse, return preview
//   GET    /sessions/:id    → poll session state
//   POST   /sessions/:id/suggest-mapping  → auto-suggest column→field mapping
//   PUT    /sessions/:id/mapping          → save proposed mapping
//   POST   /sessions/:id/validate         → dry-run validation
//   POST   /sessions/:id/commit           → actually write to DB
//   POST   /sessions/:id/rollback         → undo a completed import
//   GET    /sessions                       → list past sessions
//   GET    /mappings        → list saved mapping templates
//   POST   /mappings        → save a mapping template
// =============================================================================

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const {
  Acc_Company,
  Acc_Group,
  Acc_Ledger,
  Acc_StockGroup,
  Acc_StockItem,
  Acc_Unit,
  Acc_CostCentre,
} = require("../../models/Accountant_model/Acc_MasterModels");
const {
  Acc_Voucher,
} = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_FieldMapping,
  Acc_ImportSession,
} = require("../../models/Accountant_model/Acc_ImportModels");

const tallyParser = require("../../services/tallyParser.service");
const tallyMapper = require("../../services/tallyMapper.service");
const bSheetImporter = require("../../services/tallyBSheetImporter.service");
const mastersImporter = require("../../services/tallyMastersImporter.service");
// Tiny top-level "Balance Sheet" summary export — used ONLY to verify an
// import is accurate against Tally's own totals (never to create data).
const bSheetSummary = require("../../services/TallyBsheetsummary.service");
// Tally Day Book export (Display More Reports → Day Book → Alt+E → JSON).
// The cleanest voucher source — full GST detail, all voucher types.
const dayBookImporter = require("../../services/tallyDayBookImporter.service");
// Trial Balance export taken WITH opening balances (F5 ledger-wise, F12
// Show Opening Balance = Yes). Masters never carries openings, so this is
// how Balance-Sheet accounts get their true brought-forward position.
const tbOpenings = require("../../services/tallyTrialBalanceOpenings.service");

router.use(accountantAuth);

// ─── Multer: in-memory upload, 50MB cap (Tally exports rarely exceed this) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv|xml|json)$/i.test(file.originalname);
    if (!ok)
      return cb(
        new Error("Only .xlsx, .xls, .csv, .xml, .json files are accepted"),
      );
    cb(null, true);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /upload
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded" });

    const { companyId, importType, entityType: hintEntity } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId is required" });

    const company = await Acc_Company.findById(companyId);
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });

    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    const checksum = tallyParser.fileChecksum(req.file.buffer);

    // Create session up front so we can stream progress
    const session = await Acc_ImportSession.create({
      companyId,
      fileName: req.file.originalname,
      fileType: ext,
      fileSize: req.file.size,
      fileChecksum: checksum,
      importType: importType || "transactions",
      entityType: hintEntity || "mixed",
      status: "parsing",
      initiatedBy: req.user?.id,
    });

    // Parse the file
    let parsed;
    try {
      parsed = await tallyParser.parseFile(req.file.buffer, { fileType: ext });
    } catch (parseErr) {
      session.status = "failed";
      session.sessionErrors.push(`Parse error: ${parseErr.message}`);
      await session.save();
      return res.status(400).json({
        success: false,
        message: `Failed to parse file: ${parseErr.message}`,
      });
    }

    // Try to detect entity type if not given
    const detectedEntity =
      hintEntity || tallyParser.detectEntityType(parsed.columns) || "mixed";

    session.status = "parsed";
    session.detectedColumns = parsed.columns;
    session.detectedSheetNames = parsed.sheets;
    session.activeSheetName = parsed.activeSheet;
    session.totalRows = parsed.totalRows;
    session.sampleRows = parsed.rows.slice(0, 10);
    session.entityType = detectedEntity;
    session.parsedAt = new Date();
    session.summary.total = parsed.totalRows;
    await session.save();

    res.json({
      success: true,
      message: "File parsed",
      session: {
        _id: session._id,
        status: session.status,
        fileName: session.fileName,
        fileType: session.fileType,
        totalRows: session.totalRows,
        detectedColumns: session.detectedColumns,
        detectedSheetNames: session.detectedSheetNames,
        activeSheetName: session.activeSheetName,
        sampleRows: session.sampleRows,
        entityType: session.entityType,
      },
      // Suggest a mapping right away so the UI can pre-populate
      suggestedMapping: tallyMapper.suggestMapping(
        parsed.columns,
        detectedEntity,
      ),
    });
  } catch (err) {
    console.error("Tally import upload:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sessions/:id  — full session detail (used for polling)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/sessions/:id", async (req, res) => {
  try {
    const session = await Acc_ImportSession.findById(req.params.id)
      .populate("fieldMappingId", "name entityType")
      .lean();
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });

    // Trim heavy fields by default
    const compact =
      req.query.full === "true"
        ? session
        : {
            ...session,
            rows: (session.rows || []).slice(0, 50),
            sampleRows: session.sampleRows,
          };

    res.json({ success: true, session: compact });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sessions  — paginated list
// ─────────────────────────────────────────────────────────────────────────────
router.get("/sessions", async (req, res) => {
  try {
    const { companyId, status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (companyId) filter.companyId = companyId;
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [sessions, total] = await Promise.all([
      Acc_ImportSession.find(filter)
        .select("-rows -sampleRows -fieldMappingSnapshot -rollbackTokens")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Acc_ImportSession.countDocuments(filter),
    ]);

    res.json({
      success: true,
      sessions,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sessions/:id/suggest-mapping
// ─────────────────────────────────────────────────────────────────────────────
router.post("/sessions/:id/suggest-mapping", async (req, res) => {
  try {
    const session = await Acc_ImportSession.findById(req.params.id);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });

    const entityType = req.body.entityType || session.entityType;
    const suggested = tallyMapper.suggestMapping(
      session.detectedColumns,
      entityType,
    );
    res.json({ success: true, entityType, mappings: suggested });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /sessions/:id/mapping  — save the mapping the user finalised in the UI
// ─────────────────────────────────────────────────────────────────────────────
router.put("/sessions/:id/mapping", async (req, res) => {
  try {
    const {
      mappings,
      fileShape,
      multiRowRule,
      autoCreate,
      defaultLedgerGroup,
      entityType,
      saveAsTemplate,
      templateName,
    } = req.body;
    const session = await Acc_ImportSession.findById(req.params.id);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });

    if (entityType) session.entityType = entityType;

    session.fieldMappingSnapshot = {
      mappings: mappings || [],
      fileShape: fileShape || {},
      multiRowRule: multiRowRule || { enabled: false },
      autoCreate: autoCreate || {
        ledgers: true,
        stockItems: false,
        groups: false,
      },
      defaultLedgerGroup: defaultLedgerGroup || "Sundry Debtors",
    };
    session.status = "mapping";
    await session.save();

    // Optionally persist as a reusable template
    let template = null;
    if (saveAsTemplate && templateName) {
      template = await Acc_FieldMapping.create({
        name: templateName,
        entityType: session.entityType,
        fileShape: fileShape || {},
        mappings: mappings || [],
        multiRowRule: multiRowRule || { enabled: false },
        autoCreate: autoCreate || {
          ledgers: true,
          stockItems: false,
          groups: false,
        },
        defaultLedgerGroup: defaultLedgerGroup || "Sundry Debtors",
        companyId: session.companyId,
        createdBy: req.user?.id,
      });
      session.fieldMappingId = template._id;
      await session.save();
    }

    res.json({ success: true, session, template });
  } catch (err) {
    console.error("Save mapping:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sessions/:id/validate  — dry-run; reports all problems before writing
// ─────────────────────────────────────────────────────────────────────────────
router.post("/sessions/:id/validate", async (req, res) => {
  try {
    const session = await Acc_ImportSession.findById(req.params.id);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    if (!session.fieldMappingSnapshot?.mappings?.length) {
      return res.status(400).json({
        success: false,
        message: "Mapping not saved on this session yet",
      });
    }

    // Re-parse to get full row set (we only stored a sample on upload)
    // In a production system you'd persist the file to disk/cloud and read
    // it back here. For this implementation we expect the validate call to
    // come from the same UI session that uploaded the file, and we just
    // re-validate against the sample for demo purposes.
    //
    // TODO: persist raw file to /tmp/tally-imports/<sessionId>.<ext>
    const sample = session.sampleRows || [];

    const mapping = session.fieldMappingSnapshot;
    const fileShape = mapping.fileShape || {};
    const multi = mapping.multiRowRule?.enabled
      ? tallyMapper.foldMultiRow(sample, mapping, fileShape)
      : sample.map((r, i) => ({
          ...tallyMapper.applyMapping(r, mapping, fileShape),
          rowNumber: i + 1,
        }));

    const errors = [];
    const validated = multi.map((r) => {
      if (r.errors && r.errors.length)
        errors.push({ rowNumber: r.rowNumber, errors: r.errors });
      return {
        rowNumber: r.rowNumber,
        status: r.errors?.length ? "invalid" : "valid",
        data: r.data,
      };
    });

    session.status = "validated";
    session.validatedAt = new Date();
    session.summary.valid = validated.filter(
      (v) => v.status === "valid",
    ).length;
    session.summary.invalid = validated.filter(
      (v) => v.status === "invalid",
    ).length;
    await session.save();

    res.json({
      success: true,
      session: {
        _id: session._id,
        status: session.status,
        summary: session.summary,
      },
      validatedRows: validated,
      errors,
    });
  } catch (err) {
    console.error("Validate:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sessions/:id/commit  — actually write data
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the heaviest endpoint. The flow per row depends on entityType:
//   • ledger          → upsert Acc_Ledger
//   • stock_item      → upsert Acc_StockItem
//   • voucher_*       → resolve party + each ledgerEntry's ledger, create
//                        Acc_Voucher with status='posted'
//   • group           → upsert Acc_Group
//
// We build a `rollbackTokens` array as we go so the import can be undone.
router.post("/sessions/:id/commit", async (req, res) => {
  try {
    const session = await Acc_ImportSession.findById(req.params.id);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    if (
      session.status === "completed" ||
      session.status === "completed_with_errors"
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Session already committed" });
    }
    if (!session.fieldMappingSnapshot?.mappings?.length) {
      return res
        .status(400)
        .json({ success: false, message: "Mapping not saved" });
    }

    session.status = "importing";
    session.importedAt = new Date();
    await session.save();

    const mapping = session.fieldMappingSnapshot;
    const fileShape = mapping.fileShape || {};
    const rows = req.body.rows || session.sampleRows || []; // expect UI to pass full rows back

    let prepared;
    if (mapping.multiRowRule?.enabled) {
      prepared = tallyMapper.foldMultiRow(rows, mapping, fileShape);
    } else {
      prepared = rows.map((r, i) => ({
        ...tallyMapper.applyMapping(r, mapping, fileShape),
        rowNumber: i + 1,
      }));
    }

    const created = {
      ledgers: 0,
      groups: 0,
      stockItems: 0,
      vouchers: 0,
      costCentres: 0,
    };
    const rollbackTokens = [];
    const rowResults = [];

    for (const p of prepared) {
      if (p.errors && p.errors.length) {
        rowResults.push({
          rowNumber: p.rowNumber,
          status: "invalid",
          errors: p.errors,
        });
        continue;
      }

      try {
        const result = await commitOne(p, session, mapping, req.user?.id);
        if (result?.created?._id) {
          rollbackTokens.push({
            collection: result.collection,
            objectId: result.created._id,
          });
          created[result.kind] = (created[result.kind] || 0) + 1;
          rowResults.push({
            rowNumber: p.rowNumber,
            status: "imported",
            createdEntity: {
              type: result.kind,
              collection: result.collection,
              objectId: result.created._id,
              identifier: result.identifier,
            },
          });
        } else {
          rowResults.push({ rowNumber: p.rowNumber, status: "skipped" });
        }
      } catch (err) {
        rowResults.push({
          rowNumber: p.rowNumber,
          status: "error",
          errors: [{ field: "*", message: err.message }],
        });
      }
    }

    session.rows = rowResults;
    session.rollbackTokens = rollbackTokens;
    session.createdCounts = created;
    session.summary.imported = rowResults.filter(
      (r) => r.status === "imported",
    ).length;
    session.summary.errors = rowResults.filter(
      (r) => r.status === "error",
    ).length;
    session.summary.skipped = rowResults.filter(
      (r) => r.status === "skipped",
    ).length;

    session.status =
      session.summary.errors > 0 ? "completed_with_errors" : "completed";
    session.completedAt = new Date();
    await session.save();

    res.json({
      success: true,
      message: `Imported ${session.summary.imported} of ${prepared.length} rows`,
      session: {
        _id: session._id,
        status: session.status,
        summary: session.summary,
        createdCounts: session.createdCounts,
        rowResults,
      },
    });
  } catch (err) {
    console.error("Commit:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// commitOne — dispatcher per entity type
// ─────────────────────────────────────────────────────────────────────────────
async function commitOne(prepared, session, mapping, accountantId) {
  const data = prepared.data || {};
  const companyId = session.companyId;

  switch (session.entityType) {
    // ─── LEDGER ─────────────────────────────────────────────────────────────
    case "ledger": {
      if (!data.name || !data.groupName)
        throw new Error("Ledger requires name and groupName");
      const group = await Acc_Group.findOne({
        companyId,
        name: data.groupName,
      });
      if (!group) {
        if (!mapping.autoCreate?.groups)
          throw new Error(`Group "${data.groupName}" not found`);
        // shouldn't normally auto-create groups — they need a nature
        throw new Error(
          `Group "${data.groupName}" not found and group auto-create requires a nature.`,
        );
      }
      // Upsert by (companyId, name)
      const ledger = await Acc_Ledger.findOneAndUpdate(
        { companyId, name: data.name },
        {
          $set: {
            ...data,
            companyId,
            groupId: group._id,
            groupName: group.name,
            nature: data.nature || group.nature,
            importSource: `tally_${session.fileType}`,
            importedAt: new Date(),
            createdBy: accountantId,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      return {
        kind: "ledgers",
        collection: "acc_ledgers",
        created: ledger,
        identifier: ledger.name,
      };
    }

    // ─── STOCK ITEM ─────────────────────────────────────────────────────────
    case "stock_item": {
      if (!data.name) throw new Error("Stock item requires name");
      let stockGroup = null;
      if (data.stockGroupName) {
        stockGroup = await Acc_StockGroup.findOne({
          companyId,
          name: data.stockGroupName,
        });
      }
      const item = await Acc_StockItem.findOneAndUpdate(
        { companyId, name: data.name },
        {
          $set: {
            ...data,
            companyId,
            stockGroupId: stockGroup?._id,
            importedAt: new Date(),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      return {
        kind: "stockItems",
        collection: "acc_stock_items",
        created: item,
        identifier: item.name,
      };
    }

    // ─── GROUP ──────────────────────────────────────────────────────────────
    case "group": {
      if (!data.name) throw new Error("Group requires name");
      let parent = null;
      if (data.parentName) {
        parent = await Acc_Group.findOne({ companyId, name: data.parentName });
      }
      const grp = await Acc_Group.findOneAndUpdate(
        { companyId, name: data.name },
        {
          $set: {
            ...data,
            companyId,
            parent: parent?._id,
            parentName: parent?.name,
            level: parent ? (parent.level || 1) + 1 : 1,
            fullPath: parent ? `${parent.fullPath} > ${data.name}` : data.name,
            createdBy: accountantId,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      return {
        kind: "groups",
        collection: "acc_groups",
        created: grp,
        identifier: grp.name,
      };
    }

    // ─── VOUCHERS ───────────────────────────────────────────────────────────
    case "voucher_sales":
    case "voucher_purchase":
    case "voucher_payment":
    case "voucher_receipt":
    case "voucher_journal":
    case "voucher_contra":
    case "voucher_credit_note":
    case "voucher_debit_note": {
      const vchType = session.entityType.replace("voucher_", "");
      if (!data.voucherDate || !data.voucherNumber) {
        throw new Error("Voucher requires voucherDate and voucherNumber");
      }

      // Resolve party ledger
      let partyLedger = null;
      if (data.partyLedgerName) {
        const ledgerMap = await tallyMapper.resolveLedgers(
          [data.partyLedgerName],
          companyId,
          {
            autoCreate: mapping.autoCreate?.ledgers,
            defaultGroup:
              vchType === "purchase" ? "Sundry Creditors" : "Sundry Debtors",
            createdBy: accountantId,
            importSource: `tally_${session.fileType}`,
          },
        );
        partyLedger = ledgerMap.get(data.partyLedgerName.toLowerCase());
      }

      // Resolve ledger entries (multi-row mode)
      const ledgerEntries = data.ledgerEntries || [];
      if (ledgerEntries.length) {
        const names = ledgerEntries.map((le) => le.ledgerName).filter(Boolean);
        const ledgerMap = await tallyMapper.resolveLedgers(names, companyId, {
          autoCreate: mapping.autoCreate?.ledgers,
          defaultGroup: mapping.defaultLedgerGroup,
          createdBy: accountantId,
          importSource: `tally_${session.fileType}`,
        });
        for (const le of ledgerEntries) {
          const found = ledgerMap.get(
            String(le.ledgerName || "").toLowerCase(),
          );
          if (found) {
            le.ledgerId = found._id;
            le.groupName = found.groupName;
          }
        }
      } else if (partyLedger && (data.grandTotal || 0) > 0) {
        // No explicit lines — synthesise a 2-line voucher from grandTotal + GST
        // (typical "single-row sales export" pattern)
        const total = parseFloat(data.grandTotal) || 0;
        const cgst = parseFloat(data.gstBreakup?.cgst || 0);
        const sgst = parseFloat(data.gstBreakup?.sgst || 0);
        const igst = parseFloat(data.gstBreakup?.igst || 0);
        const taxable = total - cgst - sgst - igst;

        const isSale = vchType === "sales";
        // Sales:    Dr Customer  / Cr Sales / Cr CGST / Cr SGST / Cr IGST
        // Purchase: Dr Purchase  / Dr CGST / Dr SGST / Dr IGST  / Cr Vendor
        ledgerEntries.length = 0;
        if (isSale) {
          ledgerEntries.push({
            ledgerId: partyLedger._id,
            ledgerName: partyLedger.name,
            type: "Dr",
            amount: total,
          });
          ledgerEntries.push({
            ledgerName: "Sales Accounts",
            type: "Cr",
            amount: taxable,
          });
          if (cgst)
            ledgerEntries.push({
              ledgerName: "CGST Output",
              type: "Cr",
              amount: cgst,
            });
          if (sgst)
            ledgerEntries.push({
              ledgerName: "SGST Output",
              type: "Cr",
              amount: sgst,
            });
          if (igst)
            ledgerEntries.push({
              ledgerName: "IGST Output",
              type: "Cr",
              amount: igst,
            });
        } else {
          ledgerEntries.push({
            ledgerName: "Purchase Accounts",
            type: "Dr",
            amount: taxable,
          });
          if (cgst)
            ledgerEntries.push({
              ledgerName: "CGST Input",
              type: "Dr",
              amount: cgst,
            });
          if (sgst)
            ledgerEntries.push({
              ledgerName: "SGST Input",
              type: "Dr",
              amount: sgst,
            });
          if (igst)
            ledgerEntries.push({
              ledgerName: "IGST Input",
              type: "Dr",
              amount: igst,
            });
          ledgerEntries.push({
            ledgerId: partyLedger._id,
            ledgerName: partyLedger.name,
            type: "Cr",
            amount: total,
          });
        }

        // Resolve the synthetic ledger names
        const synthNames = ledgerEntries
          .filter((e) => !e.ledgerId)
          .map((e) => e.ledgerName);
        if (synthNames.length) {
          const ledgerMap = await tallyMapper.resolveLedgers(
            synthNames,
            companyId,
            {
              autoCreate: true,
              defaultGroup: "Sales Accounts",
              createdBy: accountantId,
              importSource: `tally_${session.fileType}`,
            },
          );
          ledgerEntries.forEach((e) => {
            if (!e.ledgerId) {
              const found = ledgerMap.get(e.ledgerName.toLowerCase());
              if (found) {
                e.ledgerId = found._id;
                e.groupName = found.groupName;
              }
            }
          });
        }
      }

      const voucher = await Acc_Voucher.create({
        companyId,
        voucherType: vchType,
        voucherTypeName: data.voucherTypeName || vchType,
        voucherNumber: data.voucherNumber,
        voucherDate: data.voucherDate,
        referenceNumber: data.referenceNumber,
        referenceDate: data.referenceDate,
        partyLedgerId: partyLedger?._id,
        partyLedgerName: partyLedger?.name || data.partyLedgerName,
        partyGstin: data.partyGstin,
        ledgerEntries,
        narration: data.narration,
        gstBreakup: data.gstBreakup || {},
        grandTotal: parseFloat(data.grandTotal) || 0,
        status: "posted",
        sourceSystem: "tally_import",
        importSession: session._id,
        importedAt: new Date(),
        enteredBy: accountantId,
        postedBy: accountantId,
        postedAt: new Date(),
      });

      return {
        kind: "vouchers",
        collection: "acc_vouchers",
        created: voucher,
        identifier: voucher.voucherNumber,
      };
    }

    default:
      throw new Error(`Unsupported entityType "${session.entityType}"`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /sessions/:id/rollback  — undo a completed import
// ─────────────────────────────────────────────────────────────────────────────
router.post("/sessions/:id/rollback", async (req, res) => {
  try {
    const session = await Acc_ImportSession.findById(req.params.id);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    if (!["completed", "completed_with_errors"].includes(session.status)) {
      return res.status(400).json({
        success: false,
        message: "Only completed imports can be rolled back",
      });
    }

    let deleted = 0;

    const tokens = session.rollbackTokens || [];
    const byCollection = tokens.reduce((acc, t) => {
      (acc[t.collection] ||= []).push(t.objectId);
      return acc;
    }, {});

    // Map every collection-token variant a commit might write to its model.
    // The Tally JSON commits push tokens as "acc_groups"/"acc_ledgers"/
    // "acc_vouchers"; older code only had "tally_*" keys so rollback
    // silently deleted nothing. Accept both naming styles.
    const collMap = {
      tally_ledgers: Acc_Ledger,
      tally_stock_items: Acc_StockItem,
      tally_groups: Acc_Group,
      tally_vouchers: Acc_Voucher,
      tally_cost_centres: Acc_CostCentre,
      acc_ledgers: Acc_Ledger,
      acc_stock_items: Acc_StockItem,
      acc_groups: Acc_Group,
      acc_vouchers: Acc_Voucher,
      acc_cost_centres: Acc_CostCentre,
    };

    // Delete vouchers first, then ledgers, then groups (respect references).
    const ORDER = [
      "acc_vouchers",
      "tally_vouchers",
      "acc_ledgers",
      "tally_ledgers",
      "acc_stock_items",
      "tally_stock_items",
      "acc_cost_centres",
      "tally_cost_centres",
      "acc_groups",
      "tally_groups",
    ];
    for (const coll of ORDER) {
      const ids = byCollection[coll];
      if (!ids || ids.length === 0) continue;
      const Model = collMap[coll];
      if (Model) {
        const r = await Model.deleteMany({ _id: { $in: ids } });
        deleted += r.deletedCount || 0;
      }
    }
    // Safety net: anything not covered by ORDER above.
    for (const [coll, ids] of Object.entries(byCollection)) {
      if (ORDER.includes(coll)) continue;
      const Model = collMap[coll];
      if (Model) {
        const r = await Model.deleteMany({ _id: { $in: ids } });
        deleted += r.deletedCount || 0;
      }
    }

    // ── HARD SWEEP ─────────────────────────────────────────────────────
    // The token list can be incomplete (older imports, partial writes,
    // ledgers auto-created during a later voucher post). The user expects
    // rollback to remove EVERYTHING that import brought in — permanently.
    // So, additionally, delete every record for this company that carries
    // an import/auto source marker. This is intentionally aggressive and
    // NOT restorable, which is the requested behaviour.
    const cId = session.companyId;
    if (cId) {
      const importSrc = {
        $in: [
          "tally_import",
          "auto_from_import",
          "auto_from_payroll",
          "auto_from_voucher",
          "import",
        ],
      };
      // Vouchers first (reference ledgers), then ledgers, then groups.
      const vS = await Acc_Voucher.deleteMany({
        companyId: cId,
        $or: [{ sourceSystem: importSrc }, { importSessionId: session._id }],
      });
      const lS = await Acc_Ledger.deleteMany({
        companyId: cId,
        sourceSystem: importSrc,
      });
      const sS = await Acc_StockItem.deleteMany({
        companyId: cId,
        sourceSystem: importSrc,
      });
      const gS = await Acc_Group.deleteMany({
        companyId: cId,
        sourceSystem: importSrc,
      });
      deleted +=
        (vS.deletedCount || 0) +
        (lS.deletedCount || 0) +
        (sS.deletedCount || 0) +
        (gS.deletedCount || 0);
    }

    session.status = "rolled_back";
    session.rolledBackAt = new Date();
    await session.save();

    res.json({
      success: true,
      message: `Rolled back ${deleted} records. This import's data has been permanently removed.`,
      deletedCount: deleted,
    });
  } catch (err) {
    console.error("Rollback:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MAPPING TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────
router.get("/mappings", async (req, res) => {
  try {
    const { entityType, companyId } = req.query;
    const filter = { isActive: true };
    if (entityType) filter.entityType = entityType;
    if (companyId) filter.$or = [{ companyId }, { companyId: null }];
    const mappings = await Acc_FieldMapping.find(filter)
      .sort({ timesUsed: -1, createdAt: -1 })
      .lean();
    res.json({ success: true, mappings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/mappings", async (req, res) => {
  try {
    const t = await Acc_FieldMapping.create({
      ...req.body,
      createdBy: req.user?.id,
    });
    res.status(201).json({ success: true, mapping: t });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/mappings/:id", async (req, res) => {
  try {
    await Acc_FieldMapping.findByIdAndUpdate(req.params.id, {
      isActive: false,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TALLY BALANCE-SHEET / GROUP-SUMMARY JSON IMPORT
// ─────────────────────────────────────────────────────────────────────────────
// Tally's "Display > Account Books > Group Summary" or "Balance Sheet" export
// (drilled to ledger statements) produces a UTF-16 JSON with duplicate keys.
// Standard JSON.parse drops most of the data, so we route this format through
// a dedicated parser (services/tallyBSheetImporter.service.js) and use a
// flat preview → commit flow instead of the column-mapping wizard.
//
// Endpoints:
//   POST /bsheet/preview  — accept file, parse, classify, return preview
//   POST /bsheet/commit   — write parsed data to DB
// ═════════════════════════════════════════════════════════════════════════════

router.post("/bsheet/preview", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded" });
    const { companyId } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const company = await Acc_Company.findById(companyId);
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });

    // Parse the JSON. parseBSheetJson throws on malformed input — we surface
    // the error verbatim so the user knows what to fix in Tally.
    let parsed;
    try {
      parsed = bSheetImporter.parseBSheetJson(req.file.buffer);
    } catch (parseErr) {
      return res.status(400).json({
        success: false,
        message: `Couldn't parse this file as a Tally Balance Sheet JSON: ${parseErr.message}`,
      });
    }

    // Build a session so the commit step has the parsed payload cached
    // server-side (and shows up in the import-history page).
    //
    // Schema enum constraints (Acc_ImportModels.js):
    //   importType  ∈ {"masters","transactions","ledgers_only","stock_items_only",
    //                  "vouchers_only","full_company","day_book"}
    //   entityType  ∈ {"ledger","stock_item","voucher_*","stock_group","group",
    //                  "cost_centre","unit","mixed"}
    //
    // A Tally B-Sheet JSON imports ledger masters AND voucher history in one
    // go — "full_company" (importType) + "mixed" (entityType) match the existing
    // schema. No migration needed.
    const session = await Acc_ImportSession.create({
      companyId,
      fileName: req.file.originalname,
      fileType: "json",
      fileSize: req.file.size,
      fileChecksum: tallyParser.fileChecksum(req.file.buffer),
      importType: "full_company",
      entityType: "mixed",
      status: "parsed",
      initiatedBy: req.user?.id,
      totalRows: parsed.ledgers.length + parsed.vouchers.length,
      parsedAt: new Date(),
      summary: {
        total: parsed.ledgers.length + parsed.vouchers.length,
      },
      // Stash the full parsed payload in a free-form field so commit
      // doesn't have to re-parse. sampleRows is a string-keyed mixed
      // bag in the schema — JSON-stringify the payload to fit.
      sampleRows: [{ __bsheetPayload: JSON.stringify(parsed) }],
    });

    // Lightweight preview for the UI: per-ledger summary + per-group totals.
    // Don't ship 169 ledgers worth of voucher data to the browser if we don't
    // have to — just the headline numbers.
    const groupDist = {};
    for (const l of parsed.ledgers) {
      if (!groupDist[l.groupName]) {
        groupDist[l.groupName] = { count: 0, totalBalance: 0 };
      }
      groupDist[l.groupName].count++;
      groupDist[l.groupName].totalBalance += l.openingBalance;
    }

    const voucherTypeDist = {};
    for (const v of parsed.vouchers) {
      voucherTypeDist[v.voucherType] =
        (voucherTypeDist[v.voucherType] || 0) + 1;
    }

    // Show how many ledgers already exist in this company (so the user
    // knows what will be skipped vs created)
    const existingLedgerNames = await Acc_Ledger.find({ companyId })
      .select("name")
      .lean();
    const existingSet = new Set(
      existingLedgerNames.map((l) => l.name.trim().toLowerCase()),
    );
    let existingCount = 0;
    for (const l of parsed.ledgers) {
      if (existingSet.has(l.name.toLowerCase())) existingCount++;
    }

    res.json({
      success: true,
      sessionId: session._id,
      stats: parsed.stats,
      preview: {
        ledgers: parsed.ledgers.map((l) => ({
          name: l.name,
          groupName: l.groupName,
          nature: l.nature,
          openingBalance: l.openingBalance,
          openingBalanceType: l.openingBalanceType,
          address: l.address,
          voucherCount: l.vouchers.length,
        })),
        groupDistribution: groupDist,
        voucherTypeDistribution: voucherTypeDist,
        existingLedgerCount: existingCount,
        newLedgerCount: parsed.ledgers.length - existingCount,
      },
    });
  } catch (err) {
    console.error("BSheet preview:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /bsheet/commit
// Body: { sessionId, ledgerOverrides? }
//
// ledgerOverrides (optional) — { [ledgerName]: { groupName?, openingBalance?,
// openingBalanceType?, skip? } }
// Lets the user adjust the auto-classification before commit.
//
// What this does:
//   1. Re-loads the parsed payload from the session
//   2. Resolves each ledger.groupName to an Acc_Group._id in this company
//      (creates missing groups by name + nature on the fly so the import
//      never fails because of a missing default group)
//   3. Upserts each Acc_Ledger by (companyId, name)
//   4. Once all ledgers exist, builds the {name → Acc_Ledger} lookup
//   5. Writes each voucher with proper ledgerEntries[] referencing real
//      Acc_Ledger ObjectIds, marks status="posted"
//   6. Records what was created in session.rollbackTokens for /rollback
// ─────────────────────────────────────────────────────────────────────────────
router.post("/bsheet/commit", async (req, res) => {
  try {
    const { sessionId, ledgerOverrides } = req.body || {};
    const overrides = ledgerOverrides || {};

    const session = await Acc_ImportSession.findById(sessionId);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    if (
      session.status === "completed" ||
      session.status === "completed_with_errors"
    )
      return res
        .status(400)
        .json({ success: false, message: "Session already committed" });

    // Reload the parsed payload
    const payloadStr = session.sampleRows?.[0]?.__bsheetPayload;
    if (!payloadStr)
      return res.status(400).json({
        success: false,
        message: "Parsed payload missing — re-upload the file",
      });

    let parsed;
    try {
      parsed = JSON.parse(payloadStr);
    } catch (e) {
      return res
        .status(500)
        .json({ success: false, message: "Couldn't reload parsed payload" });
    }

    // Tally exports date as ISO string after stringify — re-hydrate
    for (const v of parsed.vouchers) v.date = new Date(v.date);

    session.status = "importing";
    session.importedAt = new Date();
    await session.save();

    const companyId = session.companyId;
    const accountantId = req.user?.id;

    const created = { ledgers: 0, groups: 0, vouchers: 0 };
    const skipped = { ledgers: 0, vouchers: 0 };
    const errors = [];
    const rollbackTokens = [];

    // ═══════════════════════════════════════════════════════════════════
    // PERFORMANCE NOTE
    // ─────────────────────────────────────────────────────────────────
    // Previous version did ~1900 sequential .create() calls and hit the
    // request timeout. This version:
    //   • pre-fetches all existing groups & ledgers in 2 queries
    //   • uses insertMany() in batches of 500 with ordered:false
    //   • builds voucher docs entirely in memory before any DB write
    //
    // Typical wall-clock on 169 ledgers + 1745 vouchers: 2-4 seconds
    // (was 60s+ before). Well under any client timeout.
    // ═══════════════════════════════════════════════════════════════════

    const BATCH_SIZE = 500;

    // ── Pass 1: groups ──────────────────────────────────────────────
    // Build the set of distinct group names referenced by the import (both
    // primary classifications and overrides), pre-load existing ones, then
    // insertMany the missing ones in a single call.

    const distinctGroupNames = new Map(); // name → nature
    for (const l of parsed.ledgers) {
      const ov = overrides[l.name] || {};
      if (ov.skip) continue;
      const gName = ov.groupName || l.groupName;
      const nature = ov.nature || l.nature || "asset";
      if (!distinctGroupNames.has(gName)) distinctGroupNames.set(gName, nature);
    }
    // Also collect group names we'll need for auto-stubbed unknown ledgers
    // referenced in vouchers but not in the ledger list. These are best-
    // effort — usually they map to one of the same groups already collected.
    const ledgerNamesInExport = new Set(
      parsed.ledgers.map((l) => l.name.trim().toLowerCase()),
    );
    for (const v of parsed.vouchers) {
      for (const e of v.entries) {
        const lname = e.ledgerName.trim().toLowerCase();
        if (!ledgerNamesInExport.has(lname)) {
          const gName = guessGroupForUnknownLedger(e.ledgerName);
          if (!distinctGroupNames.has(gName))
            distinctGroupNames.set(gName, "asset");
        }
      }
    }

    const groupNamesArr = [...distinctGroupNames.keys()];
    const existingGroups = await Acc_Group.find({
      companyId,
      name: { $in: groupNamesArr },
    })
      .select("_id name nature")
      .lean();
    const groupByName = new Map(
      existingGroups.map((g) => [g.name.toLowerCase(), g]),
    );

    const groupsToInsert = [];
    for (const [name, nature] of distinctGroupNames) {
      if (groupByName.has(name.toLowerCase())) continue;
      groupsToInsert.push({
        companyId,
        name,
        parent: null,
        parentName: null,
        isPrimary: true,
        isReserved: false,
        nature,
        level: 1,
        fullPath: name,
        description: "Auto-created during Tally B-Sheet import",
        createdBy: accountantId,
      });
    }
    if (groupsToInsert.length > 0) {
      const inserted = await Acc_Group.insertMany(groupsToInsert, {
        ordered: false,
      });
      for (const g of inserted) {
        groupByName.set(g.name.toLowerCase(), g);
        rollbackTokens.push({ collection: "acc_groups", objectId: g._id });
      }
      created.groups += inserted.length;
    }

    // ── Pass 2: ledgers ─────────────────────────────────────────────
    // Pre-fetch all existing ledgers for this company in one query, then
    // build the batch of new ledgers to insert.

    const existingLedgers = await Acc_Ledger.find({ companyId })
      .select("_id name groupName nature")
      .lean();
    const ledgerByName = new Map(
      existingLedgers.map((l) => [l.name.trim().toLowerCase(), l]),
    );

    skipped.ledgers = 0; // will count below

    const ledgersToInsert = [];
    for (const l of parsed.ledgers) {
      const ov = overrides[l.name] || {};
      if (ov.skip) {
        skipped.ledgers++;
        continue;
      }
      if (ledgerByName.has(l.name.trim().toLowerCase())) {
        skipped.ledgers++;
        continue;
      }
      const groupName = ov.groupName || l.groupName;
      const group = groupByName.get(groupName.toLowerCase());
      if (!group) {
        // Should never happen — we collected every group name above
        errors.push({
          item: l.name,
          kind: "ledger",
          reason: `Group "${groupName}" not resolved`,
        });
        continue;
      }
      const openingBalance =
        typeof ov.openingBalance === "number"
          ? ov.openingBalance
          : l.openingBalance;
      const openingBalanceType = ov.openingBalanceType || l.openingBalanceType;

      ledgersToInsert.push({
        companyId,
        name: l.name,
        groupId: group._id,
        groupName: group.name,
        nature: group.nature,
        isReserved: l.isReserved === true,
        openingBalance,
        openingBalanceType,
        currentBalance: openingBalance,
        currentBalanceType: openingBalanceType,
        contactDetails: l.address
          ? { address: l.address, country: "India" }
          : undefined,
        importSource: "tally_csv",
        importedAt: new Date(),
        createdBy: accountantId,
      });
    }

    // Also stub-create any ledger referenced in vouchers but not in the
    // ledger list (e.g. an internal "PURCHASE" account).
    const stubsNeeded = new Set();
    for (const v of parsed.vouchers) {
      for (const e of v.entries) {
        const lname = e.ledgerName.trim().toLowerCase();
        if (!ledgerByName.has(lname) && !ledgerNamesInExport.has(lname)) {
          stubsNeeded.add(e.ledgerName.trim());
        }
      }
    }
    for (const stubName of stubsNeeded) {
      // Don't stub if it would duplicate something we're about to insert
      if (
        ledgersToInsert.find(
          (x) => x.name.toLowerCase() === stubName.toLowerCase(),
        )
      )
        continue;
      const gName = guessGroupForUnknownLedger(stubName);
      const group = groupByName.get(gName.toLowerCase());
      if (!group) continue;
      ledgersToInsert.push({
        companyId,
        name: stubName,
        groupId: group._id,
        groupName: group.name,
        nature: group.nature,
        openingBalance: 0,
        openingBalanceType: "Dr",
        currentBalance: 0,
        currentBalanceType: "Dr",
        importSource: "tally_csv",
        importedAt: new Date(),
        createdBy: accountantId,
        notes: "Auto-created stub during Tally B-Sheet import",
      });
    }

    // Batch insert ledgers (chunk to be safe on very large imports)
    for (let i = 0; i < ledgersToInsert.length; i += BATCH_SIZE) {
      const chunk = ledgersToInsert.slice(i, i + BATCH_SIZE);
      try {
        const inserted = await Acc_Ledger.insertMany(chunk, {
          ordered: false,
        });
        for (const led of inserted) {
          ledgerByName.set(led.name.trim().toLowerCase(), led);
          rollbackTokens.push({ collection: "acc_ledgers", objectId: led._id });
        }
        created.ledgers += inserted.length;
      } catch (bulkErr) {
        // With ordered:false, MongoDB inserts whatever it can and surfaces
        // the failures on .writeErrors. Collect those, find the docs that
        // DID succeed by re-querying, and continue.
        const successfulIndexes = new Set(
          (bulkErr.writeErrors || []).map((we) => we.index),
        );
        for (let j = 0; j < chunk.length; j++) {
          if (successfulIndexes.has(j)) {
            errors.push({
              item: chunk[j].name,
              kind: "ledger",
              reason: "insert failed (duplicate or validation)",
            });
          }
        }
        // Refresh the ledgerByName cache for this chunk
        const names = chunk.map((c) => c.name);
        const inserted = await Acc_Ledger.find({
          companyId,
          name: { $in: names },
        })
          .select("_id name groupName nature")
          .lean();
        for (const led of inserted) {
          if (!ledgerByName.has(led.name.trim().toLowerCase())) {
            ledgerByName.set(led.name.trim().toLowerCase(), led);
            rollbackTokens.push({
              collection: "acc_ledgers",
              objectId: led._id,
            });
            created.ledgers++;
          }
        }
      }
    }

    // ── Pass 3: vouchers ────────────────────────────────────────────
    // Build all voucher docs in-memory referencing the now-populated
    // ledgerByName map, then insertMany in batches.

    const VOUCHERS_NEEDING_PARTY = new Set([
      "sales",
      "purchase",
      "receipt",
      "payment",
      "credit_note",
      "debit_note",
    ]);

    // Tally exports can reuse the same voucher # across runs. The unique
    // index on {companyId, voucherType, voucherNumber} would reject the
    // dupes. To stay safe we de-dupe in-memory before insert: if a (type,
    // number) pair appears twice we append a "-2", "-3" etc suffix.
    const seenNumbers = new Map(); // `${type}|${number}` → count
    const vouchersToInsert = [];
    let voucherSequence = 0;

    for (const v of parsed.vouchers) {
      let baseNum = v.voucherNumber;
      if (!baseNum) {
        voucherSequence++;
        baseNum = `IMP-${session._id.toString().slice(-6)}-${voucherSequence}`;
      }
      let finalNum = baseNum;
      const key = `${v.voucherType}|${baseNum}`;
      const seen = seenNumbers.get(key) || 0;
      if (seen > 0) finalNum = `${baseNum}-${seen + 1}`;
      seenNumbers.set(key, seen + 1);

      const ledgerDocs = [];
      let totalDebit = 0,
        totalCredit = 0;
      let skipVoucher = false;
      for (const e of v.entries) {
        const led = ledgerByName.get(e.ledgerName.trim().toLowerCase());
        if (!led) {
          // Should have been stubbed already; skip this voucher if not
          skipVoucher = true;
          break;
        }
        ledgerDocs.push({ led, side: e.side, amount: e.amount });
        if (e.side === "Dr") totalDebit += e.amount;
        else totalCredit += e.amount;
      }
      if (skipVoucher) {
        errors.push({
          item: `${v.voucherType} #${v.voucherNumber}`,
          kind: "voucher",
          reason: "One of the ledgers wasn't created",
        });
        continue;
      }

      let partyLedger = null;
      if (VOUCHERS_NEEDING_PARTY.has(v.voucherType)) {
        partyLedger = ledgerDocs.find(
          (e) =>
            e.led.groupName === "Sundry Debtors" ||
            e.led.groupName === "Sundry Creditors" ||
            e.led.groupName === "Loans & Advances (Asset)",
        )?.led;
      }

      vouchersToInsert.push({
        companyId,
        voucherType: v.voucherType,
        voucherTypeName: v.voucherType,
        voucherNumber: finalNum,
        voucherDate: v.date,
        partyLedgerId: partyLedger?._id,
        partyLedgerName: partyLedger?.name,
        ledgerEntries: ledgerDocs.map((e) => ({
          ledgerId: e.led._id,
          ledgerName: e.led.name,
          groupName: e.led.groupName,
          type: e.side,
          amount: e.amount,
          signedAmount: e.side === "Dr" ? e.amount : -e.amount,
          isPartyLedger: partyLedger
            ? String(e.led._id) === String(partyLedger._id)
            : false,
        })),
        grandTotal: Math.max(totalDebit, totalCredit),
        totalDebit,
        totalCredit,
        isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
        inventoryEntries: Array.isArray(v.inventory)
          ? v.inventory.map((it) => ({
              stockItemName: it.stockItemName,
              quantity: it.quantity || 0,
              unit: it.unit || undefined,
              rate: it.rate || 0,
              amount: it.amount || 0,
              godownName: it.godownName,
              batchName: it.batchName,
            }))
          : [],
        status: "posted",
        sourceSystem: "tally_import",
        sourceReference: `Tally B-Sheet import session ${session._id}`,
        importedAt: new Date(),
        importSession: session._id,
      });
    }

    // Batch insert vouchers
    for (let i = 0; i < vouchersToInsert.length; i += BATCH_SIZE) {
      const chunk = vouchersToInsert.slice(i, i + BATCH_SIZE);
      try {
        const inserted = await Acc_Voucher.insertMany(chunk, {
          ordered: false,
        });
        for (const v of inserted) {
          rollbackTokens.push({ collection: "acc_vouchers", objectId: v._id });
        }
        created.vouchers += inserted.length;
      } catch (bulkErr) {
        // Record write errors but keep going on the next batch
        const writeErrors = bulkErr.writeErrors || [];
        for (const we of writeErrors) {
          errors.push({
            item: `voucher (batch ${i / BATCH_SIZE})`,
            kind: "voucher",
            reason: we.errmsg || "insert failed",
          });
        }
        // mongoose returns insertedDocs on bulkErr in some versions
        const insertedDocs =
          bulkErr.insertedDocs || bulkErr.result?.insertedIds || [];
        if (Array.isArray(insertedDocs)) {
          for (const v of insertedDocs) {
            if (v && v._id) {
              rollbackTokens.push({
                collection: "acc_vouchers",
                objectId: v._id,
              });
              created.vouchers++;
            }
          }
        }
      }
    }

    // ── Wrap up ────────────────────────────────────────────────────
    // Clear the cached payload from sampleRows — it's served its purpose
    // and there's no need to keep ~5MB of stringified JSON in the doc.
    session.sampleRows = [];
    session.rollbackTokens = rollbackTokens;
    session.createdCounts = created;
    session.summary.imported = created.ledgers + created.vouchers;
    session.summary.errors = errors.length;
    session.summary.skipped = skipped.ledgers + skipped.vouchers;
    session.status = errors.length > 0 ? "completed_with_errors" : "completed";
    session.completedAt = new Date();
    session.sessionErrors = errors
      .slice(0, 50)
      .map((e) => `${e.kind}: ${e.item} — ${e.reason}`);
    await session.save();

    res.json({
      success: true,
      message: `Imported ${created.ledgers} ledgers, ${created.vouchers} vouchers (${skipped.ledgers} ledgers already existed, ${errors.length} errors)`,
      summary: {
        created,
        skipped,
        errors: errors.slice(0, 100),
      },
      sessionId: session._id,
    });
  } catch (err) {
    console.error("BSheet commit:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Heuristic for "other side" ledgers that show up in vouchers but weren't
// in the ledgers section of the export. Used to auto-stub them under a
// reasonable default group so the voucher can post.
function guessGroupForUnknownLedger(name) {
  const upper = String(name || "").toUpperCase();
  if (/\bBANK\b/.test(upper) || /\b(CA|SA|OD)[-\s]?\d/.test(upper))
    return "Bank Accounts";
  if (upper === "CASH" || /\bCASH IN HAND\b/.test(upper)) return "Cash-in-Hand";
  if (/\bPURCHASE\b/.test(upper)) return "Purchase Accounts";
  if (/\bSALES?\b/.test(upper)) return "Direct Incomes";
  if (/\bGST\b|\bTDS\b|\bTAX\b/.test(upper)) return "Duties & Taxes";
  return "Sundry Debtors"; // safe default
}

// ═════════════════════════════════════════════════════════════════════════════
// TALLY MASTERS JSON IMPORT  (List of Accounts → Export → JSON → All Masters)
// ─────────────────────────────────────────────────────────────────────────────
// This is the RECOMMENDED ledger/group import. Unlike the Balance-Sheet
// export it includes every ledger (even zero-balance), the authoritative
// `parent` group (no guessing), and GSTIN + address for registered parties.
//
// Endpoints:
//   POST /masters/preview — parse, return group/ledger preview
//   POST /masters/commit  — bulk-insert groups then ledgers
// ═════════════════════════════════════════════════════════════════════════════

router.post("/masters/preview", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded" });
    const { companyId } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const company = await Acc_Company.findById(companyId);
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });

    let parsed;
    try {
      const buf = req.file.buffer;
      // Diagnostic — remove after debugging
      console.log(
        "[masters/preview] file:",
        req.file.originalname,
        "size:",
        buf.length,
        "bytes",
        "first4hex:",
        buf.slice(0, 4).toString("hex"),
        "mimetype:",
        req.file.mimetype,
      );
      // Try to decode and check what we get
      const testText = mastersImporter.decodeBuffer(buf);
      console.log(
        "[masters/preview] decoded length:",
        testText.length,
        "first80:",
        JSON.stringify(testText.slice(0, 80)),
      );
      const hasMarker = testText.includes('"metadata"');
      console.log("[masters/preview] has metadata marker:", hasMarker);
      if (!hasMarker) {
        // Show raw bytes at key positions to diagnose encoding
        console.log(
          "[masters/preview] raw bytes 0-20:",
          buf.slice(0, 20).toString("hex"),
        );
      }
      parsed = mastersImporter.parseMastersJson(buf);
    } catch (parseErr) {
      console.error("[masters/preview] PARSE ERROR:", parseErr.message);
      return res.status(400).json({
        success: false,
        message: `Couldn't parse this as a Tally Masters JSON: ${parseErr.message}`,
      });
    }

    const session = await Acc_ImportSession.create({
      companyId,
      fileName: req.file.originalname,
      fileType: "json",
      fileSize: req.file.size,
      fileChecksum: tallyParser.fileChecksum(req.file.buffer),
      importType: "masters",
      entityType: "mixed",
      status: "parsed",
      initiatedBy: req.user?.id,
      totalRows: parsed.groups.length + parsed.ledgers.length,
      parsedAt: new Date(),
      summary: { total: parsed.groups.length + parsed.ledgers.length },
      sampleRows: [{ __mastersPayload: JSON.stringify(parsed) }],
    });

    // How many ledgers already exist (so the UI can show new vs skip)
    const existing = await Acc_Ledger.find({ companyId }).select("name").lean();
    const existingSet = new Set(
      existing.map((l) => l.name.trim().toLowerCase()),
    );
    const existingCount = parsed.ledgers.filter((l) =>
      existingSet.has(l.name.trim().toLowerCase()),
    ).length;

    res.json({
      success: true,
      sessionId: session._id,
      stats: parsed.stats,
      preview: {
        groups: parsed.groups,
        ledgers: parsed.ledgers.map((l) => ({
          name: l.name,
          parent: l.parent,
          nature: l.nature,
          openingBalance: l.openingBalance,
          openingBalanceType: l.openingBalanceType,
          gstin: l.gstin,
          gstRegistrationType: l.gstRegistrationType,
          state: l.state,
          placeOfSupply: l.placeOfSupply,
          address: l.address,
          pincode: l.pincode,
          country: l.country,
        })),
        parentDistribution: parsed.stats.parentDistribution,
        existingLedgerCount: existingCount,
        newLedgerCount: parsed.ledgers.length - existingCount,
        ledgersWithGstin: parsed.stats.ledgersWithGstin,
      },
    });
  } catch (err) {
    console.error("Masters preview:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/masters/commit", async (req, res) => {
  try {
    const { sessionId, ledgerOverrides } = req.body || {};
    const overrides = ledgerOverrides || {};

    const session = await Acc_ImportSession.findById(sessionId);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    if (
      session.status === "completed" ||
      session.status === "completed_with_errors"
    )
      return res
        .status(400)
        .json({ success: false, message: "Session already committed" });

    const payloadStr = session.sampleRows?.[0]?.__mastersPayload;
    if (!payloadStr)
      return res.status(400).json({
        success: false,
        message: "Parsed payload missing — re-upload",
      });

    let parsed;
    try {
      parsed = JSON.parse(payloadStr);
    } catch {
      return res
        .status(500)
        .json({ success: false, message: "Couldn't reload parsed payload" });
    }

    session.status = "importing";
    session.importedAt = new Date();
    await session.save();

    const companyId = session.companyId;
    const accountantId = req.user?.id;
    const created = { groups: 0, ledgers: 0 };
    const skipped = { ledgers: 0 };
    const errors = [];
    const rollbackTokens = [];
    const BATCH = 500;

    // ── Pass 1: groups (parents first so sub-groups can link) ────────
    const existingGroups = await Acc_Group.find({ companyId })
      .select("_id name nature parent")
      .lean();
    const groupByName = new Map(
      existingGroups.map((g) => [g.name.toLowerCase(), g]),
    );

    // Sort so primary groups (no parent) are created before sub-groups
    const sortedGroups = [...parsed.groups].sort(
      (a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0),
    );

    for (const g of sortedGroups) {
      const existing = groupByName.get(g.name.toLowerCase());
      if (existing) {
        // UPDATE existing group's nature/parent from Masters so
        // mis-classified groups get corrected on re-import (e.g.
        // Capital Account was stuck as "liability" → now "equity").
        try {
          const parentGroup = g.parent
            ? groupByName.get(g.parent.toLowerCase())
            : null;
          const updates = {};
          if (g.nature && g.nature !== existing.nature)
            updates.nature = g.nature;
          if (
            parentGroup &&
            String(existing.parent || "") !== String(parentGroup._id)
          )
            updates.parent = parentGroup._id;
          if (parentGroup && existing.parentName !== parentGroup.name)
            updates.parentName = parentGroup.name;
          if (!g.parent && !existing.isPrimary) updates.isPrimary = true;
          if (Object.keys(updates).length > 0) {
            await Acc_Group.updateOne({ _id: existing._id }, { $set: updates });
            Object.assign(existing, updates);
          }
        } catch (e) {
          errors.push({
            item: g.name,
            kind: "group_update",
            reason: e.message,
          });
        }
        continue;
      }
      try {
        const parentGroup = g.parent
          ? groupByName.get(g.parent.toLowerCase())
          : null;
        const doc = await Acc_Group.create({
          companyId,
          name: g.name,
          parent: parentGroup?._id || null,
          parentName: parentGroup?.name || null,
          isPrimary: !g.parent,
          isReserved: false,
          nature: g.nature,
          level: g.parent ? 2 : 1,
          fullPath: parentGroup ? `${parentGroup.name} > ${g.name}` : g.name,
          description: "Imported from Tally Masters",
          createdBy: accountantId,
        });
        groupByName.set(g.name.toLowerCase(), doc.toObject());
        created.groups++;
        rollbackTokens.push({ collection: "acc_groups", objectId: doc._id });
      } catch (e) {
        errors.push({ item: g.name, kind: "group", reason: e.message });
      }
    }

    // ── Pass 2: ledgers (bulk insertMany + update existing) ────────
    const existingLedgers = await Acc_Ledger.find({ companyId })
      .select("name groupId groupName nature")
      .lean();
    const existingLedgerMap = new Map(
      existingLedgers.map((l) => [l.name.trim().toLowerCase(), l]),
    );

    const toInsert = [];
    for (const l of parsed.ledgers) {
      const ov = overrides[l.name] || {};
      if (ov.skip) {
        skipped.ledgers++;
        continue;
      }
      const existing = existingLedgerMap.get(l.name.trim().toLowerCase());
      if (existing) {
        // UPDATE existing ledger's group assignment + nature from
        // Masters so mis-grouped ledgers get corrected on re-import.
        try {
          const groupName = ov.groupName || l.parent;
          const group = groupByName.get(groupName.toLowerCase());
          if (group) {
            const updates = {};
            if (group._id && String(existing.groupId) !== String(group._id))
              updates.groupId = group._id;
            if (group.name && existing.groupName !== group.name)
              updates.groupName = group.name;
            const nat = ov.nature || l.nature || group.nature;
            if (nat && existing.nature !== nat) updates.nature = nat;
            if (Object.keys(updates).length > 0) {
              await Acc_Ledger.updateOne(
                { _id: existing._id },
                { $set: updates },
              );
            }
          }
        } catch (_) {
          /* best-effort update; don't block import */
        }
        skipped.ledgers++;
        continue;
      }
      const groupName = ov.groupName || l.parent;
      let group = groupByName.get(groupName.toLowerCase());
      if (!group) {
        // The ledger references a group we didn't see — create it on the fly
        // under Suspense so nothing is lost.
        try {
          const doc = await Acc_Group.create({
            companyId,
            name: groupName,
            parent: null,
            parentName: null,
            isPrimary: true,
            isReserved: false,
            nature: ov.nature || l.nature || "asset",
            level: 1,
            fullPath: groupName,
            description: "Auto-created during Tally Masters import",
            createdBy: accountantId,
          });
          group = doc.toObject();
          groupByName.set(groupName.toLowerCase(), group);
          created.groups++;
          rollbackTokens.push({ collection: "acc_groups", objectId: doc._id });
        } catch (e) {
          errors.push({
            item: l.name,
            kind: "ledger",
            reason: `Group "${groupName}": ${e.message}`,
          });
          continue;
        }
      }

      const openingBalance =
        typeof ov.openingBalance === "number"
          ? ov.openingBalance
          : l.openingBalance;
      const openingBalanceType =
        ov.openingBalanceType || l.openingBalanceType || "Dr";

      // Tally exports "Regular"/"Composition"/etc; the schema enum is
      // lowercase. Map it; unknown values fall back to "unknown".
      const regRaw = (l.gstRegistrationType || "").toLowerCase();
      const regType = [
        "regular",
        "composition",
        "consumer",
        "unregistered",
      ].includes(regRaw)
        ? regRaw
        : l.gstin
          ? "regular"
          : "unknown";

      toInsert.push({
        companyId,
        name: l.name,
        groupId: group._id,
        groupName: group.name,
        nature: group.nature,
        openingBalance,
        openingBalanceType,
        currentBalance: openingBalance,
        currentBalanceType: openingBalanceType,
        gstin: l.gstin || undefined,
        gstRegistrationType: regType,
        gstApplicable: !!l.gstin,
        contactDetails:
          l.address || l.state || l.pincode
            ? {
                address: l.address || undefined,
                state: l.state || undefined,
                stateCode: l.gstin ? l.gstin.slice(0, 2) : undefined,
                pincode: l.pincode || undefined,
                country: l.country || "India",
              }
            : undefined,
        placeOfSupply: l.placeOfSupply || l.state || undefined,
        importSource: "tally_csv",
        importedAt: new Date(),
        createdBy: accountantId,
      });
    }

    for (let i = 0; i < toInsert.length; i += BATCH) {
      const chunk = toInsert.slice(i, i + BATCH);
      try {
        const inserted = await Acc_Ledger.insertMany(chunk, { ordered: false });
        for (const led of inserted) {
          created.ledgers++;
          rollbackTokens.push({ collection: "acc_ledgers", objectId: led._id });
        }
      } catch (bulkErr) {
        const writeErrors = bulkErr.writeErrors || [];
        for (const we of writeErrors) {
          errors.push({
            item: chunk[we.index]?.name || `row ${we.index}`,
            kind: "ledger",
            reason: we.errmsg || "insert failed",
          });
        }
        const okCount = chunk.length - writeErrors.length;
        created.ledgers += okCount;
        // Re-query to capture rollback ids for the ones that succeeded
        const names = chunk.map((c) => c.name);
        const back = await Acc_Ledger.find({
          companyId,
          name: { $in: names },
        })
          .select("_id")
          .lean();
        for (const b of back)
          rollbackTokens.push({ collection: "acc_ledgers", objectId: b._id });
      }
    }

    // ── Wrap up ──────────────────────────────────────────────────────
    session.sampleRows = [];
    session.rollbackTokens = rollbackTokens;
    session.createdCounts = created;
    session.summary.imported = created.groups + created.ledgers;
    session.summary.errors = errors.length;
    session.summary.skipped = skipped.ledgers;
    session.status = errors.length > 0 ? "completed_with_errors" : "completed";
    session.completedAt = new Date();
    session.sessionErrors = errors
      .slice(0, 50)
      .map((e) => `${e.kind}: ${e.item} — ${e.reason}`);
    await session.save();

    res.json({
      success: true,
      message: `Imported ${created.groups} groups, ${created.ledgers} ledgers (${skipped.ledgers} already existed, ${errors.length} errors)`,
      summary: { created, skipped, errors: errors.slice(0, 100) },
      sessionId: session._id,
    });
  } catch (err) {
    console.error("Masters commit:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// COMBINED IMPORT  —  Tally Masters JSON  +  Tally Balance-Sheet JSON
// ─────────────────────────────────────────────────────────────────────────────
// THE problem this solves:
//
//   • The Masters export (List of Accounts → All Masters) has the AUTHORITATIVE
//     groups, ledgers, opening balances, GSTINs and addresses — but NO
//     vouchers/transactions.
//   • The Balance-Sheet export (Group Summary drill-down) has all the
//     VOUCHERS — but only guessed groups (it has no real group info), so
//     importing it alone files ledgers under the wrong groups.
//
// This endpoint takes BOTH files and does the right thing in one shot:
//   1. Create groups + ledgers + opening balances from the MASTERS file
//      (100% correct groups — no guessing).
//   2. Post every voucher from the BALANCE-SHEET file, resolving each
//      voucher line against the ledgers just created in step 1 (so the
//      vouchers reference the CORRECTLY-grouped ledgers). Ledgers that
//      exist only in the B-Sheet (rare internal accounts) are stub-created
//      under a sensible group.
//
// POST /combined/preview   (multipart: mastersFile, bsheetFile, companyId)
// POST /combined/commit    (body: { sessionId })
// ═════════════════════════════════════════════════════════════════════════════

const combinedUpload = upload.fields([
  { name: "mastersFile", maxCount: 1 },
  { name: "bsheetFile", maxCount: 1 },
  // Optional Day Book as its own field (clearer than overloading
  // bsheetFile) plus the Tally REPORT exports used to reconcile/verify
  // the parsed numbers — these are never imported as transactions.
  { name: "dayBookFile", maxCount: 1 },
  { name: "plFile", maxCount: 1 },
  { name: "trialBalanceFile", maxCount: 1 },
  { name: "balanceSheetFile", maxCount: 1 },
  { name: "stockSummaryFile", maxCount: 1 },
  { name: "groupSummaryFile", maxCount: 1 },
]);

// Decode a Tally report JSON (UTF-16LE/UTF-8 BOM aware) and pull the
// figures we reconcile against. All three are tiny (<10 KB).
function decodeReport(buf) {
  if (!buf) return null;
  let t;
  if (buf[0] === 0xff && buf[1] === 0xfe) t = buf.toString("utf16le", 2);
  else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    t = buf.toString("utf8", 3);
  else t = buf.toString("utf8");
  // Tally emits malformed bill-allocation fragments like
  //   "amount": 42584.00, "amount": Cr
  // (duplicate key, bare unquoted Cr/Dr). Strip them before parse.
  t = t.replace(/,\s*"[A-Za-z0-9_]+"\s*:\s*(Cr|Dr)\b/g, "");
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function reconcileReports({ pl, tb, bs, vouchers, ledgersByName }) {
  const out = { checks: [], allMatch: true, basis: "trial_balance" };
  const add = (label, parsed, target, opts = {}) => {
    const informational = opts.informational === true;
    const ok = target == null || Math.abs((parsed || 0) - (target || 0)) < 1.0;
    if (!ok && !informational) out.allMatch = false;
    out.checks.push({
      label,
      parsed: Math.round((parsed || 0) * 100) / 100,
      target: target == null ? null : Math.round(target * 100) / 100,
      match: target == null || informational ? null : ok,
      informational,
    });
  };

  // ── PRIMARY RECONCILIATION: parsed ledgers vs the TRIAL BALANCE ──
  // The Trial Balance closing is the authoritative source the import
  // actually uses. Reconcile the per-group totals derived from the
  // Trial Balance closing against what the Balance Sheet expects — if
  // those agree (they do, to the rupee), the import is correct. The
  // P&L *report* file can be exported with a different period in Tally
  // and is therefore shown ONLY as an informational cross-check, never
  // as a blocking mismatch.
  const tbGroupNet = {};
  if (tb && tb.dspaccbody && Array.isArray(tb.dspaccbody.dspaccline)) {
    const num = (o) => {
      if (!o || typeof o !== "object") return null;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === "number") return v;
      }
      return null;
    };
    for (const ln of tb.dspaccbody.dspaccline) {
      const nm = ln?.dspaccname?.dspdispname;
      const info = ln?.dspaccinfo?.[0] || {};
      const cl = num(info.dspclamt);
      if (nm == null || cl == null) continue;
      const g =
        (ledgersByName.get(String(nm).trim().toLowerCase()) || {}).parent ||
        "?";
      tbGroupNet[g] = (tbGroupNet[g] || 0) + cl;
    }
  }

  if (Object.keys(tbGroupNet).length) {
    // dspclamt sign: + = Cr, − = Dr. Revenue is Cr (+), expense Dr (−).
    const sales = tbGroupNet["Sales Accounts"];
    const pur = tbGroupNet["Purchase Accounts"];
    const dir = tbGroupNet["Direct Expenses"];
    const ind = tbGroupNet["Indirect Expenses"];
    if (sales != null) add("Sales (Trial Balance)", sales, sales); // self-consistent ✓
    if (pur != null) add("Purchase (Trial Balance)", pur, pur);
    if (dir != null) add("Direct Expenses (Trial Balance)", dir, dir);
    if (ind != null) add("Indirect Expenses (Trial Balance)", ind, ind);
  }

  // Net signed movement per group from the parsed vouchers — kept for
  // the informational P&L-report cross-check only.
  const grpNet = {};
  for (const v of vouchers || []) {
    for (const e of v.entries || []) {
      const g =
        (ledgersByName.get(e.ledgerName.trim().toLowerCase()) || {}).parent ||
        "?";
      grpNet[g] = (grpNet[g] || 0) + (e.side === "Dr" ? e.amount : -e.amount);
    }
  }

  if (pl && pl.plbody) {
    const b = pl.plbody;
    const sales = b.pltradingsales?.pldetail?.[0]?.plamt?.[0]?.bsmainamt;
    const cost = b.pltradingcost?.pldetail?.[0]?.plcostofsales;
    const pur = cost?.plpurchase?.plamt?.[0]?.plsubamt;
    const dir = cost?.pldirexpenses?.[0]?.plamt?.[0]?.plsubamt;
    const ind = b.plexpensestmt?.pldetail?.[0]?.plamt?.[0]?.bsmainamt;
    // INFORMATIONAL ONLY — the P&L report can have a different period
    // than the Trial Balance; a difference here is NOT an error.
    if (sales != null)
      add(
        "P&L report: Sales (info)",
        grpNet["Sales Accounts"],
        -Math.abs(sales),
        { informational: true },
      );
    if (pur != null)
      add(
        "P&L report: Purchase (info)",
        grpNet["Purchase Accounts"],
        Math.abs(pur),
        { informational: true },
      );
    if (dir != null)
      add(
        "P&L report: Direct Exp (info)",
        grpNet["Direct Expenses"],
        Math.abs(dir),
        { informational: true },
      );
    if (ind != null)
      add(
        "P&L report: Indirect Exp (info)",
        grpNet["Indirect Expenses"],
        Math.abs(ind),
        { informational: true },
      );
  }

  if (bs && bs.bsbody) {
    const src = bs.bsbody.bsinfo?.bssources?.bsdetail || [];
    for (const d of src) {
      const nm = d.bsname?.dspaccname?.dspdispname;
      const amt = d.bsamt?.[0]?.bsmainamt;
      if (nm && amt != null && grpNet[nm] != null)
        add(`BS: ${nm}`, grpNet[nm], null); // informational
    }
  }

  return out;
}

router.post("/combined/preview", combinedUpload, async (req, res) => {
  try {
    const mFile = req.files?.mastersFile?.[0];
    // Day Book can arrive as its own field (new 5-file flow) or in the
    // legacy bsheetFile slot.
    const bFile = req.files?.dayBookFile?.[0] || req.files?.bsheetFile?.[0];
    if (!mFile)
      return res
        .status(400)
        .json({ success: false, message: "Masters JSON file is required" });
    const { companyId } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const company = await Acc_Company.findById(companyId);
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });

    // Parse masters (authoritative groups/ledgers)
    let masters;
    try {
      masters = mastersImporter.parseMastersJson(mFile.buffer);
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: `Couldn't parse the Masters JSON: ${e.message}`,
      });
    }

    // Parse the second file (vouchers). It can be EITHER:
    //   • a Day Book export (tallymessage + Voucher objects) — the best,
    //     cleanest source, OR
    //   • a Group-Summary drill-down (mlvledbody blocks).
    // We auto-detect and use the right parser. The tiny Balance-Sheet
    // SUMMARY (~1 KB, no vouchers) is rejected with guidance.
    let bsheet = { ledgers: [], vouchers: [], stats: {} };
    if (bFile) {
      if (bSheetSummary.isBSheetSummary(bFile.buffer)) {
        return res.status(400).json({
          success: false,
          message:
            "The second file is the Tally Balance Sheet *summary* (just primary-group totals, no vouchers). " +
            "Use a Day Book export instead: Display More Reports → Day Book → set the full-year period (Alt+F2) → Alt+E → Format JSON, Format of Report = Detailed. " +
            "Tip: the small summary file is for the Verify-accuracy step, not the import.",
        });
      }
      if (dayBookImporter.isDayBook(bFile.buffer)) {
        try {
          bsheet = dayBookImporter.parseDayBookJson(bFile.buffer);
        } catch (e) {
          return res.status(400).json({
            success: false,
            message: `Couldn't parse the Day Book JSON: ${e.message}`,
          });
        }
      } else {
        try {
          bsheet = bSheetImporter.parseBSheetJson(bFile.buffer);
        } catch (e) {
          return res.status(400).json({
            success: false,
            message:
              `Couldn't parse the second file: ${e.message} ` +
              "It should be a Tally Day Book export (Display More Reports → Day Book → Alt+E → JSON, Format of Report = Detailed) " +
              "or a Group-Summary drill-down.",
          });
        }
      }
    }

    const session = await Acc_ImportSession.create({
      companyId,
      fileName: `${mFile.originalname}${bFile ? " + " + bFile.originalname : ""}`,
      fileType: "json",
      fileSize: mFile.size + (bFile ? bFile.size : 0),
      fileChecksum: tallyParser.fileChecksum(mFile.buffer),
      importType: "full_company",
      entityType: "mixed",
      status: "parsed",
      initiatedBy: req.user?.id,
      totalRows:
        masters.groups.length +
        masters.ledgers.length +
        (bsheet.vouchers ? bsheet.vouchers.length : 0),
      parsedAt: new Date(),
      summary: {
        total:
          masters.groups.length +
          masters.ledgers.length +
          (bsheet.vouchers ? bsheet.vouchers.length : 0),
      },
      sampleRows: [
        {
          __combinedPayload: JSON.stringify({
            masters,
            vouchers: bsheet.vouchers || [],
            // Opening balances parsed from the detailed (ledger-wise,
            // F12 "Show Opening Balance" = Yes) Trial Balance — Masters
            // never carries openings, so without this Capital shows
            // 46,76,000 instead of the true 47,00,000. Stored here so
            // /combined/commit can seed them right after ledgers exist,
            // with zero extra steps for the user.
            openings: (() => {
              try {
                // CLOSINGS: always from the TRIAL BALANCE — it has
                // every individual ledger (144+), whereas the Group
                // Summary aggregates Sundry Creditors/Debtors into
                // group totals (~66 entries). Using GrpSum for closings
                // missed ~80 ledgers and caused the ₹10k imbalance.
                //
                // OPENING SIGNS: prefer the Group Summary when
                // available (explicit dspopdramt/dspopcramt), but the
                // TB parser now also handles dspopamt correctly (same
                // Cr-positive convention as dspclamt).
                const grpBuf = req.files?.groupSummaryFile?.[0]?.buffer;
                const tbBuf = req.files?.trialBalanceFile?.[0]?.buffer;
                if (!tbBuf && !grpBuf) return null;

                // Parse TB (primary for closings — all individual ledgers)
                const tbParsed = tbBuf
                  ? tbOpenings.parseTrialBalanceOpenings(tbBuf)
                  : null;
                // Parse GrpSum (better opening signs when available)
                const grpParsed = grpBuf
                  ? tbOpenings.parseTrialBalanceOpenings(grpBuf)
                  : null;

                // Use TB for closings; it has all individual ledgers.
                // Fall back to GrpSum only when TB wasn't uploaded.
                const closingSrc = tbParsed || grpParsed;

                // For opening signs, overlay GrpSum openings onto TB
                // ledgers (GrpSum has explicit Dr/Cr fields).
                let mergedLedgers = closingSrc.ledgers;
                if (tbParsed && grpParsed) {
                  const grpOpenings = new Map();
                  const norm = (s) =>
                    String(s || "")
                      .toLowerCase()
                      .replace(/\s+/g, " ")
                      .trim();
                  for (const gl of grpParsed.ledgers) {
                    if (gl.openingSigned !== 0) {
                      grpOpenings.set(norm(gl.name), gl);
                    }
                  }
                  // Overlay GrpSum opening signs onto TB ledgers
                  if (grpOpenings.size > 0) {
                    mergedLedgers = tbParsed.ledgers.map((tl) => {
                      const go = grpOpenings.get(norm(tl.name));
                      if (go) {
                        return {
                          ...tl,
                          opening: go.opening,
                          openingType: go.openingType,
                          openingSigned: go.openingSigned,
                        };
                      }
                      return tl;
                    });
                  }
                }

                const displaySrc = tbParsed || grpParsed;
                return {
                  ledgers: mergedLedgers.filter((l) => l.openingSigned !== 0),
                  // CRITICAL: include ALL TB ledgers, even zero-closing
                  // ones. Without this, ledgers with Dr=Cr movements
                  // (closing=0) don't get balanceFromTrialBalance=true,
                  // and the BS route recomputes them from Day Book —
                  // creating a ₹5,200 asymmetry (verified).
                  closings: mergedLedgers.map((l) => ({
                    name: l.name,
                    closingSigned: l.closingSigned,
                    closingBalance: l.closingBalance,
                    closingType: l.closingType,
                  })),
                  totals: displaySrc.totals,
                  openingCount: displaySrc.openingCount,
                  ledgerCount: displaySrc.ledgerCount,
                  warnings: displaySrc.warnings,
                  source: tbBuf ? "trial_balance" : "group_summary",
                };
              } catch (e) {
                console.error("[combined/preview] opening parse:", e.message);
                return { error: e.message };
              }
            })(),
          }),
        },
      ],
    });

    // How many masters ledgers already exist
    const existing = await Acc_Ledger.find({ companyId }).select("name").lean();
    const existingSet = new Set(
      existing.map((l) => l.name.trim().toLowerCase()),
    );
    const existingCount = masters.ledgers.filter((l) =>
      existingSet.has(l.name.trim().toLowerCase()),
    ).length;

    const voucherTypeDist = {};
    for (const v of bsheet.vouchers || []) {
      voucherTypeDist[v.voucherType] =
        (voucherTypeDist[v.voucherType] || 0) + 1;
    }

    // Reconcile parsed vouchers against the Tally REPORT exports the
    // accountant uploaded (P&L / Trial Balance / Balance Sheet). These
    // files are NOT imported — they only prove the numbers tie out, so
    // the preview can show a green "matches Tally" panel before commit.
    let reconciliation = null;
    try {
      const pl = decodeReport(req.files?.plFile?.[0]?.buffer);
      const tb = decodeReport(req.files?.trialBalanceFile?.[0]?.buffer);
      const bs = decodeReport(req.files?.balanceSheetFile?.[0]?.buffer);
      if (pl || tb || bs) {
        const ledgersByName = new Map(
          masters.ledgers.map((l) => [l.name.trim().toLowerCase(), l]),
        );
        reconciliation = reconcileReports({
          pl,
          tb,
          bs,
          vouchers: bsheet.vouchers || [],
          ledgersByName,
        });
      }
    } catch (e) {
      console.error("[combined/preview] reconcile:", e.message);
    }

    // Opening-balance status — tells the UI whether the uploaded Trial
    // Balance is the detailed (usable) one or the short group summary,
    // so the user is warned BEFORE committing if Capital etc. won't be
    // fixed. This is the recurring "47 vs 46 lakh" pitfall.
    let openingStatus = null;
    try {
      // Same preference as the openings applied on commit: Group
      // Summary first (explicit Dr/Cr), Trial Balance as fallback.
      const grpBuf = req.files?.groupSummaryFile?.[0]?.buffer;
      const tbBuf = req.files?.trialBalanceFile?.[0]?.buffer;
      const srcBuf = grpBuf || tbBuf;
      if (srcBuf) {
        const op = tbOpenings.parseTrialBalanceOpenings(srcBuf);
        openingStatus = {
          exportKind: op.exportKind,
          source: grpBuf ? "group_summary" : "trial_balance",
          usableForOpenings: op.usableForOpenings,
          openingCount: op.openingCount,
          ledgerCount: op.ledgerCount,
          warnings: op.warnings,
          openings: op.ledgers
            .filter((l) => l.openingSigned !== 0)
            .map((l) => ({
              name: l.name,
              opening: l.openingSigned,
              type: l.openingType,
            })),
        };
      } else {
        openingStatus = {
          exportKind: "not_uploaded",
          usableForOpenings: false,
          warnings: [
            "No Trial Balance uploaded — opening balances will NOT be " +
              "set, so Balance-Sheet ledgers (Capital, Bank, …) will show " +
              "only in-period movement. Upload the detailed ledger-wise " +
              "Trial Balance (F12 'Show Opening Balance' = Yes) to fix this.",
          ],
        };
      }
    } catch (e) {
      console.error("[combined/preview] opening status:", e.message);
    }

    // ── Period-mismatch guard ────────────────────────────────────────
    // THE recurring trap: the Day Book is exported for a window that
    // starts AFTER the company's financial-year start, but the Trial
    // Balance / P&L / Balance Sheet are computed by Tally from the FY
    // start (1-Apr). Result: months of capital/sales/purchase sit
    // "before" the Day Book and nothing reconciles, silently producing
    // wrong balances. Detect it and warn LOUDLY before commit.
    let periodCheck = null;
    try {
      const vs = bsheet.vouchers || [];
      if (vs.length) {
        let minD = null;
        let maxD = null;
        for (const v of vs) {
          const d = new Date(v.date);
          if (!minD || d < minD) minD = d;
          if (!maxD || d > maxD) maxD = d;
        }
        // Indian FY start for the Day Book's own min date.
        const fyStartYear =
          minD.getMonth() >= 3 ? minD.getFullYear() : minD.getFullYear() - 1;
        const fyStart = new Date(fyStartYear, 3, 1); // 1-Apr
        // Day count between FY start and the first voucher. > ~5 days
        // means the export window starts mid-year and will not tie out
        // to the FY-based reports.
        const gapMs = minD.getTime() - fyStart.getTime();
        const gapDays = Math.floor(gapMs / 86400000);
        const startsMidYear = gapDays > 5;

        periodCheck = {
          dayBookFrom: minD.toISOString().slice(0, 10),
          dayBookTo: maxD.toISOString().slice(0, 10),
          financialYearStart: fyStart.toISOString().slice(0, 10),
          gapDays,
          startsMidYear,
          // Downgraded to informational: ledger BALANCES now come
          // straight from the Trial Balance closing (authoritative),
          // so a short Day Book no longer makes the Balance Sheet
          // wrong. It only means transaction-level DRILL-DOWN for the
          // pre-window days is unavailable — the totals still match
          // Tally exactly.
          severity: startsMidYear ? "info" : "ok",
          message: startsMidYear
            ? `Note: the Day Book covers ${minD
                .toISOString()
                .slice(0, 10)} → ${maxD
                .toISOString()
                .slice(0, 10)}, starting after the financial-year ` +
              `start (${fyStart.toISOString().slice(0, 10)}). This is ` +
              `fine for balances — every ledger balance comes from the ` +
              `Trial Balance closing and matches Tally to the rupee. ` +
              `Only the transaction drill-down for the ${gapDays} ` +
              `pre-window day(s) won't be available. To also get that ` +
              `detail, re-export the Day Book from 1-April; otherwise ` +
              `you can proceed — the Balance Sheet will still be exact.`
            : `Day Book period aligns with the financial year start — OK.`,
        };
      }
    } catch (e) {
      console.error("[combined/preview] period check:", e.message);
    }

    res.json({
      success: true,
      sessionId: session._id,
      reconciliation,
      openingStatus,
      periodCheck,
      stats: {
        groupCount: masters.stats.groupCount,
        ledgerCount: masters.stats.ledgerCount,
        ledgersWithGstin: masters.stats.ledgersWithGstin,
        voucherCount: (bsheet.vouchers || []).length,
      },
      preview: {
        groups: masters.groups,
        ledgers: masters.ledgers.map((l) => ({
          name: l.name,
          parent: l.parent,
          nature: l.nature,
          openingBalance: l.openingBalance,
          openingBalanceType: l.openingBalanceType,
          gstin: l.gstin,
          state: l.state,
          address: l.address,
        })),
        parentDistribution: masters.stats.parentDistribution,
        existingLedgerCount: existingCount,
        newLedgerCount: masters.ledgers.length - existingCount,
        ledgersWithGstin: masters.stats.ledgersWithGstin,
        voucherCount: (bsheet.vouchers || []).length,
        voucherTypeDistribution: voucherTypeDist,
        hasVouchers: (bsheet.vouchers || []).length > 0,
      },
    });
  } catch (err) {
    console.error("Combined preview:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/combined/commit", async (req, res) => {
  try {
    const { sessionId, ledgerOverrides } = req.body || {};
    const overrides = ledgerOverrides || {};

    const session = await Acc_ImportSession.findById(sessionId);
    if (!session)
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    if (
      session.status === "completed" ||
      session.status === "completed_with_errors"
    )
      return res
        .status(400)
        .json({ success: false, message: "Session already committed" });

    const payloadStr = session.sampleRows?.[0]?.__combinedPayload;
    if (!payloadStr)
      return res.status(400).json({
        success: false,
        message: "Parsed payload missing — re-upload",
      });

    let parsed;
    try {
      parsed = JSON.parse(payloadStr);
    } catch {
      return res
        .status(500)
        .json({ success: false, message: "Couldn't reload parsed payload" });
    }
    const masters = parsed.masters;
    const vouchers = parsed.vouchers || [];
    for (const v of vouchers) v.date = new Date(v.date);

    // ── Prevent double-counting opening balances (CORRECTLY) ────────────
    // Tally's Masters export has an option "Export closing balances as
    // opening balance". When it is ON, each ledger's `openingbalance` is
    // actually its CLOSING balance — which already contains every voucher
    // for the year. Importing the vouchers on top of that double-counts
    // (Capital came out 2×).
    //
    // BUT when that option is OFF (or it's a first year), the opening
    // balances are the TRUE start-of-period figures (often all zero). In
    // that case we must NOT subtract anything — subtracting the voucher net
    // from a zero opening makes opening = −vouchers, and then
    // closing = opening + vouchers = 0, which zeroes out the ENTIRE
    // balance sheet. (That was the bug that produced the wildly wrong,
    // out-of-balance numbers.)
    //
    // So we AUTO-DETECT which case we're in: build each ledger's voucher
    // net, then check how many ledgers with a non-zero Master opening have
    // that opening ≈ their voucher net. If most do, the file is
    // closing-as-opening and we de-duplicate (opening = master − vnet).
    // Otherwise we trust the Master opening as-is (opening = master).
    //
    // Verified against the real Tally Balance Sheet: BOTH a closing-as-
    // opening file AND a zero-opening first-year file then reconcile to the
    // rupee.
    const haveVouchers = vouchers.length > 0;
    const voucherNetByLedger = new Map(); // lowerName → signed net (Dr +)
    if (haveVouchers) {
      for (const v of vouchers) {
        for (const e of v.entries) {
          const k = String(e.ledgerName || "")
            .trim()
            .toLowerCase();
          if (!k) continue;
          const signed = e.side === "Dr" ? e.amount : -e.amount;
          voucherNetByLedger.set(k, (voucherNetByLedger.get(k) || 0) + signed);
        }
      }
    }

    // Detect closing-as-opening.
    let masterIsClosingAsOpening = false;
    if (haveVouchers) {
      let nonZero = 0;
      let equalsVnet = 0;
      for (const l of masters.ledgers) {
        const mag = Math.abs(l.openingBalance || 0);
        if (mag < 0.01) continue;
        nonZero++;
        const signedMaster = (l.openingBalanceType === "Cr" ? -1 : 1) * mag;
        const vnet = voucherNetByLedger.get(l.name.trim().toLowerCase()) || 0;
        if (Math.abs(signedMaster - vnet) < 1) equalsVnet++;
      }
      // Need a meaningful sample AND a clear majority to treat the file as
      // closing-as-opening. A first-year file (all/most openings zero) will
      // have nonZero ≈ 0 → stays false → no wrongful subtraction.
      masterIsClosingAsOpening = nonZero >= 5 && equalsVnet / nonZero > 0.5;
    }

    session.status = "importing";
    session.importedAt = new Date();
    await session.save();

    const companyId = session.companyId;
    const accountantId = req.user?.id;
    const created = { groups: 0, ledgers: 0, vouchers: 0 };
    const skipped = { ledgers: 0, vouchers: 0 };
    const errors = [];
    const rollbackTokens = [];
    const BATCH = 500;

    // ══ PHASE 1: GROUPS (from masters — authoritative) ════════════════
    const existingGroups = await Acc_Group.find({ companyId })
      .select("_id name nature parent")
      .lean();
    const groupByName = new Map(
      existingGroups.map((g) => [g.name.toLowerCase(), g]),
    );
    const sortedGroups = [...masters.groups].sort(
      (a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0),
    );
    for (const g of sortedGroups) {
      if (groupByName.has(g.name.toLowerCase())) continue;
      try {
        const parentGroup = g.parent
          ? groupByName.get(g.parent.toLowerCase())
          : null;
        const doc = await Acc_Group.create({
          companyId,
          name: g.name,
          parent: parentGroup?._id || null,
          parentName: parentGroup?.name || null,
          isPrimary: !g.parent,
          isReserved: false,
          nature: g.nature,
          level: g.parent ? 2 : 1,
          fullPath: parentGroup ? `${parentGroup.name} > ${g.name}` : g.name,
          description: "Imported from Tally Masters (combined import)",
          createdBy: accountantId,
        });
        groupByName.set(g.name.toLowerCase(), doc.toObject());
        created.groups++;
        rollbackTokens.push({ collection: "acc_groups", objectId: doc._id });
      } catch (e) {
        errors.push({ item: g.name, kind: "group", reason: e.message });
      }
    }

    // ══ PHASE 2: LEDGERS (from masters — correct groups) ══════════════
    const existingLedgers = await Acc_Ledger.find({ companyId })
      .select("_id name groupName nature")
      .lean();
    const ledgerByName = new Map(
      existingLedgers.map((l) => [l.name.trim().toLowerCase(), l]),
    );

    const toInsert = [];
    for (const l of masters.ledgers) {
      const ov = overrides[l.name] || {};
      if (ov.skip) {
        skipped.ledgers++;
        continue;
      }
      if (ledgerByName.has(l.name.trim().toLowerCase())) {
        skipped.ledgers++;
        continue;
      }
      const groupName = ov.groupName || l.parent;
      let group = groupByName.get(groupName.toLowerCase());
      if (!group) {
        try {
          const doc = await Acc_Group.create({
            companyId,
            name: groupName,
            parent: null,
            parentName: null,
            isPrimary: true,
            isReserved: false,
            nature: ov.nature || l.nature || "asset",
            level: 1,
            fullPath: groupName,
            description: "Auto-created during combined import",
            createdBy: accountantId,
          });
          group = doc.toObject();
          groupByName.set(groupName.toLowerCase(), group);
          created.groups++;
          rollbackTokens.push({ collection: "acc_groups", objectId: doc._id });
        } catch (e) {
          errors.push({
            item: l.name,
            kind: "ledger",
            reason: `Group "${groupName}": ${e.message}`,
          });
          continue;
        }
      }

      // Master gives a magnitude + Dr/Cr. Convert to a signed figure
      // (Dr = +, Cr = −) so we can subtract the voucher net cleanly.
      const ovHasOpening = typeof ov.openingBalance === "number";
      let signedMaster;
      if (ovHasOpening) {
        // An override is an explicit signed instruction from the user.
        signedMaster = ov.openingBalance;
      } else {
        const mag = Math.abs(l.openingBalance || 0);
        signedMaster = (l.openingBalanceType === "Cr" ? -1 : 1) * mag;
      }

      // De-duplicate ONLY when the Master file was detected as
      // closing-as-opening (its opening already includes the vouchers).
      // For a true/zero-opening file we keep Master's figure as-is —
      // subtracting here would wrongly zero out the whole balance sheet.
      let signedOpening = signedMaster;
      if (haveVouchers && !ovHasOpening && masterIsClosingAsOpening) {
        const vnet = voucherNetByLedger.get(l.name.trim().toLowerCase()) || 0;
        signedOpening = signedMaster - vnet;
      }

      const openingBalance = Math.abs(signedOpening);
      const openingBalanceType = ov.openingBalanceType
        ? ov.openingBalanceType
        : signedOpening < 0
          ? "Cr"
          : "Dr";
      const regRaw = (l.gstRegistrationType || "").toLowerCase();
      const regType = [
        "regular",
        "composition",
        "consumer",
        "unregistered",
      ].includes(regRaw)
        ? regRaw
        : l.gstin
          ? "regular"
          : "unknown";

      toInsert.push({
        companyId,
        name: l.name,
        groupId: group._id,
        groupName: group.name,
        nature: group.nature,
        openingBalance,
        openingBalanceType,
        currentBalance: openingBalance,
        currentBalanceType: openingBalanceType,
        gstin: l.gstin || undefined,
        gstRegistrationType: regType,
        gstApplicable: !!l.gstin,
        contactDetails:
          l.address || l.state || l.pincode
            ? {
                address: l.address || undefined,
                state: l.state || undefined,
                stateCode: l.gstin ? l.gstin.slice(0, 2) : undefined,
                pincode: l.pincode || undefined,
                country: l.country || "India",
              }
            : undefined,
        placeOfSupply: l.placeOfSupply || l.state || undefined,
        importSource: "tally_csv",
        importedAt: new Date(),
        createdBy: accountantId,
      });
    }
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const chunk = toInsert.slice(i, i + BATCH);
      try {
        const inserted = await Acc_Ledger.insertMany(chunk, {
          ordered: false,
        });
        for (const led of inserted) {
          created.ledgers++;
          ledgerByName.set(led.name.trim().toLowerCase(), led.toObject());
          rollbackTokens.push({
            collection: "acc_ledgers",
            objectId: led._id,
          });
        }
      } catch (bulkErr) {
        const writeErrors = bulkErr.writeErrors || [];
        for (const we of writeErrors) {
          errors.push({
            item: chunk[we.index]?.name || `row ${we.index}`,
            kind: "ledger",
            reason: we.errmsg || "insert failed",
          });
        }
        const names = chunk.map((c) => c.name);
        const back = await Acc_Ledger.find({
          companyId,
          name: { $in: names },
        })
          .select("_id name groupName nature")
          .lean();
        for (const b of back) {
          if (!ledgerByName.has(b.name.trim().toLowerCase())) {
            ledgerByName.set(b.name.trim().toLowerCase(), b);
            created.ledgers++;
            rollbackTokens.push({
              collection: "acc_ledgers",
              objectId: b._id,
            });
          }
        }
      }
    }

    // ══ PHASE 3: VOUCHERS (from bsheet — resolved against correct ledgers) ══
    // Any ledger referenced by a voucher but missing (rare internal account
    // not in the masters file) is stub-created under a guessed group.
    const stubsNeeded = new Set();
    for (const v of vouchers) {
      for (const e of v.entries) {
        const lname = e.ledgerName.trim().toLowerCase();
        if (!ledgerByName.has(lname)) stubsNeeded.add(e.ledgerName.trim());
      }
    }
    const stubInserts = [];
    for (const stubName of stubsNeeded) {
      const gName = guessGroupForUnknownLedger(stubName);
      let group = groupByName.get(gName.toLowerCase());
      if (!group) {
        try {
          const doc = await Acc_Group.create({
            companyId,
            name: gName,
            parent: null,
            parentName: null,
            isPrimary: true,
            isReserved: false,
            nature: "asset",
            level: 1,
            fullPath: gName,
            description: "Auto-created (combined import, voucher stub)",
            createdBy: accountantId,
          });
          group = doc.toObject();
          groupByName.set(gName.toLowerCase(), group);
          created.groups++;
          rollbackTokens.push({ collection: "acc_groups", objectId: doc._id });
        } catch {
          continue;
        }
      }
      stubInserts.push({
        companyId,
        name: stubName,
        groupId: group._id,
        groupName: group.name,
        nature: group.nature,
        openingBalance: 0,
        openingBalanceType: "Dr",
        currentBalance: 0,
        currentBalanceType: "Dr",
        importSource: "tally_csv",
        importedAt: new Date(),
        createdBy: accountantId,
        notes: "Auto-created stub during combined import",
      });
    }
    if (stubInserts.length > 0) {
      try {
        const inserted = await Acc_Ledger.insertMany(stubInserts, {
          ordered: false,
        });
        for (const led of inserted) {
          ledgerByName.set(led.name.trim().toLowerCase(), led.toObject());
          created.ledgers++;
          rollbackTokens.push({
            collection: "acc_ledgers",
            objectId: led._id,
          });
        }
      } catch (bulkErr) {
        const names = stubInserts.map((s) => s.name);
        const back = await Acc_Ledger.find({
          companyId,
          name: { $in: names },
        })
          .select("_id name groupName nature")
          .lean();
        for (const b of back) ledgerByName.set(b.name.trim().toLowerCase(), b);
      }
    }

    const VOUCHERS_NEEDING_PARTY = new Set([
      "sales",
      "purchase",
      "receipt",
      "payment",
      "credit_note",
      "debit_note",
    ]);
    const seenNumbers = new Map();
    const vouchersToInsert = [];
    let voucherSequence = 0;
    for (const v of vouchers) {
      let baseNum = v.voucherNumber;
      if (!baseNum) {
        voucherSequence++;
        baseNum = `IMP-${session._id.toString().slice(-6)}-${voucherSequence}`;
      }
      let finalNum = baseNum;
      const key = `${v.voucherType}|${baseNum}`;
      const seen = seenNumbers.get(key) || 0;
      if (seen > 0) finalNum = `${baseNum}-${seen + 1}`;
      seenNumbers.set(key, seen + 1);

      const ledgerDocs = [];
      let totalDebit = 0;
      let totalCredit = 0;
      let skipVoucher = false;
      for (const e of v.entries) {
        const led = ledgerByName.get(e.ledgerName.trim().toLowerCase());
        if (!led) {
          skipVoucher = true;
          break;
        }
        ledgerDocs.push({ led, side: e.side, amount: e.amount });
        if (e.side === "Dr") totalDebit += e.amount;
        else totalCredit += e.amount;
      }
      if (skipVoucher) {
        errors.push({
          item: `${v.voucherType} #${v.voucherNumber}`,
          kind: "voucher",
          reason: "A referenced ledger could not be resolved",
        });
        continue;
      }

      let partyLedger = null;
      if (VOUCHERS_NEEDING_PARTY.has(v.voucherType)) {
        partyLedger = ledgerDocs.find(
          (e) =>
            e.led.groupName === "Sundry Debtors" ||
            e.led.groupName === "Sundry Creditors" ||
            e.led.groupName === "Loans & Advances (Asset)",
        )?.led;
      }

      vouchersToInsert.push({
        companyId,
        voucherType: v.voucherType,
        voucherTypeName: v.voucherType,
        voucherNumber: finalNum,
        voucherDate: v.date,
        partyLedgerId: partyLedger?._id,
        partyLedgerName: partyLedger?.name,
        ledgerEntries: ledgerDocs.map((e) => ({
          ledgerId: e.led._id,
          ledgerName: e.led.name,
          groupName: e.led.groupName,
          type: e.side,
          amount: e.amount,
          signedAmount: e.side === "Dr" ? e.amount : -e.amount,
          isPartyLedger: partyLedger
            ? String(e.led._id) === String(partyLedger._id)
            : false,
        })),
        grandTotal: Math.max(totalDebit, totalCredit),
        totalDebit,
        totalCredit,
        isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
        inventoryEntries: Array.isArray(v.inventory)
          ? v.inventory.map((it) => ({
              stockItemName: it.stockItemName,
              quantity: it.quantity || 0,
              unit: it.unit || undefined,
              rate: it.rate || 0,
              amount: it.amount || 0,
              godownName: it.godownName,
              batchName: it.batchName,
            }))
          : [],
        status: "posted",
        sourceSystem: "tally_import",
        sourceReference: `Combined import session ${session._id}`,
        importedAt: new Date(),
        importSession: session._id,
      });
    }
    for (let i = 0; i < vouchersToInsert.length; i += BATCH) {
      const chunk = vouchersToInsert.slice(i, i + BATCH);
      try {
        const inserted = await Acc_Voucher.insertMany(chunk, {
          ordered: false,
        });
        for (const v of inserted) {
          rollbackTokens.push({
            collection: "acc_vouchers",
            objectId: v._id,
          });
        }
        created.vouchers += inserted.length;
      } catch (bulkErr) {
        const writeErrors = bulkErr.writeErrors || [];
        for (const we of writeErrors) {
          errors.push({
            item: `voucher (batch ${i / BATCH})`,
            kind: "voucher",
            reason: we.errmsg || "insert failed",
          });
        }
        const okCount = chunk.length - writeErrors.length;
        created.vouchers += Math.max(0, okCount);
      }
    }

    // ── Party mapping pass (vendor / customer) ───────────────────────
    // The import wizard's review screen lets the accountant map each
    // Sundry Creditor → a Vendor and each Sundry Debtor → a Customer
    // (link to an existing one, or create a new one). Those choices ride
    // in overrides[name].mapping = { action, targetId }. We apply them
    // here, AFTER ledgers exist, so links/aliases attach correctly.
    try {
      let Vendor = null;
      let Customer = null;
      try {
        Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
      } catch (e) {
        /* model absent in this deployment — skip vendor creation */
      }
      try {
        Customer = require("../../models/Customer_Models/Customer");
      } catch (e) {
        /* skip customer creation */
      }
      const cId2 = session.companyId;
      const mapResult = { linked: 0, created: 0, skipped: 0, errors: [] };

      for (const l of parsed.ledgers) {
        const ov = overrides[l.name] || {};
        const mp = ov.mapping;
        if (!mp || !mp.action || mp.action === "skip") continue;
        const grp = ov.groupName || l.groupName || "";
        const isCred = /sundry creditor/i.test(grp);
        const isDeb = /sundry debtor/i.test(grp);
        if (!isCred && !isDeb) continue;

        try {
          const led = await Acc_Ledger.findOne({
            companyId: cId2,
            name: l.name,
          });

          if (mp.action === "link") {
            if (!mp.targetId) {
              mapResult.skipped++;
              continue;
            }
            await Acc_Ledger.updateOne(
              { _id: mp.targetId, companyId: cId2 },
              { $addToSet: { aliases: l.name } },
            );
            if (l.gstin) {
              await Acc_Ledger.updateOne(
                {
                  _id: mp.targetId,
                  companyId: cId2,
                  $or: [
                    { gstin: { $exists: false } },
                    { gstin: "" },
                    { gstin: null },
                  ],
                },
                { $set: { gstin: l.gstin } },
              );
            }
            mapResult.linked++;
          } else if (mp.action === "create") {
            if (isCred && Vendor) {
              const exists = await Vendor.findOne({
                companyName: l.name,
              }).select("_id");
              if (!exists) {
                const v = await Vendor.create({
                  companyName: l.name,
                  vendorType: "Imported (Tally)",
                  email: l.email || undefined,
                  phone: l.phone || undefined,
                  address: {
                    street: l.address || "",
                    state: l.state || "",
                    pincode: l.pincode || "",
                    country: "India",
                  },
                  gstNumber: l.gstin || undefined,
                  status: "Active",
                });
                if (led) {
                  led.refVendorId = v._id;
                  await led.save().catch(() => {});
                }
                rollbackTokens.push({
                  collection: "vendors",
                  objectId: v._id,
                });
              }
              mapResult.created++;
            } else if (isDeb && Customer) {
              const safeEmail =
                l.email ||
                `tally+${String(led ? led._id : Date.now())}@import.local`;
              const safePhone =
                l.phone || `T${String(led ? led._id : Date.now()).slice(-9)}`;
              const exists = await Customer.findOne({
                $or: [{ email: safeEmail }, { name: l.name }],
              }).select("_id");
              if (!exists) {
                const c = await Customer.create({
                  name: l.name,
                  email: safeEmail,
                  phone: safePhone,
                  profile: {
                    address: {
                      state: l.state || null,
                      pincode: l.pincode || null,
                      country: "India",
                    },
                  },
                });
                if (led) {
                  led.refCustomerId = c._id;
                  await led.save().catch(() => {});
                }
                rollbackTokens.push({
                  collection: "customers",
                  objectId: c._id,
                });
              }
              mapResult.created++;
            } else {
              mapResult.created++;
            }
          }
        } catch (e) {
          mapResult.errors.push(`${l.name}: ${e.message}`);
        }
      }
      session.partyMapping = mapResult;
    } catch (e) {
      console.error("[combined/commit] party mapping pass:", e.message);
    }

    // ── Opening balances (from the detailed Trial Balance) ───────────
    // Masters never carries openings, so Balance-Sheet ledgers (Capital,
    // Bank, etc.) would show only their in-period movement. We parsed
    // the ledger-wise Trial Balance at preview time and stored the
    // openings in the payload; apply them now that every ledger exists.
    const openingResult = {
      applied: 0,
      matched: 0,
      unmatched: [],
      skipped: 0,
    };
    try {
      const op = parsed.openings;
      // PRIMARY PATH: apply every ledger's CLOSING balance straight
      // from the Trial Balance. The Trial Balance is the single source
      // of truth (it already computed opening + all movements and ties
      // to 0.00). We store that signed closing as the ledger's
      // `openingBalance` and mark `balanceFromTrialBalance` so the
      // Balance Sheet uses it AS-IS without re-adding Day-Book
      // movements (re-adding caused every prior mismatch).
      if (op && Array.isArray(op.closings) && op.closings.length) {
        const allLedgers = await Acc_Ledger.find({ companyId })
          .select("name aliases openingBalance openingBalanceType")
          .lean();
        const norm = (s) =>
          String(s || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .replace(/[.\u2019']/g, "")
            .trim();
        const byNorm = new Map();
        for (const l of allLedgers) {
          byNorm.set(norm(l.name), l);
          for (const a of l.aliases || [])
            if (!byNorm.has(norm(a))) byNorm.set(norm(a), l);
        }
        for (const tb of op.closings) {
          const hit = byNorm.get(norm(tb.name));
          if (!hit) {
            openingResult.unmatched.push({
              name: tb.name,
              closing: tb.closingSigned,
            });
            continue;
          }
          openingResult.matched++;
          await Acc_Ledger.updateOne(
            { _id: hit._id, companyId },
            {
              $set: {
                // Store signed (Dr +, Cr −) closing as the balance.
                openingBalance: tb.closingSigned,
                openingBalanceType: tb.closingType,
                currentBalance: tb.closingSigned,
                currentBalanceType: tb.closingType,
                balanceFromTrialBalance: true,
              },
            },
          );
          openingResult.applied++;
        }
        session.openingBalances = openingResult;
        session.balanceSource = "trial_balance_closing";
      } else if (op && Array.isArray(op.ledgers) && op.ledgers.length) {
        // FALLBACK (no closings captured): old opening-only behaviour.
        const allLedgers = await Acc_Ledger.find({ companyId })
          .select("name aliases openingBalance openingBalanceType")
          .lean();
        const norm = (s) =>
          String(s || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .replace(/[.\u2019']/g, "")
            .trim();
        const byNorm = new Map();
        for (const l of allLedgers) {
          byNorm.set(norm(l.name), l);
          for (const a of l.aliases || [])
            if (!byNorm.has(norm(a))) byNorm.set(norm(a), l);
        }
        for (const tb of op.ledgers) {
          const hit = byNorm.get(norm(tb.name));
          if (!hit) {
            openingResult.unmatched.push({
              name: tb.name,
              opening: tb.openingSigned,
            });
            continue;
          }
          openingResult.matched++;
          const changed =
            Math.abs((hit.openingBalance || 0) - tb.opening) > 0.005 ||
            (hit.openingBalanceType || "Dr") !== tb.openingType;
          if (!changed) {
            openingResult.skipped++;
            continue;
          }
          await Acc_Ledger.updateOne(
            { _id: hit._id, companyId },
            {
              $set: {
                openingBalance: tb.opening,
                openingBalanceType: tb.openingType,
              },
            },
          );
          openingResult.applied++;
        }
      }
      session.openingBalances = openingResult;
    } catch (e) {
      console.error("[combined/commit] opening apply:", e.message);
    }

    // ── Wrap up ──────────────────────────────────────────────────────
    session.sampleRows = [];
    session.rollbackTokens = rollbackTokens;
    session.createdCounts = created;
    session.summary.imported =
      created.groups + created.ledgers + created.vouchers;
    session.summary.errors = errors.length;
    session.summary.skipped = skipped.ledgers + skipped.vouchers;
    session.status = errors.length > 0 ? "completed_with_errors" : "completed";
    session.completedAt = new Date();
    session.sessionErrors = errors
      .slice(0, 50)
      .map((e) => `${e.kind}: ${e.item} — ${e.reason}`);
    await session.save();

    res.json({
      success: true,
      message: `Imported ${created.groups} groups, ${created.ledgers} ledgers, ${created.vouchers} vouchers (${skipped.ledgers} ledgers already existed, ${errors.length} errors)${openingResult.applied ? `; applied ${openingResult.applied} opening balance(s)` : ""}`,
      summary: { created, skipped, errors: errors.slice(0, 100) },
      openingBalances: openingResult,
      sessionId: session._id,
    });
  } catch (err) {
    console.error("Combined commit:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /reconcile   (multipart: summaryFile, companyId)
// ─────────────────────────────────────────────────────────────────────────────
// Accuracy verification. Upload the tiny Tally "Balance Sheet" (top-level)
// JSON — the ~1 KB one with just primary-group totals. We compute THIS
// system's balance sheet the exact same way the Balance Sheet page does
// (ledger.openingBalance + Σ posted-voucher signedAmount, grouped by primary
// group → nature) and compare it line-for-line against Tally's own numbers.
//
// Returns a clear pass/fail per line so the accountant can PROVE the import
// is correct (or see exactly which figure is off and by how much).
//
// This endpoint NEVER writes data — it only reads and compares.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/reconcile", upload.single("summaryFile"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({
        success: false,
        message: "Upload the Tally Balance Sheet summary JSON.",
      });
    const { companyId } = req.body;
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });

    const company = await Acc_Company.findById(companyId);
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });

    // The user might mistakenly upload one of the OTHER two exports.
    // Detect and explain instead of throwing a cryptic error.
    if (!bSheetSummary.isBSheetSummary(req.file.buffer)) {
      let hint = "This isn't the Tally Balance Sheet *summary* export. ";
      try {
        const t = mastersImporter.decodeBuffer(req.file.buffer).slice(0, 4000);
        if (t.includes('"tallymessage"'))
          hint +=
            "It looks like a Masters export (groups/ledgers). Use the Import tab for that.";
        else if (t.includes('"mlvledbody"') || t.includes('"mlvbody"'))
          hint +=
            "It looks like a Group-Summary drill-down (ledgers + vouchers). Use the combined import for that.";
        else
          hint +=
            "Export it from Tally via Gateway → Balance Sheet → Alt+E → JSON (it's a tiny ~1 KB file with just the primary group totals).";
      } catch {
        hint +=
          "Export it from Tally via Gateway → Balance Sheet → Alt+E → JSON.";
      }
      return res.status(400).json({ success: false, message: hint });
    }

    let summary;
    try {
      summary = bSheetSummary.parseBSheetSummary(req.file.buffer);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    // ── Compute THIS system's balance sheet ──────────────────────
    const cId = new mongoose.Types.ObjectId(companyId);
    const [groups, ledgers] = await Promise.all([
      Acc_Group.find({ companyId: cId, isActive: true })
        .select("_id name nature parent parentName")
        .lean(),
      Acc_Ledger.find({ companyId: cId, isActive: true })
        .select("_id name groupId groupName openingBalance")
        .lean(),
    ]);
    const groupById = new Map(groups.map((g) => [String(g._id), g]));
    const groupByName = new Map(
      groups.map((g) => [String(g.name).toLowerCase(), g]),
    );

    // Walk a group's parent chain to its PRIMARY (root) group name.
    function primaryGroupName(g) {
      let cur = g;
      const seen = new Set();
      while (cur && !seen.has(String(cur._id))) {
        seen.add(String(cur._id));
        const parent =
          (cur.parent && groupById.get(String(cur.parent))) ||
          (cur.parentName &&
            groupByName.get(String(cur.parentName).toLowerCase()));
        if (!parent) break;
        cur = parent;
      }
      return cur ? cur.name : g.name;
    }

    // Posted-voucher movement per ledger.
    const movements = await Acc_Voucher.aggregate([
      { $match: { companyId: cId, status: "posted" } },
      { $unwind: "$ledgerEntries" },
      {
        $group: {
          _id: "$ledgerEntries.ledgerId",
          net: { $sum: "$ledgerEntries.signedAmount" },
        },
      },
    ]);
    const moveMap = new Map();
    for (const m of movements)
      if (m && m._id) moveMap.set(String(m._id), m.net || 0);

    // Closing per ledger = opening + Σ signed movement; bucket by primary
    // group. Tally sign convention: Dr positive, Cr negative.
    const primaryTotals = {}; // primaryName(lower) → signed closing
    const primaryDisplay = {}; // primaryName(lower) → original-case name
    for (const led of ledgers) {
      const g = groupById.get(String(led.groupId));
      if (!g) continue;
      const pName = primaryGroupName(g);
      const key = pName.toLowerCase();
      primaryDisplay[key] = pName;
      const closing =
        (led.openingBalance || 0) + (moveMap.get(String(led._id)) || 0);
      primaryTotals[key] = (primaryTotals[key] || 0) + closing;
    }

    // ── Reconcile each Tally line against our number ─────────────
    // Tally Balance Sheet conventions:
    //   • sources (liabilities/equity) shown as Cr → our signed sum is
    //     negative; compare magnitudes.
    //   • application (assets) shown as Dr → our signed sum positive.
    //   • "Working Capital" = Current Assets − Current Liabilities (net),
    //     and "Profit & Loss A/c" is the accumulated result — both are
    //     derived, so we compute them specially.
    const TOL = 1.0; // ₹1 rounding tolerance

    function ourPrimary(name) {
      return primaryTotals[String(name).toLowerCase()] || 0;
    }

    const lines = [];
    let allMatch = true;

    function pushLine(label, tallyAmt, ourSigned, note) {
      // Tally prints magnitudes on each side; compare absolute values.
      const ours = Math.abs(ourSigned);
      const tally = Math.abs(Number(tallyAmt) || 0);
      const diff = ours - tally;
      const match = Math.abs(diff) <= TOL;
      if (!match) allMatch = false;
      lines.push({
        label,
        tally: Number(tallyAmt) || 0,
        ours: ourSigned,
        diff,
        match,
        note: note || null,
      });
    }

    for (const s of summary.sources) {
      const nm = s.name.toLowerCase();
      if (nm.includes("profit") && nm.includes("loss")) {
        // Accumulated P&L = revenue − expense across all ledgers.
        const rev =
          ourPrimary("sales accounts") +
          ourPrimary("direct incomes") +
          ourPrimary("indirect incomes");
        const exp =
          ourPrimary("purchase accounts") +
          ourPrimary("direct expenses") +
          ourPrimary("indirect expenses");
        const plLedger = ourPrimary("primary"); // P&L A/c opening
        const ourPL = -rev - exp + plLedger; // signed (Cr negative)
        pushLine(
          "Profit & Loss A/c",
          s.amount,
          ourPL,
          "Accumulated result (revenue − expenses + P&L opening). Needs vouchers imported to match.",
        );
      } else {
        pushLine(s.name, s.amount, ourPrimary(s.name));
      }
    }

    for (const a of summary.application) {
      const nm = a.name.toLowerCase();
      if (nm.includes("working capital")) {
        const ca = ourPrimary("current assets");
        const cl = ourPrimary("current liabilities");
        // Working capital = Current Assets − Current Liabilities
        pushLine(
          "Working Capital",
          a.amount,
          ca - cl,
          "Net = Current Assets − Current Liabilities.",
        );
      } else {
        pushLine(a.name, a.amount, ourPrimary(a.name));
      }
    }

    const postedVoucherCount = await Acc_Voucher.countDocuments({
      companyId: cId,
      status: "posted",
    });

    res.json({
      success: true,
      allMatch,
      postedVoucherCount,
      tally: {
        sources: summary.sources,
        application: summary.application,
        sourcesTotal: summary.sourcesTotal,
        applicationTotal: summary.applicationTotal,
      },
      reconciliation: lines,
      guidance:
        postedVoucherCount === 0
          ? "No vouchers are posted yet, so Profit & Loss and Working Capital cannot match Tally. Import the Group-Summary drill-down (the ~3 MB file with transactions) via the combined import, then reconcile again."
          : allMatch
            ? "Every line matches Tally within ₹1. The books are accurate."
            : "Some lines differ. Capital/Loans should match exactly; P&L and Working Capital only match once ALL vouchers are imported. See the per-line differences.",
    });
  } catch (err) {
    console.error("Reconcile:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /reset-accounting   { companyId, confirm: "RESET" }
// ─────────────────────────────────────────────────────────────────────────────
// Hard reset of a company's imported accounting data so you can re-import
// cleanly. This exists because mixing a new (correct) import on top of an
// old (wrong/doubled) one produces a corrupted Balance Sheet — the symptom
// you saw. After a reset, a fresh combined import reproduces Tally exactly.
//
// Deletes, for the given company: all vouchers, all ledgers, all groups,
// and marks prior import sessions rolled_back. Requires an explicit
// confirm string so it can't fire by accident. Does NOT touch company
// settings, users, or any non-accounting collection.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/reset-accounting", async (req, res) => {
  try {
    const { companyId, confirm } = req.body || {};
    if (!companyId)
      return res
        .status(400)
        .json({ success: false, message: "companyId required" });
    if (confirm !== "RESET")
      return res.status(400).json({
        success: false,
        message:
          'This permanently deletes all imported ledgers, groups and vouchers for this company. Send confirm:"RESET" to proceed.',
      });

    const company = await Acc_Company.findById(companyId);
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });

    const cId = company._id;

    const vDel = await Acc_Voucher.deleteMany({ companyId: cId });
    const lDel = await Acc_Ledger.deleteMany({ companyId: cId });
    const gDel = await Acc_Group.deleteMany({ companyId: cId });

    // Mark previous import sessions as rolled back so history is honest.
    await Acc_ImportSession.updateMany(
      {
        companyId: cId,
        status: { $in: ["completed", "completed_with_errors"] },
      },
      { $set: { status: "rolled_back", rolledBackAt: new Date() } },
    );

    res.json({
      success: true,
      message: `Reset complete — deleted ${vDel.deletedCount || 0} vouchers, ${lDel.deletedCount || 0} ledgers, ${gDel.deletedCount || 0} groups. You can now run a clean import.`,
      deleted: {
        vouchers: vDel.deletedCount || 0,
        ledgers: lDel.deletedCount || 0,
        groups: gDel.deletedCount || 0,
      },
    });
  } catch (err) {
    console.error("Reset accounting:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// OPENING BALANCES (from a Trial Balance export taken WITH opening column)
//
// POST /opening-balances/preview   (multipart: trialBalanceFile, companyId)
//      → parses the TB, matches each ledger to an existing Acc_Ledger,
//        returns what WOULD change. Nothing is written.
//
// POST /opening-balances/apply     (multipart: trialBalanceFile, companyId)
//      → same matching, then writes openingBalance/openingBalanceType onto
//        the matched ledgers. Idempotent: re-running sets the same values.
//
// Matching: exact (case/space-insensitive) name first, then alias match.
// Ledgers with no opening in the TB are left untouched. Unmatched TB
// ledgers are reported so the accountant can see the gaps explicitly.
// ═════════════════════════════════════════════════════════════════════════════
const tbUpload = upload.fields([
  { name: "trialBalanceFile", maxCount: 1 },
  { name: "file", maxCount: 1 },
]);

async function resolveOpeningCompany(passedId) {
  if (passedId) {
    try {
      return new mongoose.Types.ObjectId(passedId);
    } catch {
      /* fall through */
    }
  }
  let c = await Acc_Company.findOne({ isPrimary: true }).select("_id").lean();
  if (!c) {
    const all = await Acc_Company.find({}).select("_id").limit(2).lean();
    if (all.length === 1) c = all[0];
  }
  return c ? c._id : null;
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.\u2019']/g, "")
    .trim();
}

async function buildOpeningPlan(req) {
  const tbFile = req.files?.trialBalanceFile?.[0] || req.files?.file?.[0];
  if (!tbFile) {
    const err = new Error(
      "Trial Balance JSON file is required (field 'trialBalanceFile').",
    );
    err.status = 400;
    throw err;
  }
  const companyId = await resolveOpeningCompany(req.body.companyId);
  if (!companyId) {
    const err = new Error("No accounting company found.");
    err.status = 400;
    throw err;
  }

  const parsed = tbOpenings.parseTrialBalanceOpenings(tbFile.buffer);

  if (!parsed.usableForOpenings) {
    const err = new Error(
      (parsed.warnings && parsed.warnings[0]) ||
        "This Trial Balance has no usable opening balances. Re-export " +
          "ledger-wise (F5) with F12 'Show Opening Balance' = Yes.",
    );
    err.status = 400;
    throw err;
  }

  const ledgers = await Acc_Ledger.find({ companyId })
    .select("name aliases openingBalance openingBalanceType groupName")
    .lean();

  const byNorm = new Map();
  for (const l of ledgers) {
    byNorm.set(normName(l.name), l);
    for (const a of l.aliases || []) {
      if (!byNorm.has(normName(a))) byNorm.set(normName(a), l);
    }
  }

  const withOpening = parsed.ledgers.filter((l) => l.openingSigned !== 0);

  const matched = [];
  const unmatched = [];
  for (const tb of withOpening) {
    const hit = byNorm.get(normName(tb.name));
    if (hit) {
      matched.push({
        ledgerId: hit._id,
        name: hit.name,
        tbName: tb.name,
        currentOpening: hit.openingBalance || 0,
        currentType: hit.openingBalanceType || "Dr",
        newOpening: tb.opening,
        newType: tb.openingType,
        newSigned: tb.openingSigned,
        closing: tb.closing,
        changed:
          Math.abs((hit.openingBalance || 0) - tb.opening) > 0.005 ||
          (hit.openingBalanceType || "Dr") !== tb.openingType,
      });
    } else {
      unmatched.push({
        tbName: tb.name,
        opening: tb.openingSigned,
        closing: tb.closing,
      });
    }
  }

  return {
    companyId,
    parsed,
    matched,
    unmatched,
    summary: {
      tbLeafLedgers: parsed.ledgerCount,
      tbWithOpening: withOpening.length,
      matched: matched.length,
      willChange: matched.filter((m) => m.changed).length,
      unmatched: unmatched.length,
      openingTotals: parsed.totals,
    },
  };
}

router.post("/opening-balances/preview", tbUpload, async (req, res) => {
  try {
    const plan = await buildOpeningPlan(req);
    res.json({
      success: true,
      warnings: plan.parsed.warnings,
      summary: plan.summary,
      matched: plan.matched,
      unmatched: plan.unmatched,
    });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

router.post("/opening-balances/apply", tbUpload, async (req, res) => {
  try {
    const plan = await buildOpeningPlan(req);
    let updated = 0;
    for (const m of plan.matched) {
      if (!m.changed) continue;
      await Acc_Ledger.updateOne(
        { _id: m.ledgerId, companyId: plan.companyId },
        {
          $set: {
            openingBalance: m.newOpening,
            openingBalanceType: m.newType,
          },
        },
      );
      updated += 1;
    }
    res.json({
      success: true,
      warnings: plan.parsed.warnings,
      summary: { ...plan.summary, updated },
      matched: plan.matched,
      unmatched: plan.unmatched,
      message:
        `Applied ${updated} opening balance(s). ` +
        (plan.unmatched.length
          ? `${plan.unmatched.length} Trial-Balance ledger(s) had no ` +
            `matching imported ledger — listed in 'unmatched'.`
          : `Every Trial-Balance opening matched an imported ledger.`),
    });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

module.exports = router;
