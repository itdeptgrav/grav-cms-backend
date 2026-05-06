// routes/Accountant_Routes/tallyImport.js
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
const multer = require("multer");
const path = require("path");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const {
  TallyCompany,
  TallyGroup,
  TallyLedger,
  TallyStockGroup,
  TallyStockItem,
  TallyUnit,
  TallyCostCentre,
} = require("../../models/Accountant_model/TallyMasterModels");
const { TallyVoucher } = require("../../models/Accountant_model/TallyVoucherModels");
const {
  TallyFieldMapping,
  TallyImportSession,
} = require("../../models/Accountant_model/TallyImportModels");

const tallyParser = require("../../services/tallyParser.service");
const tallyMapper = require("../../services/tallyMapper.service");

router.use(accountantAuth);

// ─── Multer: in-memory upload, 50MB cap (Tally exports rarely exceed this) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv|xml|json)$/i.test(file.originalname);
    if (!ok) return cb(new Error("Only .xlsx, .xls, .csv, .xml, .json files are accepted"));
    cb(null, true);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /upload
// ─────────────────────────────────────────────────────────────────────────────
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    const { companyId, importType, entityType: hintEntity } = req.body;
    if (!companyId) return res.status(400).json({ success: false, message: "companyId is required" });

    const company = await TallyCompany.findById(companyId);
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });

    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
    const checksum = tallyParser.fileChecksum(req.file.buffer);

    // Create session up front so we can stream progress
    const session = await TallyImportSession.create({
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
      return res.status(400).json({ success: false, message: `Failed to parse file: ${parseErr.message}` });
    }

    // Try to detect entity type if not given
    const detectedEntity = hintEntity || tallyParser.detectEntityType(parsed.columns) || "mixed";

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
      suggestedMapping: tallyMapper.suggestMapping(parsed.columns, detectedEntity),
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
    const session = await TallyImportSession.findById(req.params.id)
      .populate("fieldMappingId", "name entityType")
      .lean();
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });

    // Trim heavy fields by default
    const compact = req.query.full === "true" ? session : {
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
      TallyImportSession.find(filter)
        .select("-rows -sampleRows -fieldMappingSnapshot -rollbackTokens")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      TallyImportSession.countDocuments(filter),
    ]);

    res.json({ success: true, sessions, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sessions/:id/suggest-mapping
// ─────────────────────────────────────────────────────────────────────────────
router.post("/sessions/:id/suggest-mapping", async (req, res) => {
  try {
    const session = await TallyImportSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });

    const entityType = req.body.entityType || session.entityType;
    const suggested = tallyMapper.suggestMapping(session.detectedColumns, entityType);
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
    const { mappings, fileShape, multiRowRule, autoCreate, defaultLedgerGroup, entityType, saveAsTemplate, templateName } = req.body;
    const session = await TallyImportSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });

    if (entityType) session.entityType = entityType;

    session.fieldMappingSnapshot = {
      mappings: mappings || [],
      fileShape: fileShape || {},
      multiRowRule: multiRowRule || { enabled: false },
      autoCreate: autoCreate || { ledgers: true, stockItems: false, groups: false },
      defaultLedgerGroup: defaultLedgerGroup || "Sundry Debtors",
    };
    session.status = "mapping";
    await session.save();

    // Optionally persist as a reusable template
    let template = null;
    if (saveAsTemplate && templateName) {
      template = await TallyFieldMapping.create({
        name: templateName,
        entityType: session.entityType,
        fileShape: fileShape || {},
        mappings: mappings || [],
        multiRowRule: multiRowRule || { enabled: false },
        autoCreate: autoCreate || { ledgers: true, stockItems: false, groups: false },
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
    const session = await TallyImportSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });
    if (!session.fieldMappingSnapshot?.mappings?.length) {
      return res.status(400).json({ success: false, message: "Mapping not saved on this session yet" });
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
      : sample.map((r, i) => ({ ...tallyMapper.applyMapping(r, mapping, fileShape), rowNumber: i + 1 }));

    const errors = [];
    const validated = multi.map(r => {
      if (r.errors && r.errors.length) errors.push({ rowNumber: r.rowNumber, errors: r.errors });
      return { rowNumber: r.rowNumber, status: r.errors?.length ? "invalid" : "valid", data: r.data };
    });

    session.status = "validated";
    session.validatedAt = new Date();
    session.summary.valid = validated.filter(v => v.status === "valid").length;
    session.summary.invalid = validated.filter(v => v.status === "invalid").length;
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
//   • ledger          → upsert TallyLedger
//   • stock_item      → upsert TallyStockItem
//   • voucher_*       → resolve party + each ledgerEntry's ledger, create
//                        TallyVoucher with status='posted'
//   • group           → upsert TallyGroup
//
// We build a `rollbackTokens` array as we go so the import can be undone.
router.post("/sessions/:id/commit", async (req, res) => {
  try {
    const session = await TallyImportSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });
    if (session.status === "completed" || session.status === "completed_with_errors") {
      return res.status(400).json({ success: false, message: "Session already committed" });
    }
    if (!session.fieldMappingSnapshot?.mappings?.length) {
      return res.status(400).json({ success: false, message: "Mapping not saved" });
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
      prepared = rows.map((r, i) => ({ ...tallyMapper.applyMapping(r, mapping, fileShape), rowNumber: i + 1 }));
    }

    const created = { ledgers: 0, groups: 0, stockItems: 0, vouchers: 0, costCentres: 0 };
    const rollbackTokens = [];
    const rowResults = [];

    for (const p of prepared) {
      if (p.errors && p.errors.length) {
        rowResults.push({ rowNumber: p.rowNumber, status: "invalid", errors: p.errors });
        continue;
      }

      try {
        const result = await commitOne(p, session, mapping, req.user?.id);
        if (result?.created?._id) {
          rollbackTokens.push({ collection: result.collection, objectId: result.created._id });
          created[result.kind] = (created[result.kind] || 0) + 1;
          rowResults.push({
            rowNumber: p.rowNumber,
            status: "imported",
            createdEntity: { type: result.kind, collection: result.collection,
                             objectId: result.created._id, identifier: result.identifier },
          });
        } else {
          rowResults.push({ rowNumber: p.rowNumber, status: "skipped" });
        }
      } catch (err) {
        rowResults.push({ rowNumber: p.rowNumber, status: "error",
                          errors: [{ field: "*", message: err.message }] });
      }
    }

    session.rows = rowResults;
    session.rollbackTokens = rollbackTokens;
    session.createdCounts = created;
    session.summary.imported = rowResults.filter(r => r.status === "imported").length;
    session.summary.errors   = rowResults.filter(r => r.status === "error").length;
    session.summary.skipped  = rowResults.filter(r => r.status === "skipped").length;

    session.status = session.summary.errors > 0 ? "completed_with_errors" : "completed";
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
      if (!data.name || !data.groupName) throw new Error("Ledger requires name and groupName");
      const group = await TallyGroup.findOne({ companyId, name: data.groupName });
      if (!group) {
        if (!mapping.autoCreate?.groups) throw new Error(`Group "${data.groupName}" not found`);
        // shouldn't normally auto-create groups — they need a nature
        throw new Error(`Group "${data.groupName}" not found and group auto-create requires a nature.`);
      }
      // Upsert by (companyId, name)
      const ledger = await TallyLedger.findOneAndUpdate(
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
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return { kind: "ledgers", collection: "tally_ledgers", created: ledger, identifier: ledger.name };
    }

    // ─── STOCK ITEM ─────────────────────────────────────────────────────────
    case "stock_item": {
      if (!data.name) throw new Error("Stock item requires name");
      let stockGroup = null;
      if (data.stockGroupName) {
        stockGroup = await TallyStockGroup.findOne({ companyId, name: data.stockGroupName });
      }
      const item = await TallyStockItem.findOneAndUpdate(
        { companyId, name: data.name },
        {
          $set: {
            ...data,
            companyId,
            stockGroupId: stockGroup?._id,
            importedAt: new Date(),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return { kind: "stockItems", collection: "tally_stock_items", created: item, identifier: item.name };
    }

    // ─── GROUP ──────────────────────────────────────────────────────────────
    case "group": {
      if (!data.name) throw new Error("Group requires name");
      let parent = null;
      if (data.parentName) {
        parent = await TallyGroup.findOne({ companyId, name: data.parentName });
      }
      const grp = await TallyGroup.findOneAndUpdate(
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
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return { kind: "groups", collection: "tally_groups", created: grp, identifier: grp.name };
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
          [data.partyLedgerName], companyId,
          {
            autoCreate: mapping.autoCreate?.ledgers,
            defaultGroup: vchType === "purchase" ? "Sundry Creditors" : "Sundry Debtors",
            createdBy: accountantId,
            importSource: `tally_${session.fileType}`,
          }
        );
        partyLedger = ledgerMap.get(data.partyLedgerName.toLowerCase());
      }

      // Resolve ledger entries (multi-row mode)
      const ledgerEntries = data.ledgerEntries || [];
      if (ledgerEntries.length) {
        const names = ledgerEntries.map(le => le.ledgerName).filter(Boolean);
        const ledgerMap = await tallyMapper.resolveLedgers(
          names, companyId,
          {
            autoCreate: mapping.autoCreate?.ledgers,
            defaultGroup: mapping.defaultLedgerGroup,
            createdBy: accountantId,
            importSource: `tally_${session.fileType}`,
          }
        );
        for (const le of ledgerEntries) {
          const found = ledgerMap.get(String(le.ledgerName || "").toLowerCase());
          if (found) {
            le.ledgerId = found._id;
            le.groupName = found.groupName;
          }
        }
      } else if (partyLedger && (data.grandTotal || 0) > 0) {
        // No explicit lines — synthesise a 2-line voucher from grandTotal + GST
        // (typical "single-row sales export" pattern)
        const total   = parseFloat(data.grandTotal) || 0;
        const cgst    = parseFloat(data.gstBreakup?.cgst || 0);
        const sgst    = parseFloat(data.gstBreakup?.sgst || 0);
        const igst    = parseFloat(data.gstBreakup?.igst || 0);
        const taxable = total - cgst - sgst - igst;

        const isSale  = vchType === "sales";
        // Sales:    Dr Customer  / Cr Sales / Cr CGST / Cr SGST / Cr IGST
        // Purchase: Dr Purchase  / Dr CGST / Dr SGST / Dr IGST  / Cr Vendor
        ledgerEntries.length = 0;
        if (isSale) {
          ledgerEntries.push({ ledgerId: partyLedger._id, ledgerName: partyLedger.name, type: "Dr", amount: total });
          ledgerEntries.push({ ledgerName: "Sales Accounts", type: "Cr", amount: taxable });
          if (cgst) ledgerEntries.push({ ledgerName: "CGST Output", type: "Cr", amount: cgst });
          if (sgst) ledgerEntries.push({ ledgerName: "SGST Output", type: "Cr", amount: sgst });
          if (igst) ledgerEntries.push({ ledgerName: "IGST Output", type: "Cr", amount: igst });
        } else {
          ledgerEntries.push({ ledgerName: "Purchase Accounts", type: "Dr", amount: taxable });
          if (cgst) ledgerEntries.push({ ledgerName: "CGST Input", type: "Dr", amount: cgst });
          if (sgst) ledgerEntries.push({ ledgerName: "SGST Input", type: "Dr", amount: sgst });
          if (igst) ledgerEntries.push({ ledgerName: "IGST Input", type: "Dr", amount: igst });
          ledgerEntries.push({ ledgerId: partyLedger._id, ledgerName: partyLedger.name, type: "Cr", amount: total });
        }

        // Resolve the synthetic ledger names
        const synthNames = ledgerEntries.filter(e => !e.ledgerId).map(e => e.ledgerName);
        if (synthNames.length) {
          const ledgerMap = await tallyMapper.resolveLedgers(synthNames, companyId, {
            autoCreate: true,
            defaultGroup: "Sales Accounts",
            createdBy: accountantId,
            importSource: `tally_${session.fileType}`,
          });
          ledgerEntries.forEach(e => {
            if (!e.ledgerId) {
              const found = ledgerMap.get(e.ledgerName.toLowerCase());
              if (found) { e.ledgerId = found._id; e.groupName = found.groupName; }
            }
          });
        }
      }

      const voucher = await TallyVoucher.create({
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

      return { kind: "vouchers", collection: "tally_vouchers", created: voucher, identifier: voucher.voucherNumber };
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
    const session = await TallyImportSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });
    if (!["completed", "completed_with_errors"].includes(session.status)) {
      return res.status(400).json({ success: false, message: "Only completed imports can be rolled back" });
    }

    const tokens = session.rollbackTokens || [];
    const byCollection = tokens.reduce((acc, t) => {
      (acc[t.collection] ||= []).push(t.objectId);
      return acc;
    }, {});

    const collMap = {
      tally_ledgers: TallyLedger,
      tally_stock_items: TallyStockItem,
      tally_groups: TallyGroup,
      tally_vouchers: TallyVoucher,
      tally_cost_centres: TallyCostCentre,
    };

    let deleted = 0;
    for (const [coll, ids] of Object.entries(byCollection)) {
      const Model = collMap[coll];
      if (Model) {
        const r = await Model.deleteMany({ _id: { $in: ids } });
        deleted += r.deletedCount || 0;
      }
    }

    session.status = "rolled_back";
    session.rolledBackAt = new Date();
    await session.save();

    res.json({ success: true, message: `Rolled back ${deleted} records`, deletedCount: deleted });
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
    const mappings = await TallyFieldMapping.find(filter).sort({ timesUsed: -1, createdAt: -1 }).lean();
    res.json({ success: true, mappings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/mappings", async (req, res) => {
  try {
    const t = await TallyFieldMapping.create({ ...req.body, createdBy: req.user?.id });
    res.status(201).json({ success: true, mapping: t });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/mappings/:id", async (req, res) => {
  try {
    await TallyFieldMapping.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
