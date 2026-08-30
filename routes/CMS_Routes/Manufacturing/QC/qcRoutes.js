// routes/CMS_Routes/Manufacturing/QC/qcRoutes.js

const express = require("express");
const router  = express.Router();

const WorkOrder                  = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest            = require("../../../../models/Customer_Models/CustomerRequest");
const ProductionTracking         = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const Employee                   = require("../../../../models/Employee");
const Operation                  = require("../../../../models/CMS_Models/Inventory/Configurations/Operation");
const QCInspection               = require("../../../../models/CMS_Models/Manufacturing/QC/DefectRecord");
const EmployeeMpc                = require("../../../../models/Customer_Models/Employee_Mpc");
const Measurement                = require("../../../../models/Customer_Models/Measurement");
const StockItem                  = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const qcStages                   = require("../../../../services/qcStages");
const qcViewer                   = require("../../../../services/qcViewer");
const QCDefectType               = require("../../../../models/CMS_Models/Manufacturing/QC/QCDefectType");
const QCOperationDefectMap       = require("../../../../models/CMS_Models/Manufacturing/QC/QCOperationDefectMap");

// ─── Helpers ──────────────────────────────────────────────────────────────────
const istDateString = (d = new Date()) => {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
};

const parseBarcode = (raw) => {
  if (!raw || typeof raw !== "string") return { success: false };
  const parts = raw.trim().split("-");
  if (parts.length !== 3 || parts[0] !== "WO") return { success: false };
  const unit = parseInt(parts[2], 10);
  if (!Number.isFinite(unit) || unit <= 0) return { success: false };
  return { success: true, workOrderShortId: parts[1], unitNumber: unit };
};

/**
 * The picture of the garment a work order is for.
 *
 * NOT `stockItem.images[0]`, WHICH IS USUALLY EMPTY. On this catalogue the base
 * product carries no images at all — every picture hangs off a VARIANT, because
 * a shirt in size 30 and the same shirt in size 44 are photographed separately.
 * So the work order's variant attributes have to be matched against the
 * product's variants first, and the base array is only the fallback for the rare
 * product that does have one.
 *
 * THIS USED TO BE A CLOSURE INSIDE /inspections, and the customer rollup grew
 * its own one-line version that read the base array alone — so the same garment
 * had a photo in the table and a broken-image icon three panels down. One
 * function, called from both, is the fix; a second copy is how it happened.
 *
 * The match is "every attribute this variant declares is also on the work
 * order", not equality: a work order carries extras the variant does not (Brand,
 * for one), and requiring an exact set match finds nothing.
 */
const resolveProductImage = (wo, siMap) => {
  if (!wo) return null;
  const si = wo.stockItemId ? siMap.get(wo.stockItemId.toString()) : null;
  if (!si) return null;

  if (wo.variantAttributes?.length && si.variants?.length) {
    const match = si.variants.find((v) =>
      (v.attributes || []).length > 0 &&
      (v.attributes || []).every((va) =>
        wo.variantAttributes.some(
          (woAttr) =>
            woAttr.name?.toLowerCase() === va.name?.toLowerCase() &&
            String(woAttr.value).toLowerCase() === String(va.value).toLowerCase(),
        ),
      ),
    );
    if (match?.images?.[0]) return match.images[0];
  }

  // Any variant's picture beats no picture at all. The garment in a customer
  // report is being identified, not specified — and an icon that says "no
  // image" where one plainly exists reads as a broken page.
  const anyVariantImage = (si.variants || []).find((v) => v.images?.[0]);
  return si.images?.[0] || anyVariantImage?.images?.[0] || null;
};

const extractCategory = (code) => {
  if (!code) return "OTHER";
  const m = String(code).match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : "OTHER";
};

const findWorkOrderByShortId = async (shortId) => {
  const matches = await WorkOrder.aggregate([
    { $match: { $expr: { $eq: [{ $substrCP: [{ $toString: "$_id" }, 16, 8] }, shortId] } } },
    { $limit: 1 },
    { $project: {
      _id: 1, workOrderNumber: 1, stockItemName: 1, stockItemReference: 1,
      stockItemId: 1, quantity: 1, status: 1, variantAttributes: 1, customerRequestId: 1,
    }},
  ]);
  return matches[0] || null;
};

// ─── Master operations cache (1 min TTL) ──────────────────────────────────────
let opsCache   = null;
let opsCacheAt = 0;
const OPS_CACHE_MS = 60 * 1000;

const getMasterOperations = async () => {
  const now = Date.now();
  if (opsCache && now - opsCacheAt < OPS_CACHE_MS) return opsCache;
  opsCache   = await Operation.find({ operationCode: { $ne: "" } })
    .select("name operationCode totalSam machineType").lean();
  opsCacheAt = now;
  return opsCache;
};

/**
 * The operations THIS product is actually built from.
 *
 * QC was listing the entire master operation sheet — 259 rows for a shirt whose
 * product page defines a few dozen. Every piece of every product showed the same
 * list, so the inspector was scrolling past operations that were never performed
 * on the garment in their hand, and a category count like "S 95" described the
 * factory's whole vocabulary rather than this style.
 *
 * The product page's Operations tab is the real scope: StockItem.operations,
 * where `type` is the operation's name as the merchandiser entered it and
 * `totalSeconds` is its time. The master sheet is still consulted, but only to
 * fill in a canonical name, SAM or machine type where the product row left one
 * blank.
 *
 * Returns null when the product cannot supply a scope — no stock item on the
 * work order, no such product, or a product with an empty Operations tab. The
 * caller then falls back to the master sheet rather than showing an inspector an
 * empty list: a data-entry gap must not stop the line, but it is reported so
 * nobody mistakes the master sheet for this product's own.
 */
const getProductOperations = async (stockItemId) => {
  if (!stockItemId) return null;
  const item = await StockItem.findById(stockItemId).select("operations").lean().catch(() => null);
  const rows = item?.operations;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows;
};

router.post("/refresh-operations-cache", (_req, res) => {
  opsCache = null; opsCacheAt = 0;
  res.json({ success: true });
});

// ─── POST /signin ──────────────────────────────────────────────────────────────
// 28 Aug 2026, explicit request: "don't ask for the scan id card ok, it is
// not needed ok, because we can track from the corresponding signed in
// employee ok". `biometricId` in the body is now OPTIONAL — an ID-card scan
// still works if a caller sends one (kept for any station that still wants
// per-scan attribution independent of who is logged in), but the ordinary
// path is an empty body, which resolves the inspector straight from the
// authenticated CMS login (`req.user.email`, set by EmployeeAuthMiddleware
// ahead of this router) instead of asking them to badge in a second time.
// Same email→Employee resolution routes/CEO_Routes and services/qcViewer.js
// already use elsewhere for the identical "CMS knows email, QC knows
// biometric id" join.
router.post("/signin", async (req, res) => {
  try {
    const scanned = req.body?.biometricId ? String(req.body.biometricId).trim() : "";

    let employee = null;
    if (scanned) {
      employee = await Employee.findOne({ biometricId: scanned })
        .select("firstName middleName lastName biometricId identityId email department designation isActive status").lean();
      if (!employee)
        return res.status(404).json({ success: false, message: "No employee found with this ID." });
      if (employee.isActive === false || employee.status === "inactive")
        return res.status(403).json({ success: false, message: "This employee account is inactive." });
    } else {
      const loginEmail = String(req.user?.email || "").trim().toLowerCase();
      if (!loginEmail)
        return res.status(401).json({ success: false, message: "Your session has expired — please sign in again." });
      employee = await Employee.findOne({ email: loginEmail })
        .select("firstName middleName lastName biometricId identityId email department designation isActive status").lean();
      if (employee && (employee.isActive === false || employee.status === "inactive"))
        employee = null; // fall through to the CMS-identity path below, same as "no record at all"
    }

    // No Employee record is linked to this CMS login (or it's inactive) — the
    // common case is a QC login that predates HR linking it up, or a shared
    // department account with no individual Employee behind it at all. Only
    // reachable via the no-scan path above (the scanned path already returned
    // 404/403 on its own if the card didn't resolve). Falls back to the CMS
    // identity itself rather than BLOCKING the inspector from working: a
    // named, traceable identity with no biometric id is still real
    // attribution (see save-inspection's own qcSession fallback further down,
    // which already anticipated exactly this — `serverUser.name`/`.email`),
    // and refusing to let someone inspect because HR hasn't linked their
    // record yet would be strictly worse than any gap in checkpoint rostering.
    if (!employee) {
      return res.json({
        success: true,
        name: req.user?.name || "QC Inspector",
        biometricId: "",
        identityId: "",
        department: "",
        designation: "",
        email: String(req.user?.email || ""),
        stageEnforced: false,
        stages: [],
      });
    }

    const name = [employee.firstName, employee.middleName, employee.lastName]
      .filter(Boolean).join(" ").trim() || employee.biometricId || employee.email || "QC Inspector";

    // The checkpoints this person is rostered on RIGHT NOW. Returned with the
    // session rather than fetched separately because the station needs it
    // before the first scan — an inspector who is on no checkpoint should learn
    // that at sign-in, not when a piece is already in their hand.
    //
    // `enforced: false` means stages or the roster are not configured yet, and
    // `stages` is then every checkpoint rather than none. See services/qcStages.
    const roster = await qcStages
      .stagesForPerson({ biometricId: employee.biometricId, email: employee.email })
      .catch((e) => {
        // A roster lookup must never keep somebody from signing in to inspect.
        console.warn("[QC signin] roster lookup skipped:", e.message);
        return { enforced: false, stages: [], assignments: [] };
      });

    return res.json({
      success: true, name,
      biometricId: employee.biometricId,
      identityId:  employee.identityId  || "",
      department:  employee.department  || "",
      designation: employee.designation || "",
      email:       employee.email       || "",
      stageEnforced: roster.enforced,
      stages: roster.stages.map((st) => ({
        _id: st._id, code: st.code, name: st.name, serial: st.serial,
      })),
    });
  } catch (err) {
    console.error("[QC signin] error:", err);
    res.status(500).json({ success: false, message: "Server error during sign-in" });
  }
});

// ─── POST /lookup-piece ────────────────────────────────────────────────────────
router.post("/lookup-piece", async (req, res) => {
  try {
    // `biometricId` is the station's day-session identity. Optional: a lookup
    // without one still returns the piece and its progress, it simply cannot
    // say which checkpoints THIS person may act at.
    //
    // `knownWorkOrderId` / `hasDefectCatalog` are the client saying "I already
    // have the last work order's operations, and I already have a defect
    // catalogue from this tab" — see the two `Unchanged` short-circuits below.
    const { barcode, biometricId, knownWorkOrderId, hasDefectCatalog } = req.body;
    if (!barcode) return res.status(400).json({ success: false, message: "barcode is required" });

    const trimmed = barcode.trim();
    const parsed  = parseBarcode(trimmed);
    if (!parsed.success)
      return res.status(400).json({ success: false, message: "Invalid barcode format. Expected WO-<shortId>-<unit>" });

    const { workOrderShortId, unitNumber } = parsed;

    const [workOrder, trackingScans, existingInspections, masterOps] = await Promise.all([
      findWorkOrderByShortId(workOrderShortId),
      ProductionTracking.aggregate([
        { $match: { "machines.operators.barcodeScans.barcodeId": trimmed } },
        { $unwind: "$machines" },
        { $unwind: "$machines.operators" },
        { $unwind: "$machines.operators.barcodeScans" },
        { $match: { "machines.operators.barcodeScans.barcodeId": trimmed } },
        { $lookup: { from: "machines", localField: "machines.machineId", foreignField: "_id", as: "_m" } },
        { $project: {
          _id: 0,
          operatorId:  "$machines.operators.operatorIdentityId",
          activeOps:   "$machines.operators.barcodeScans.activeOps",
          timeStamp:   "$machines.operators.barcodeScans.timeStamp",
          machineName: { $arrayElemAt: ["$_m.name", 0] },
        }},
      ]),
      QCInspection.find({ barcodeId: trimmed }).sort({ inspectedAt: -1 }).limit(10).lean(),
      getMasterOperations(),
    ]);

    if (!workOrder)
      return res.status(404).json({ success: false, message: `Work order "${workOrderShortId}" not found` });
    if (unitNumber > workOrder.quantity)
      return res.status(400).json({ success: false, message: `Unit ${unitNumber} out of range (1–${workOrder.quantity})` });

    const [customerRequest, empProgress, productOps, stockItemForImage] = await Promise.all([
      workOrder.customerRequestId
        ? CustomerRequest.findById(workOrder.customerRequestId).lean()
        : Promise.resolve(null),
      EmployeeProductionProgress.findOne({
        workOrderId: workOrder._id, unitStart: { $lte: unitNumber }, unitEnd: { $gte: unitNumber },
      }).lean(),
      getProductOperations(workOrder.stockItemId),
      // Only the fields resolveProductImage needs — this product's own images
      // run to full-size URLs across many variants, so fetching the rest of
      // the StockItem document here would be its own bandwidth mistake.
      workOrder.stockItemId
        ? StockItem.findById(workOrder.stockItemId).select("images variants.attributes variants.images").lean().catch(() => null)
        : Promise.resolve(null),
    ]);

    // The garment's own photo, next to its name — an inspector holding the
    // piece used to see only text. Omitted (not merely null) when the client
    // already has it cached for this same work order, same reasoning as the
    // operations catalogue below.
    const productImage = stockItemForImage
      ? resolveProductImage(workOrder, new Map([[String(workOrder.stockItemId), stockItemForImage]]))
      : null;

    const isMeasurementConversion =
      customerRequest?.requestType === "measurement_conversion" || !!empProgress?.measurementId;

    let pieceOwner = null;
    if (empProgress?.employeeName) {
      let empMpcDoc = null;
      if (empProgress.employeeId)
        empMpcDoc = await EmployeeMpc.findById(empProgress.employeeId).select("department designation").lean().catch(() => null);
      if (!empMpcDoc && empProgress.employeeUIN)
        empMpcDoc = await EmployeeMpc.findOne({ uin: empProgress.employeeUIN.trim().toUpperCase() }).select("department designation").lean().catch(() => null);

      pieceOwner = {
        employeeName: empProgress.employeeName, employeeUIN: empProgress.employeeUIN,
        gender: empProgress.gender,
        department:  empMpcDoc?.department  || "",
        designation: empMpcDoc?.designation || "",
        unitStart: empProgress.unitStart, unitEnd: empProgress.unitEnd,
        totalUnits: empProgress.totalUnits, completedUnits: empProgress.completedUnits,
        measurements: null,
      };

      const measurementIdToUse = empProgress.measurementId || customerRequest?.measurementId;
      if (measurementIdToUse) {
        try {
          const mDoc = await Measurement.findById(measurementIdToUse).select("employeeMeasurements").lean();
          if (mDoc) {
            const empEntry = (mDoc.employeeMeasurements || []).find((em) =>
              (empProgress.employeeId && em.employeeId && em.employeeId.toString() === empProgress.employeeId.toString()) ||
              (empProgress.employeeUIN && em.employeeUIN && em.employeeUIN.trim().toUpperCase() === empProgress.employeeUIN.trim().toUpperCase()) ||
              em.employeeName === empProgress.employeeName
            );
            if (empEntry) {
              const prodEntry = (empEntry.products || []).find(p => p.productId?.toString() === workOrder.stockItemId?.toString());
              if (prodEntry?.measurements?.length) pieceOwner.measurements = prodEntry.measurements;
            }
          }
        } catch (e) { console.warn("[QC lookup-piece] measurement fetch skipped:", e.message); }
      }
    }

    const operatorIds = [...new Set(trackingScans.map(s => s.operatorId).filter(Boolean))];
    const employees   = operatorIds.length
      ? await Employee.find({ identityId: { $in: operatorIds } }).select("identityId firstName middleName lastName").lean()
      : [];
    const nameMap = new Map(employees.map(e => [
      e.identityId,
      [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim() || e.identityId,
    ]));
    const getName = (id) => nameMap.get(id) || id || "Unknown";

    const opOperatorsMap = new Map();
    let totalScans = 0;
    for (const scan of trackingScans) {
      totalScans++;
      const codes = Array.isArray(scan.activeOps)
        ? scan.activeOps
        : (scan.activeOps || "").split(",").map(s => s.trim()).filter(Boolean);
      for (const code of codes) {
        const lower = code.trim().toLowerCase();
        if (!opOperatorsMap.has(lower)) opOperatorsMap.set(lower, new Map());
        const ops = opOperatorsMap.get(lower);
        if (!ops.has(scan.operatorId)) {
          ops.set(scan.operatorId, {
            operatorId: scan.operatorId, operatorName: getName(scan.operatorId),
            machinesSet: new Set(), firstAt: scan.timeStamp, lastAt: scan.timeStamp,
          });
        }
        const entry = ops.get(scan.operatorId);
        if (scan.machineName) entry.machinesSet.add(scan.machineName);
        if (new Date(scan.timeStamp) > new Date(entry.lastAt))  entry.lastAt  = scan.timeStamp;
        if (new Date(scan.timeStamp) < new Date(entry.firstAt)) entry.firstAt = scan.timeStamp;
      }
    }

    // Resolve which operations this piece is inspected against.
    const masterByCode = new Map(
      masterOps.map((o) => [(o.operationCode || "").trim().toLowerCase(), o]),
    );

    let opSource = null;
    let operationScope = null;

    if (productOps) {
      const seen = new Set();
      const scoped = [];
      let withoutCode = 0;
      for (const row of productOps) {
        const code = (row.operationCode || "").trim();
        // A defect is recorded BY operation code, so a product row without one
        // cannot be flagged. Skipping it is honest; counting it lets the screen
        // say the product sheet is incomplete.
        if (!code) { withoutCode += 1; continue; }
        const key = code.toLowerCase();
        if (seen.has(key)) continue;            // the same operation listed twice
        seen.add(key);
        const m = masterByCode.get(key);
        scoped.push({
          operationCode: code,
          name: row.type || m?.name || code,
          totalSam: row.totalSeconds != null
            ? Math.round((row.totalSeconds / 60) * 100) / 100
            : m?.totalSam,
          machineType: row.machineType || row.machine || m?.machineType || "",
        });
      }
      if (scoped.length) {
        opSource = scoped;
        operationScope = {
          source: "product",
          defined: productOps.length,
          used: scoped.length,
          withoutCode,
        };
      }
    }

    if (!opSource) {
      opSource = masterOps;
      operationScope = {
        source: "master",
        reason: !workOrder.stockItemId
          ? "This work order is not linked to a product."
          : !productOps
            ? "This product has no operations on its Operations tab."
            : "This product's operations have no operation codes.",
      };
    }

    const operations = opSource.map(op => {
      const lower       = (op.operationCode || "").trim().toLowerCase();
      const opOperators = opOperatorsMap.get(lower);
      const operators   = opOperators
        ? Array.from(opOperators.values())
            .map(o => ({ operatorId: o.operatorId, operatorName: o.operatorName, machines: Array.from(o.machinesSet), firstAt: o.firstAt, lastAt: o.lastAt }))
            .sort((a, b) => new Date(a.firstAt) - new Date(b.firstAt))
        : [];
      return { code: op.operationCode, name: op.name, sam: op.totalSam, machineType: op.machineType, category: extractCategory(op.operationCode), operators };
    }).sort((a, b) => a.category !== b.category ? a.category.localeCompare(b.category) : a.code.localeCompare(b.code));

    const categoryCounts = {};
    operations.forEach(op => { categoryCounts[op.category] = (categoryCounts[op.category] || 0) + 1; });
    const categories = Object.entries(categoryCounts).map(([code, count]) => ({ code, count })).sort((a, b) => a.code.localeCompare(b.code));

    // Resolved after the piece is known to exist — there is no point costing a
    // roster query for a barcode that turned out to be invalid. Never fatal: a
    // stage lookup that fails leaves the station working exactly as it did
    // before checkpoints existed rather than refusing to look up the piece.
    const lineState = await qcStages
      .stageGuardsForPiece({ barcodeId: trimmed, person: { biometricId: biometricId || "" } })
      .catch((e) => {
        console.warn("[QC lookup-piece] stage state skipped:", e.message);
        return { enforced: false, rosterEnforced: false, stages: [], guards: [], progress: null };
      });

    const [defectCatalogue, suggestionRows] = await Promise.all([
      QCDefectType.find({ isActive: true })
        .sort({ isOther: 1, category: 1, sortOrder: 1, code: 1 })
        .select("code name category description isOther")
        .lean()
        .catch((e) => {
          console.warn("[QC lookup-piece] defect catalogue skipped:", e.message);
          return [];
        }),
      QCOperationDefectMap.find({}).select("operationCode defectCodes").lean().catch(() => []),
    ]);
    const defectSuggestions = {};
    for (const r of suggestionRows) defectSuggestions[r.operationCode] = r.defectCodes || [];

    const latestInspection    = existingInspections[0] || null;
    /**
     * DELIBERATELY EMPTY, and kept only so an older client does not break.
     *
     * A re-scan used to arrive with the previous inspection's defects already
     * ticked, on the theory that a piece coming back from rework probably has
     * the same faults. In practice it made the ONE thing a re-inspection exists
     * to do — confirm the fault is gone — the hardest thing on the screen: the
     * inspector had to un-tick everything before they could pass a garment that
     * had been fixed, and any they forgot got recorded as still broken.
     *
     * Every scan now starts clean. The previous inspections are still returned
     * below for the station to show as history, which is what an inspector
     * actually wants: what WAS wrong, not a pre-filled claim about what still is.
     */
    const previousDefectCodes = [];

    /**
     * BANDWIDTH: don't re-send what this same tab already has.
     *
     * `operations` (up to 259 rows), `categories` and `operationScope` are a
     * pure function of the work order — identical on every one of its units —
     * and `defectTypes` / `operationDefectMap` are a global catalogue, the
     * same for every barcode in the factory. An inspector scans dozens of
     * pieces off the same work order in a row, so the common case was paying
     * for that whole payload again on every single scan.
     *
     * The client says what it already has (`knownWorkOrderId`, the last work
     * order's `_id`; `hasDefectCatalog`, a flag it sets after the first
     * catalogue it receives this tab) and, when it matches, this returns an
     * `Unchanged: true` sentinel instead of the array — the frontend keeps
     * what it cached. Still computed above regardless (unitNumber/count
     * validation and `totalOperations` need it), so this only ever saves
     * response bytes, never a query.
     */
    const sameWorkOrder = !!knownWorkOrderId && String(knownWorkOrderId) === String(workOrder._id);

    return res.json({
      success: true, barcode: trimmed, unitNumber,
      workOrder: {
        _id: workOrder._id, workOrderNumber: workOrder.workOrderNumber, workOrderShortId,
        stockItemName: workOrder.stockItemName, stockItemReference: workOrder.stockItemReference,
        quantity: workOrder.quantity, status: workOrder.status, variantAttributes: workOrder.variantAttributes || [],
      },
      manufacturingOrder: customerRequest ? {
        _id: customerRequest._id, requestId: customerRequest.requestId,
        moNumber: `MO-${customerRequest.requestId}`, requestType: customerRequest.requestType,
        customerName: customerRequest.customerInfo?.name, customerPhone: customerRequest.customerInfo?.phone,
        status: customerRequest.status,
      } : null,
      isMeasurementConversion, pieceOwner,
      ...(sameWorkOrder
        ? { operationsUnchanged: true }
        : { productImage, operations, categories, operationScope }),
      totalScans, totalOperations: operations.length,
      existingInspections, previousDefectCodes,

      // ── The line ──────────────────────────────────────────────────────────
      // Where this piece has got to, and what the person holding the scanner
      // may do about it. `guards` carries a verdict per checkpoint computed by
      // the SAME function the save route uses to accept or refuse the write —
      // so the station can never offer a button the server would reject.
      stageEnforced: lineState.enforced,
      rosterEnforced: lineState.rosterEnforced,
      stages: (lineState.stages || []).map((st) => ({
        _id: st._id, code: st.code, name: st.name, serial: st.serial,
      })),
      stageGuards: lineState.guards || [],
      pieceProgress: lineState.progress,

      // The defect catalogue, with the piece — one request instead of two, and
      // it cannot go stale between the lookup and the verdict. Never fatal: a
      // station whose catalogue fails to load can still flag operations.
      //
      // Sent once per tab, not once per scan: it is a global, rarely-changing
      // list (the QC owner edits it from Team, not per shift), so a repeat
      // scan that already has one gets `defectTypesUnchanged` instead — the
      // one real cost is a catalogue edit not reaching an open tab until its
      // next reload, which is the same staleness window the rest of the CMS
      // already accepts for reference data.
      ...(hasDefectCatalog
        ? { defectTypesUnchanged: true }
        : { defectTypes: defectCatalogue, operationDefectMap: defectSuggestions }),
    });
  } catch (err) {
    console.error("[QC lookup-piece] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Shared defect-shape validation ─────────────────────────────────────────
//
// Used by both /save-inspection (online, catalogue in hand) and
// /save-inspection-offline when an offline entry was recorded WITH a cached
// catalogue (lib/qcCatalogCache.js on the client) rather than the bare
// OTHER-with-note thin path. One function so the two write paths cannot drift
// into disagreeing about what a defect or a defect type looks like — see this
// file's git history for why that drift is exactly how a rework report ends
// up with a garbled attribution.

/** Defect types are normalised the same way wherever they appear — nested
 *  under an operation, or standing alone with none. */
function cleanDefectTypesList(list) {
  return Array.isArray(list)
    ? list
        .filter((t) => t && t.code)
        .map((t) => ({
          code: String(t.code).trim().toUpperCase(),
          name: String(t.name || "").trim(),
          category: String(t.category || "").trim(),
          // The note survives only for OTHER. On any other code it would be a
          // second, unsearchable description of a defect that already has a
          // name — and the first place somebody would put information that
          // then never reaches a report.
          note: String(t.code).trim().toUpperCase() === "OTHER"
            ? String(t.note || "").trim().slice(0, 300)
            : "",
        }))
    : [];
}

function cleanDefectsList(defects) {
  return Array.isArray(defects)
    ? defects.filter(d => d && d.operationCode).map(d => ({
        operationCode: d.operationCode, operationName: d.operationName || "",
        operators: Array.isArray(d.operators)
          ? d.operators.map(o => ({ operatorId: o.operatorId || "", operatorName: o.operatorName || "" })).filter(o => o.operatorId || o.operatorName)
          : [],
        types: cleanDefectTypesList(d.types),
      }))
    : [];
}

// ─── POST /save-inspection ─────────────────────────────────────────────────────
router.post("/save-inspection", async (req, res) => {
  try {
    const { barcodeId, workOrderShortId, workOrderId, moRequestId, manufacturingOrderId, status, defects, defectTypes, qcSession, stageId } = req.body;

    if (!barcodeId || !workOrderShortId || !["passed", "defective", "rejected"].includes(status))
      return res.status(400).json({ success: false, message: "barcodeId, workOrderShortId and a valid verdict are required" });

    // Everything below treats rework and reject the same way — both are a
    // FAULT and both must name one. The difference is what happens to the
    // garment afterwards, which is the scan guard's business, not the
    // validator's.
    const isFault = status === "defective" || status === "rejected";

    const cleanTypes = cleanDefectTypesList;
    const cleanDefects = cleanDefectsList(defects);

    // Defects belonging to no operation — a stain, a shade variation, a
    // missing label. Real faults of the garment that no single operation
    // caused, and pinning them on one would invent an attribution that shows
    // up later as a real operator's name in a rework report.
    const cleanDefectTypes = cleanTypes(defectTypes);

    // EITHER form satisfies "say what is wrong". Required for a reject as much
    // as for a rework: scrapping a garment with no reason recorded destroys the
    // only evidence of why, and scrap is the number a factory argues about.
    if (isFault && cleanDefects.length === 0 && cleanDefectTypes.length === 0)
      return res.status(400).json({
        success: false,
        message: status === "rejected"
          ? "A rejected piece must name at least one operation or defect — say why it is being scrapped"
          : "A defective inspection must name at least one operation or defect",
      });

    // OTHER with nothing typed is the one case worth refusing outright: it
    // records that something was wrong and destroys what it was. Checked across
    // both forms, since OTHER can be picked in either.
    const allTypes = [...cleanDefectTypes, ...cleanDefects.flatMap((d) => d.types)];
    if (allTypes.some((t) => t.code === "OTHER" && !t.note))
      return res.status(400).json({
        success: false,
        code: "OTHER_NEEDS_NOTE",
        message: "Say what the defect was — \"Other\" needs a short description.",
      });

    const serverUser = req.session?.user || req.user || {};
    const qcName  = qcSession?.name        || serverUser.name || "QC";
    const qcBioId = qcSession?.biometricId || "";
    const qcId    = qcSession?.biometricId || serverUser.qcId || serverUser._id || "";
    const qcEmail = String(qcSession?.email || serverUser.email || "").toLowerCase();

    // ── THE SCAN GUARD ────────────────────────────────────────────────────────
    //
    // This is the enforcement point. The station asks the same question before
    // it draws its buttons, but that answer is a convenience — a second tab, a
    // stale page, or a piece somebody else scanned in the ninety seconds since
    // the lookup all end here, and here is where they are refused.
    //
    // Three things it stops, and each has actually to be stopped at write time
    // rather than at render time:
    //
    //   · two inspectors sharing a checkpoint both passing the same piece —
    //     the second scan can only overwrite a verdict already given;
    //   · a piece being declared good while it is still failed at another
    //     checkpoint, which is what would make a rework silently disappear;
    //   · a scan attributed to a checkpoint the scanner is not rostered on.
    //
    // 409 rather than 403 for the first two: nothing is wrong with the caller
    // or their permissions, the piece is simply not in a state that accepts
    // this verdict. The station shows the message and moves on.
    const verdict = await qcStages.evaluateScan({
      barcodeId,
      stageId: stageId || null,
      status,
      person: { biometricId: qcBioId, email: qcEmail },
    });

    if (!verdict.allowed) {
      const conflict = verdict.code === "STAGE_ALREADY_PASSED"
        || verdict.code === "BLOCKED_BY_REWORK"
        || verdict.code === "PIECE_REJECTED";
      return res.status(conflict ? 409 : 400).json({
        success: false,
        code: verdict.code,
        message: verdict.message,
        passedBy: verdict.passedBy || null,
        blockedBy: verdict.blockedBy || null,
        rejectedBy: verdict.rejectedBy || null,
        pieceProgress: verdict.progress || null,
      });
    }

    const stage = verdict.stage || null;
    // Only a DEFECT starts a rework round; a re-inspection that passes is the
    // round being closed, and counting it as another one would double every
    // rework figure on the overview.
    const reworkRound = verdict.reworkRound || 0;

    const record = await QCInspection.create({
      date: istDateString(), barcodeId, workOrderShortId, workOrderId,
      moRequestId, manufacturingOrderId, status,
      defects: isFault ? cleanDefects : [],
      defectTypes: isFault ? cleanDefectTypes : [],
      stageId:     stage?._id    || null,
      stageCode:   stage?.code   || "",
      stageName:   stage?.name   || "",
      stageSerial: stage?.serial ?? null,
      reworkRound,
      isRework: reworkRound > 0,
      inspectedByQCName: qcName, inspectedByBiometricId: qcBioId, inspectedByQCId: qcId,
      inspectedByEmail: qcEmail,
    });

    // Recomputed AFTER the write so the station can redraw the piece's strip
    // from the response instead of re-scanning to find out what it just did.
    const progress = stage
      ? await qcStages.pieceProgress(barcodeId).catch(() => null)
      : null;

    res.json({ success: true, record, pieceProgress: progress });
  } catch (err) {
    console.error("[QC save-inspection] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * ─── POST /save-inspection-offline ──────────────────────────────────────────
 *
 * THE THIN PATH. An inspector whose network is down cannot reach `/lookup-piece`
 * at all — no work order, no operations catalogue, nothing to cross-check
 * against. What they still have is the barcode in front of them and a verdict.
 * This endpoint accepts exactly that: `{barcodeId, status, note}`, and resolves
 * the work order itself the same way `/lookup-piece` does, from the barcode
 * alone (`parseBarcode` + `findWorkOrderByShortId`) — nothing here is trusted
 * from a stale client-side lookup, because there wasn't one.
 *
 * TWO SHAPES NOW (29 Aug 2026, explicit request: "keep them in the
 * localstorage or anywhere so for the network lost situation these
 * operations or like the defects options are needed to fetch from the
 * memory... so the flow shouldn't gonna break"). The client now caches each
 * work order's operations and the defect-type catalogue in localStorage
 * (lib/qcCatalogCache.js) from its last online lookup, so a later offline
 * scan of the SAME work order can still show the real picker rather than the
 * bare form below — and when it does, `defects` / `defectTypes` arrive here
 * shaped exactly like `/save-inspection`'s, validated with the same function
 * (`cleanDefectsList` / `cleanDefectTypesList`, defined above), so an offline
 * record with a catalogue on hand carries real operation attribution, not a
 * flattened note.
 *
 * No `operationCode` is still the fallback: when this barcode's work order was
 * never looked up on this device — a fresh install, a different line, cache
 * evicted — there is no catalogue to have cached, and a fault is recorded as a
 * single OTHER defect type carrying the inspector's note instead. That note is
 * REQUIRED for a defect/reject exactly as the online form requires picking at
 * least one defect type; a garment with a fault and no attribution to check it
 * against still gets ONE.
 *
 * THE SAME GUARD, NOT A WEAKER ONE. `qcStages.evaluateScan` re-reads this
 * piece's live state at write time regardless of how old the offline record
 * is — a piece another inspector already passed or rejected in the meantime is
 * refused here exactly as it would be from the live station, 409 either way.
 * The queued record's `stageId` is whatever the inspector's device captured at
 * scan time (their own cached checkpoint, from the day-session, not a lookup);
 * if none was captured and the factory enforces checkpoints, this returns
 * `STAGE_REQUIRED` rather than guessing one — the frontend surfaces that as a
 * sync failure the inspector must resolve with a normal, online scan.
 */
router.post("/save-inspection-offline", async (req, res) => {
  try {
    const { barcodeId, status, note, qcSession, stageId, defects, defectTypes } = req.body;

    if (!barcodeId || !["passed", "defective", "rejected"].includes(status))
      return res.status(400).json({ success: false, message: "barcodeId and a valid verdict are required" });

    const isFault = status === "defective" || status === "rejected";
    const trimmedNote = String(note || "").trim().slice(0, 300);

    // A cached catalogue was on screen when this was recorded — the real
    // picker, not the bare fallback form — so validate it exactly like the
    // online route does, rather than forcing it through the OTHER-with-note
    // shape it was never in.
    const cleanDefects = cleanDefectsList(defects);
    const cleanDefectTypes = cleanDefectTypesList(defectTypes);
    const hasStructuredDefect = cleanDefects.length > 0 || cleanDefectTypes.length > 0;

    if (isFault && hasStructuredDefect) {
      const allTypes = [...cleanDefectTypes, ...cleanDefects.flatMap((d) => d.types)];
      if (allTypes.some((t) => t.code === "OTHER" && !t.note))
        return res.status(400).json({
          success: false,
          code: "OTHER_NEEDS_NOTE",
          message: "Say what the defect was — \"Other\" needs a short description.",
        });
    } else if (isFault && !trimmedNote) {
      // THE THIN PATH — no catalogue was available offline, exactly as before
      // this change: the only thing recoverable is what the inspector typed.
      return res.status(400).json({
        success: false,
        code: "OTHER_NEEDS_NOTE",
        message: status === "rejected"
          ? "Say why this piece is being scrapped — a note is required."
          : "Say what was wrong — a note is required for an offline defect.",
      });
    }

    const parsed = parseBarcode(barcodeId);
    if (!parsed.success)
      return res.status(400).json({ success: false, message: "Invalid barcode format. Expected WO-<shortId>-<unit>" });

    const workOrder = await findWorkOrderByShortId(parsed.workOrderShortId);
    if (!workOrder)
      return res.status(404).json({ success: false, message: `Work order "${parsed.workOrderShortId}" not found` });
    if (parsed.unitNumber > workOrder.quantity)
      return res.status(400).json({ success: false, message: `Unit ${parsed.unitNumber} out of range (1–${workOrder.quantity})` });

    let moRequestId = null;
    if (workOrder.customerRequestId) {
      const cr = await CustomerRequest.findById(workOrder.customerRequestId).select("requestId").lean().catch(() => null);
      moRequestId = cr?.requestId || null;
    }

    const serverUser = req.session?.user || req.user || {};
    const qcName  = qcSession?.name        || serverUser.name || "QC";
    const qcBioId = qcSession?.biometricId || "";
    const qcId    = qcSession?.biometricId || serverUser.qcId || serverUser._id || "";
    const qcEmail = String(qcSession?.email || serverUser.email || "").toLowerCase();

    const verdict = await qcStages.evaluateScan({
      barcodeId, stageId: stageId || null, status,
      person: { biometricId: qcBioId, email: qcEmail },
    });

    if (!verdict.allowed) {
      const conflict = verdict.code === "STAGE_ALREADY_PASSED"
        || verdict.code === "BLOCKED_BY_REWORK"
        || verdict.code === "PIECE_REJECTED";
      return res.status(conflict ? 409 : 400).json({
        success: false,
        code: verdict.code,
        message: verdict.message,
        passedBy: verdict.passedBy || null,
        blockedBy: verdict.blockedBy || null,
        rejectedBy: verdict.rejectedBy || null,
        pieceProgress: verdict.progress || null,
      });
    }

    const stage = verdict.stage || null;
    const reworkRound = verdict.reworkRound || 0;

    const record = await QCInspection.create({
      date: istDateString(), barcodeId, workOrderShortId: parsed.workOrderShortId,
      workOrderId: workOrder._id, moRequestId, manufacturingOrderId: workOrder.customerRequestId || null,
      status,
      defects: isFault && hasStructuredDefect ? cleanDefects : [],
      defectTypes: isFault
        ? (hasStructuredDefect ? cleanDefectTypes : [{ code: "OTHER", name: "Other", category: "", note: trimmedNote }])
        : [],
      stageId:     stage?._id    || null,
      stageCode:   stage?.code   || "",
      stageName:   stage?.name   || "",
      stageSerial: stage?.serial ?? null,
      reworkRound,
      isRework: reworkRound > 0,
      inspectedByQCName: qcName, inspectedByBiometricId: qcBioId, inspectedByQCId: qcId,
      inspectedByEmail: qcEmail,
      recordedOffline: true,
    });

    const progress = stage
      ? await qcStages.pieceProgress(barcodeId).catch(() => null)
      : null;

    res.json({ success: true, record, pieceProgress: progress });
  } catch (err) {
    console.error("[QC save-inspection-offline] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /piece-operators ──────────────────────────────────────────────────────
// On-demand: given a barcode, returns every operator + machine + scan time
// from ProductionTracking. Used by the QC overview "Fetch Operator" button.
router.get("/piece-operators", async (req, res) => {
  try {
    const { barcode } = req.query;
    if (!barcode) return res.status(400).json({ success: false, message: "barcode required" });

    const scans = await ProductionTracking.aggregate([
      { $match: { "machines.operators.barcodeScans.barcodeId": barcode.trim() } },
      { $unwind: "$machines" },
      { $unwind: "$machines.operators" },
      { $unwind: "$machines.operators.barcodeScans" },
      { $match: { "machines.operators.barcodeScans.barcodeId": barcode.trim() } },
      { $lookup: { from: "machines", localField: "machines.machineId", foreignField: "_id", as: "_m" } },
      { $project: {
        _id:          0,
        operatorId:   "$machines.operators.operatorIdentityId",
        operatorName: "$machines.operators.operatorName",
        activeOps:    "$machines.operators.barcodeScans.activeOps",
        timeStamp:    "$machines.operators.barcodeScans.timeStamp",
        machineName:  { $arrayElemAt: ["$_m.name", 0] },
      }},
      { $sort: { timeStamp: 1 } },
    ]);

    // Resolve names from Employee if operatorName is blank in the tracking doc
    const missingIds = [...new Set(
      scans.filter(s => !s.operatorName && s.operatorId).map(s => s.operatorId)
    )];
    let empNameMap = new Map();
    if (missingIds.length) {
      const emps = await Employee.find({ identityId: { $in: missingIds } })
        .select("identityId firstName middleName lastName").lean();
      empNameMap = new Map(emps.map(e => [
        e.identityId,
        [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim() || e.identityId,
      ]));
    }

    const operators = scans.map(s => ({
      operatorId:   s.operatorId,
      operatorName: s.operatorName || empNameMap.get(s.operatorId) || s.operatorId || "Unknown",
      activeOps:    Array.isArray(s.activeOps) ? s.activeOps : [],
      timeStamp:    s.timeStamp,
      machineName:  s.machineName || "—",
    }));

    res.json({ success: true, barcode, operators });
  } catch (err) {
    console.error("[QC piece-operators]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /trend  ───────────────────────────────────────────────────────────────
// Returns per-day DPH stats for the past N days (used by the overview trend chart)
// Must be defined BEFORE /inspections to avoid any path conflicts
router.get("/trend", async (req, res) => {
  try {
    const { days = 7, end } = req.query;
    const n = Math.min(Math.max(parseInt(days) || 7, 1), 90);

    // The window ENDS on `end` (an IST YYYY-MM-DD), defaulting to today.
    //
    // It used to always end on today, whatever date the overview was showing.
    // Open a day three weeks back and the page put that day's figures beside a
    // trend for the last seven days — a chart that looked broken or empty when
    // it was simply describing a different week. The anchor now follows the
    // date being viewed. Future dates are clamped to today: there is nothing
    // to plot ahead of now, and a bad query should not silently return a
    // window of empty buckets.
    const todayIST = () => {
      const t = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
    };
    const today = todayIST();
    const anchor = (typeof end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(end) && end <= today)
      ? end
      : today;

    // Build IST date strings oldest → newest, ending at the anchor.
    const [ay, am, ad] = anchor.split("-").map(Number);
    const dates = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(ay, am - 1, ad));
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
      );
    }

    // SCOPED THE SAME WAY AS /inspections. If it were not, an inspector would
    // see their own four pieces beside a defect-rate curve drawn from the whole
    // department — two numbers on one screen that cannot both be about the same
    // thing, which is worse than either alone.
    const [viewer, deptConfigured] = await Promise.all([
      qcViewer.resolveViewer(req),
      qcViewer.departmentConfigured(),
    ]);
    const trendFilter = { date: { $in: dates } };
    qcViewer.applyViewerFilter(
      trendFilter,
      qcViewer.viewerFilter(viewer, { departmentConfigured: deptConfigured }),
    );

    // Fetch status + defects + barcodeId (minimal projection)
    const records = await QCInspection.find(trendFilter)
      .select("date status defects barcodeId").lean();

    /**
     * COUNTED BY GARMENT, NOT BY SCAN (29 Aug 2026, same request as
     * /inspections' `productCounts` — one figure the whole page should agree
     * on). A garment re-inspected twice at one checkpoint, or inspected at
     * three, used to add two or three to a single day's bucket; it adds one
     * now, however many scans it took. `scans` is kept alongside as the raw
     * event count — still useful context, just not what DHU is computed from.
     *
     * MUTUALLY EXCLUSIVE, same rule as /inspections' productCounts: a garment
     * is `passed` only if every scan it collected that day passed, and
     * `defective` otherwise — never both. `rejected` is a detail of
     * `defective` (a scrapped garment is also a defective one), reported
     * separately rather than as a third bucket that would need to add up too.
     */
    const grouped = {};
    for (const date of dates)
      grouped[date] = { date, scans: 0, defectOps: 0, byBarcode: new Map() };

    for (const r of records) {
      const g = grouped[r.date];
      if (!g) continue;
      g.scans++;
      if (!g.byBarcode.has(r.barcodeId)) g.byBarcode.set(r.barcodeId, []);
      g.byBarcode.get(r.barcodeId).push(r.status);
      if (r.status !== "passed") g.defectOps += (r.defects || []).length;
    }

    // Build ordered trend array with DPH and a short display label (MM/DD)
    const trend = dates.map((d) => {
      const g = grouped[d];
      const total = g.byBarcode.size;
      let passed = 0, defective = 0, rejected = 0;
      for (const statuses of g.byBarcode.values()) {
        if (statuses.every((s) => s === "passed")) passed++;
        else defective++;
        if (statuses.includes("rejected")) rejected++;
      }
      return {
        date: d, total, passed, defective, rejected,
        defectOps: g.defectOps, scans: g.scans,
        // `defective` already INCLUDES every rejected garment (rejected is a
        // detail of defective, not a separate exclusive bucket — see above),
        // so this is `defective / total`, not `(defective + rejected) /
        // total`, which would have counted a scrapped garment twice.
        dph:         total > 0 ? +((defective / total) * 100).toFixed(1) : 0,
        displayDate: d.slice(5).replace("-", "/"),   // "06/27"
      };
    });

    return res.json({ success: true, trend });
  } catch (err) {
    console.error("[QC trend] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /inspections ──────────────────────────────────────────────────────────
router.get("/inspections", async (req, res) => {
  try {
    const { date, startDate, endDate, status, qcBiometricId, manufacturingOrderId } = req.query;

    // ── WHOSE DAY IS THIS ────────────────────────────────────────────────────
    //
    // An inspector sees their own inspections; the QC owner sees the
    // department's. Enforced HERE rather than by hiding rows in the browser,
    // because a filter the client applies is a filter the client can remove —
    // the rows would still have been sent, and "only their information" would
    // be true of the screen and false of the response.
    //
    // See services/qcViewer.js for the two-identity problem this resolves
    // (email in the CMS, biometric id at the station) and why it fails closed.
    const [viewer, deptConfigured] = await Promise.all([
      qcViewer.resolveViewer(req),
      qcViewer.departmentConfigured(),
    ]);
    const scopeClause = qcViewer.viewerFilter(viewer, { departmentConfigured: deptConfigured });

    const filter = {};

    if (date) filter.date = date;
    else if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = startDate;
      if (endDate)   filter.date.$lte = endDate;
    } else if (!manufacturingOrderId) {
      // Only default to "today" when this isn't an MO-scoped query — an MO tab
      // wants the full inspection history for that order, not just today's.
      filter.date = istDateString();
    }
    if (status && ["passed", "defective", "rejected"].includes(status)) filter.status = status;
    if (qcBiometricId) filter.inspectedByBiometricId = qcBiometricId;
    if (manufacturingOrderId) filter.manufacturingOrderId = manufacturingOrderId;

    qcViewer.applyViewerFilter(filter, scopeClause);

    // Every field the overview actually reads, and nothing else (29 Aug 2026,
    // performance). This used to be an unprojected find() whose rows were then
    // spread wholesale into the response — shipping `__v`, both timestamps and
    // the full nested defect tree on every row, roughly half of it unread by
    // any consumer.
    const inspections = await QCInspection.find(filter)
      .select("barcodeId date status defects defectTypes workOrderId workOrderShortId manufacturingOrderId moRequestId stageId stageCode stageName stageSerial inspectedAt inspectedByQCName inspectedByEmail inspectedByBiometricId isRework reworkRound")
      .sort({ inspectedAt: -1 })
      .lean();

    const woIds = [...new Set(inspections.map(i => i.workOrderId).filter(Boolean).map(String))];
    const wos   = woIds.length
      ? await WorkOrder.find({ _id: { $in: woIds } }).select("workOrderNumber stockItemName stockItemReference variantAttributes stockItemId").lean()
      : [];
    const woMap = new Map(wos.map(w => [w._id.toString(), w]));

    const StockItem    = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
    const stockItemIds = [...new Set(wos.map(w => w.stockItemId).filter(Boolean).map(String))];
    const stockItems   = stockItemIds.length
      ? await StockItem.find({ _id: { $in: stockItemIds } }).select("name images variants.attributes variants.images").lean()
      : [];
    const siMap = new Map(stockItems.map(si => [si._id.toString(), si]));

    const masterOps = await getMasterOperations();
    const masterMap = new Map(masterOps.map(op => [op.operationCode.trim().toLowerCase(), op.name]));

    // ── Who the piece is FOR ─────────────────────────────────────────────────
    // The overview groups a day's work by customer, and an inspection knows its
    // manufacturing order but not the customer behind it. One batched lookup
    // rather than a join per row: a normal day is a few hundred inspections
    // across a handful of orders.
    const moIds = [...new Set(inspections.map(i => i.manufacturingOrderId).filter(Boolean).map(String))];
    const mos   = moIds.length
      ? await CustomerRequest.find({ _id: { $in: moIds } })
          .select("requestId customerInfo requestType status").lean()
      : [];
    const moMap = new Map(mos.map(m => [m._id.toString(), m]));

    // ── Where each piece has got to on the line ──────────────────────────────
    // Deliberately NOT limited to this date's scans: a piece inspected at
    // end-line today may have cleared in-line yesterday, and a strip that only
    // showed today would report it as skipped. One query for every barcode on
    // screen — see pieceProgressMany for why this is not done per row.
    const stages = await qcStages.listStages().catch(() => []);
    const pieceStates = stages.length
      ? await qcStages
          .pieceProgressMany(inspections.map(i => i.barcodeId), stages)
          .catch((e) => { console.warn("[QC inspections] piece states skipped:", e.message); return {}; })
      : {};

    const enriched = inspections.map(insp => {
      const wo      = insp.workOrderId ? woMap.get(insp.workOrderId.toString()) : null;
      const mo      = insp.manufacturingOrderId ? moMap.get(insp.manufacturingOrderId.toString()) : null;
      const defects = (insp.defects || []).map(d => ({
        ...d,
        operationName: masterMap.get((d.operationCode || "").trim().toLowerCase()) || d.operationName || "",
      }));
      const progress = pieceStates[insp.barcodeId] || null;
      return {
        ...insp, defects,
        workOrderNumber:   wo?.workOrderNumber || `WO-${insp.workOrderShortId}`,
        productName:       wo?.stockItemName   || "Unknown Product",
        productImage:      resolveProductImage(wo, siMap),
        variantAttributes: wo?.variantAttributes || [],
        customerName:      mo?.customerInfo?.name  || "",
        customerPhone:     mo?.customerInfo?.phone || "",
        moNumber:          mo?.requestId ? `MO-${mo.requestId}` : "",
        // The piece's whole journey, attached to every row that mentions it, so
        // the table can draw the strip without a second request per row.
        pieceProgress:     progress,
        pieceReworkCount:  progress?.reworkCount ?? 0,
        pieceComplete:     progress?.complete ?? false,
        currentStage:      progress?.currentStage || null,
      };
    });

    const passed         = enriched.filter(i => i.status === "passed").length;
    const defective      = enriched.filter(i => i.status === "defective").length;
    const rejected       = enriched.filter(i => i.status === "rejected").length;
    const totalDefectOps = enriched.reduce((sum, i) => sum + (i.defects?.length || 0), 0);

    /**
     * THE SAME DAY, COUNTED BY GARMENT INSTEAD OF BY SCAN (explicit request,
     * 29 Aug 2026: "defects should be count as per the product ok, means even
     * though 2-3 defects made for an single product but the count need to
     * mark as 1... as per the product wise").
     *
     * `passed`/`defective`/`rejected` above are SCAN counts — a garment
     * inspected at three checkpoints, or re-inspected twice at one after a
     * fix, contributes three rows to the totals above even though it is one
     * garment. These are DISTINCT-BARCODE counts for the same day instead: a
     * garment counts once in `defective` no matter how many defect entries or
     * how many failed scans it collected today. The two are deliberately kept
     * side by side rather than one replacing the other — "12 defective scans"
     * and "5 defective garments" are both true and answer different
     * questions; the overview's headline tiles read from this block, the
     * per-checkpoint/per-operator breakdowns still read from the scan counts
     * above, where a per-operation tally naturally means occurrences, not
     * garments.
     */
    // `passed`/`defective` are MUTUALLY EXCLUSIVE by construction — a garment
    // counts as passed only if EVERY scan it collected today passed, and as
    // defective if it collected even one that didn't (including a reject).
    // That is what makes `passed + defective === total` exactly, which is
    // what a "pass/fail" figure (and the donut this feeds — see the
    // overview's `ring`) has to be able to promise; a garment double-counted
    // as both because it cleared one checkpoint and failed another today
    // would make the two numbers add up to more than the garments inspected.
    // `rejected` is reported separately as a DETAIL of defective (a scrapped
    // garment is also a defective one), not a third exclusive bucket.
    const byBarcode = new Map();
    for (const i of enriched) {
      if (!byBarcode.has(i.barcodeId)) byBarcode.set(i.barcodeId, []);
      byBarcode.get(i.barcodeId).push(i.status);
    }
    let productsPassed = 0, productsDefective = 0, productsRejected = 0;
    for (const statuses of byBarcode.values()) {
      if (statuses.every((s) => s === "passed")) productsPassed++;
      else productsDefective++;
      if (statuses.includes("rejected")) productsRejected++;
    }
    const productCounts = {
      total: byBarcode.size,
      passed: productsPassed,
      defective: productsDefective,
      rejected: productsRejected,
    };
    const byOperation    = {};
    const byOperator     = {};
    const byQCPerson     = {};

    enriched.forEach(i => {
      if (i.inspectedByQCName) byQCPerson[i.inspectedByQCName] = (byQCPerson[i.inspectedByQCName] || 0) + 1;
      (i.defects || []).forEach(d => {
        const opKey = d.operationName ? `${d.operationCode} — ${d.operationName}` : d.operationCode;
        byOperation[opKey] = (byOperation[opKey] || 0) + 1;
        (d.operators || []).forEach(o => {
          if (o.operatorName) byOperator[o.operatorName] = (byOperator[o.operatorName] || 0) + 1;
        });
      });
    });

    // Per-checkpoint tallies for the day, in line order — the header strip on
    // the overview. Built from the scans taken here, NOT from piece states:
    // this answers "what happened at each checkpoint today", which is a
    // different question from "where does each piece stand".
    const byStage = stages.map((st) => {
      const rows = enriched.filter(i => String(i.stageId || "") === String(st._id));
      const stagePassed    = rows.filter(i => i.status === "passed").length;
      const stageDefective = rows.filter(i => i.status === "defective").length;
      const stageRejected  = rows.filter(i => i.status === "rejected").length;
      return {
        stageId: String(st._id), stageCode: st.code, stageName: st.name, serial: st.serial,
        total: rows.length, passed: stagePassed, defective: stageDefective, rejected: stageRejected,
        rework: rows.filter(i => i.isRework).length,
        inspectors: [...new Set(rows.map(i => i.inspectedByQCName).filter(Boolean))],
      };
    });

    // Scans with no checkpoint at all — every inspection taken before stages
    // existed, plus anything recorded while they were unconfigured. Reported
    // rather than hidden, so a strip that looks empty has a stated reason.
    const unstaged = enriched.filter(i => !i.stageId).length;

    // ── Pending rework — LIVE, not scoped to the date filter above ──────────
    // "how many products are sent for rework right now" is a today-independent
    // question: a piece sent back on Monday and still uncleared on Friday is
    // still pending on Friday, whichever date this page happens to be looking
    // at. Scoped to the SAME viewer clause as everything else on this route
    // (an inspector's tile counts their own open rework; the owner's counts
    // the department's) — see qcStages.pendingReworkSnapshot's own header for
    // why this is a distinct question from `totalRework` above (a same-day
    // SCAN count) and from `reworkCount` (an all-time TALLY).
    const pendingRework = await qcStages
      .pendingReworkSnapshot(scopeClause || {})
      .catch((e) => { console.warn("[QC inspections] pending-rework snapshot skipped:", e.message); return { count: 0, pieces: [] }; });

    res.json({
      success: true, inspections: enriched,
      total: enriched.length, passed, defective, rejected, totalDefectOps,
      productCounts,
      pendingRework: { count: pendingRework.count },
      byOperation, byOperator, byQCPerson,
      stages: stages.map(st => ({ _id: st._id, code: st.code, name: st.name, serial: st.serial })),
      byStage, unstaged,
      totalRework: enriched.filter(i => i.isRework).length,
      // Stated, not implied. A screen showing four pieces when the floor
      // inspected forty is alarming unless it says why, so the client can
      // caption it — and the owner's view says so too, for the opposite reason.
      viewer: {
        name: viewer.name,
        email: viewer.email,
        biometricId: viewer.biometricId,
        role: viewer.role,
        isAdmin: viewer.isAdmin,
        scope: scopeClause ? "mine" : "all",
        canSeeEveryone: viewer.canSeeEveryone,
        identified: viewer.identified,
      },
    });
  } catch (err) {
    console.error("[QC inspections] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /customer-summary ─────────────────────────────────────────────────────
//
// THE DAY'S WORK, GROUPED BY WHO IT WAS FOR.
//
// Every other view on this page is organised around the factory: this
// checkpoint, that inspector, this operation. None of them answers the question
// a customer conversation starts with — "what did you make for us, and how much
// of it had to be done twice". That is what this is.
//
// TWO REWORK FIGURES, AND THE DIFFERENCE MATTERS
// ----------------------------------------------
//   reworkInWindow  defect verdicts recorded in the period being viewed. What
//                   happened today.
//   reworkTotal     every time these pieces have EVER been sent back, at any
//                   checkpoint, on any date. What the customer's garments have
//                   actually been through.
//
// The second is the one a customer would recognise, and it is deliberately not
// clipped to the window: a piece failed on Monday and fixed on Tuesday would
// otherwise show as zero rework in every view except Monday's, which is how a
// quality problem disappears from a report.
router.get("/customer-summary", async (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;

    // Same scope as everything else on the overview — an inspector sees the
    // customers whose garments THEY inspected.
    const [viewer, deptConfigured] = await Promise.all([
      qcViewer.resolveViewer(req),
      qcViewer.departmentConfigured(),
    ]);

    const filter = {};
    if (date) filter.date = date;
    else if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = startDate;
      if (endDate)   filter.date.$lte = endDate;
    } else filter.date = istDateString();

    qcViewer.applyViewerFilter(
      filter,
      qcViewer.viewerFilter(viewer, { departmentConfigured: deptConfigured }),
    );

    const inspections = await QCInspection.find(filter)
      .select("barcodeId workOrderId manufacturingOrderId status stageId stageName isRework inspectedAt inspectedByQCName date defectTypes")
      .sort({ inspectedAt: -1 })
      .lean();

    if (!inspections.length) {
      return res.json({ success: true, customers: [], total: 0, pieces: 0 });
    }

    const woIds = [...new Set(inspections.map(i => i.workOrderId).filter(Boolean).map(String))];
    const moIds = [...new Set(inspections.map(i => i.manufacturingOrderId).filter(Boolean).map(String))];

    const [wos, mos, stages] = await Promise.all([
      woIds.length ? WorkOrder.find({ _id: { $in: woIds } })
        .select("workOrderNumber stockItemName stockItemId variantAttributes").lean() : [],
      moIds.length ? CustomerRequest.find({ _id: { $in: moIds } })
        .select("requestId customerInfo requestType status").lean() : [],
      qcStages.listStages().catch(() => []),
    ]);
    const woMap = new Map(wos.map(w => [w._id.toString(), w]));
    const moMap = new Map(mos.map(m => [m._id.toString(), m]));

    const siIds = [...new Set(wos.map(w => w.stockItemId).filter(Boolean).map(String))];
    const sis   = siIds.length
      ? await StockItem.find({ _id: { $in: siIds } }).select("name images variants.attributes variants.images").lean()
      : [];
    const siMap = new Map(sis.map(si => [si._id.toString(), si]));

    // All-time progress for every piece that appears in the window — this is
    // what makes reworkTotal honest across dates. One query, not one per piece.
    const pieceStates = stages.length
      ? await qcStages.pieceProgressMany(inspections.map(i => i.barcodeId), stages).catch(() => ({}))
      : {};

    /* Customer → product → piece. Three levels because that is the shape of the
       question: which customer, which style, and how did each garment of that
       style fare. */
    const customers = new Map();

    for (const insp of inspections) {
      const wo = insp.workOrderId ? woMap.get(insp.workOrderId.toString()) : null;
      const mo = insp.manufacturingOrderId ? moMap.get(insp.manufacturingOrderId.toString()) : null;

      // Pieces with no manufacturing order are real and must not vanish from a
      // total — they are grouped under one honest heading instead.
      const custKey   = (mo?.customerInfo?.name || "").trim() || "Unassigned";
      const custPhone = mo?.customerInfo?.phone || "";

      if (!customers.has(custKey)) {
        customers.set(custKey, {
          customerName: custKey,
          customerPhone: custPhone,
          orders: new Set(),
          products: new Map(),
        });
      }
      const cust = customers.get(custKey);
      if (custPhone) cust.customerPhone = custPhone;
      if (mo?.requestId) cust.orders.add(`MO-${mo.requestId}`);

      const prodKey = wo?.stockItemName || "Unknown Product";
      if (!cust.products.has(prodKey)) {
        cust.products.set(prodKey, {
          productName: prodKey,
          productImage: resolveProductImage(wo, siMap),
          pieces: new Map(),
          scans: 0,
          passedScans: 0,
          defectiveScans: 0,
          rejectedScans: 0,
          reworkInWindow: 0,
        });
      }
      const prod = cust.products.get(prodKey);

      prod.scans++;
      if (insp.status === "passed") prod.passedScans++;
      else if (insp.status === "rejected") { prod.defectiveScans++; prod.rejectedScans++; }
      // Only a rework counts as rework — a scrapped garment was never sent
      // back, and counting it would inflate the figure that measures redone work.
      else { prod.defectiveScans++; prod.reworkInWindow++; }

      if (!prod.pieces.has(insp.barcodeId)) {
        const progress = pieceStates[insp.barcodeId] || null;
        prod.pieces.set(insp.barcodeId, {
          barcodeId: insp.barcodeId,
          workOrderNumber: wo?.workOrderNumber || "",
          reworkTotal: progress?.reworkCount ?? 0,
          complete: progress?.complete ?? false,
          currentStage: progress?.currentStage || null,
          lastStatus: insp.status,
          lastAt: insp.inspectedAt,
          inspectors: [],
        });
      }
      const piece = prod.pieces.get(insp.barcodeId);
      if (insp.inspectedByQCName && !piece.inspectors.includes(insp.inspectedByQCName)) {
        piece.inspectors.push(insp.inspectedByQCName);
      }
    }

    const out = [...customers.values()].map((c) => {
      const products = [...c.products.values()].map((p) => {
        const pieces = [...p.pieces.values()];
        return {
          productName: p.productName,
          productImage: p.productImage,
          pieceCount: pieces.length,
          scans: p.scans,
          passedScans: p.passedScans,
          defectiveScans: p.defectiveScans,
          rejectedScans: p.rejectedScans,
          reworkInWindow: p.reworkInWindow,
          // Across the whole life of these pieces — see the header.
          reworkTotal: pieces.reduce((n, x) => n + x.reworkTotal, 0),
          // `piecesInRework` stays and carries the same distinction the
          // dropped "worst piece" figure was for: 4 rework across 4 garments
          // and 4 across 1 are different problems, and the pair
          // (reworkTotal, piecesInRework) says which without a third column.
          piecesInRework: pieces.filter((x) => x.reworkTotal > 0).length,
          completed: pieces.filter((x) => x.complete).length,
          pieces: pieces.sort((a, b) => b.reworkTotal - a.reworkTotal || new Date(b.lastAt) - new Date(a.lastAt)),
        };
      }).sort((a, b) => b.reworkTotal - a.reworkTotal || b.pieceCount - a.pieceCount);

      return {
        customerName: c.customerName,
        customerPhone: c.customerPhone,
        orders: [...c.orders],
        productCount: products.length,
        pieceCount: products.reduce((n, p) => n + p.pieceCount, 0),
        scans: products.reduce((n, p) => n + p.scans, 0),
        defectiveScans: products.reduce((n, p) => n + p.defectiveScans, 0),
        reworkTotal: products.reduce((n, p) => n + p.reworkTotal, 0),
        completed: products.reduce((n, p) => n + p.completed, 0),
        products,
      };
    }).sort((a, b) => b.reworkTotal - a.reworkTotal || b.pieceCount - a.pieceCount);

    res.json({
      success: true,
      customers: out,
      total: out.length,
      pieces: out.reduce((n, c) => n + c.pieceCount, 0),
      stagesConfigured: stages.length > 0,
    });
  } catch (err) {
    console.error("[QC customer-summary] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /report ──────────────────────────────────────────────────────────────
//
// THE QUALCOM REPORT, AS THE FACTORY ALREADY WRITES IT.
//
// The floor has a paper format it has always used — a defect matrix with the
// categories down the side and HOURS across the top (H1…H8), an RFT / REWORK /
// REJECT summary beside it, and one sheet per checking point: ENDLINE STITCHING,
// MIDDLE CHECKING, FINAL CHECKING. This endpoint produces exactly that shape
// from the inspection records, so the export drops into the existing workflow
// instead of asking anybody to read a new layout.
//
// THE COLUMNS ARE THE ONLY THING THAT MOVES. `period` chooses the reporting
// span and the columns become that span's natural sub-unit — hours within a
// day, days within a week, weeks within a month, months within a year, years.
// The rows, the summary block and the header are identical every time, because
// the point of a standard format is that the eye knows where to look.
//
// WHY THE ROWS ARE OPERATIONS AND NOT THE PRINTED DEFECT CODES. The paper form
// lists a fixed taxonomy (Y1 SLUB/KNOT, S4 PUCKERING, …). QC here does not
// record against that taxonomy — a defect is flagged against the OPERATION that
// produced it (S008 Sew Btn Placket), which is more specific and is what makes
// the operator attribution possible at all. Inventing a mapping between the two
// would be guessing, and a report that quietly guesses is worse than one that
// is plainly in its own vocabulary. So the operation code goes in the CODE
// column and its name in the DEFECT column, grouped under the form's own
// category headings via the code's leading letter — which, usefully, already
// lines up (S → STITCHING, P → PRESENTATION, K → CONSTRUCTION).
//
// Scoped exactly like every other read here: an inspector exports their own
// work, the owner exports the department's.

/** The paper form's category headings, keyed by an operation code's first letter. */
const QUALCOM_CATEGORIES = {
  Y: "YARN",
  K: "CONSTRUCTION",
  D: "DYEING / PRINTING",
  A: "ASPECT",
  C: "CLEANLINESS",
  S: "STITCHING",
  P: "PRESENTATION",
  L: "LABEL",
  Z: "SECURITY",
};

/** IST wall-clock parts for a Date. Every bucket boundary below is IST, because
 *  the `date` field on an inspection already is and the two must not disagree. */
const istParts = (d) => {
  const t = new Date(new Date(d).getTime() + 5.5 * 60 * 60 * 1000);
  return {
    y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(),
    h: t.getUTCHours(), min: t.getUTCMinutes(),
    iso: `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`,
    dow: t.getUTCDay(), // 0 = Sunday
  };
};

const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const addDaysISO = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * The span of dates a report covers and the columns it is bucketed into.
 *
 * Returns `{ dates, buckets, spanLabel, bucketOf }` where `bucketOf(inspection)`
 * gives the column index, or -1 for a record that falls outside every bucket
 * (which cannot happen for a well-formed span, but is handled rather than
 * silently counted into column zero).
 */
function buildPeriod(period, anchorISO) {
  const [ay, am, ad] = anchorISO.split("-").map(Number);

  if (period === "hourly") {
    // One day, split by hour — the form's own layout. Anchored to the floor's
    // actual shift, 9:30 AM to 6:30 PM IST, not to whatever hour the data
    // happens to start at: a single stray record (a scan logged just after
    // midnight IST, a backfilled entry) used to pull the whole grid's start
    // hour down with it, so a normal shift's data could render as "H1 00:00"
    // with nine empty columns before the first real one. The window still
    // extends outward for a genuine early start or a late-running shift — it
    // just no longer collapses toward one outlier.
    const OFFICE_START_HOUR = 9;  // 9:30 AM IST — the H1 column covers 9:00-9:59
    const OFFICE_END_HOUR = 18;   // 6:30 PM IST — the last column covers 18:00-18:59
    return {
      kind: "hourly",
      dates: [anchorISO],
      spanLabel: anchorISO,
      makeBuckets: (inspections) => {
        const hours = inspections.map((i) => istParts(i.inspectedAt).h);
        const start = Math.min(OFFICE_START_HOUR, ...hours);
        const end = Math.max(OFFICE_END_HOUR, ...hours);
        const count = end - start + 1;
        return Array.from({ length: count }, (_, i) => ({
          key: `H${i + 1}`,
          label: `H${i + 1}`,
          sub: `${pad2(start + i)}:00`,
          from: start + i,
        }));
      },
      bucketOf: (insp, buckets) => {
        const h = istParts(insp.inspectedAt).h;
        return buckets.findIndex((b) => b.from === h);
      },
    };
  }

  if (period === "daily") {
    // The week containing the anchor, Monday first, split by day.
    const anchorDow = new Date(Date.UTC(ay, am - 1, ad)).getUTCDay();
    const backToMonday = (anchorDow + 6) % 7;
    const monday = addDaysISO(anchorISO, -backToMonday);
    const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(monday, i));
    return {
      kind: "daily",
      dates,
      spanLabel: `${monday} → ${dates[6]}`,
      makeBuckets: () => dates.map((iso) => {
        const [y, m, d] = iso.split("-").map(Number);
        return {
          key: iso,
          label: DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()],
          sub: `${pad2(d)}/${pad2(m)}`,
        };
      }),
      bucketOf: (insp, buckets) => buckets.findIndex((b) => b.key === insp.date),
    };
  }

  if (period === "weekly") {
    // The calendar month, split into weeks of seven days from the 1st.
    const daysInMonth = new Date(Date.UTC(ay, am, 0)).getUTCDate();
    const dates = Array.from({ length: daysInMonth }, (_, i) => isoOf(ay, am, i + 1));
    return {
      kind: "weekly",
      dates,
      spanLabel: `${MONTHS[am - 1]} ${ay}`,
      makeBuckets: () => Array.from({ length: Math.ceil(daysInMonth / 7) }, (_, i) => ({
        key: `W${i + 1}`,
        label: `W${i + 1}`,
        sub: `${pad2(i * 7 + 1)}–${pad2(Math.min((i + 1) * 7, daysInMonth))}`,
      })),
      bucketOf: (insp, buckets) => {
        const day = Number(insp.date.slice(8, 10));
        const idx = Math.floor((day - 1) / 7);
        return idx < buckets.length ? idx : -1;
      },
    };
  }

  if (period === "monthly") {
    // The calendar year, split by month.
    const dates = null; // a whole year of ISO strings is a range query, not an $in
    return {
      kind: "monthly",
      range: { start: isoOf(ay, 1, 1), end: isoOf(ay, 12, 31) },
      dates,
      spanLabel: String(ay),
      makeBuckets: () => MONTHS.map((label, i) => ({ key: pad2(i + 1), label, sub: String(ay) })),
      bucketOf: (insp, buckets) => buckets.findIndex((b) => b.key === insp.date.slice(5, 7)),
    };
  }

  // yearly — five years ending at the anchor's year, split by year.
  const years = Array.from({ length: 5 }, (_, i) => ay - 4 + i);
  return {
    kind: "yearly",
    range: { start: isoOf(years[0], 1, 1), end: isoOf(ay, 12, 31) },
    dates: null,
    spanLabel: `${years[0]} → ${ay}`,
    makeBuckets: () => years.map((y) => ({ key: String(y), label: String(y), sub: "" })),
    bucketOf: (insp, buckets) => buckets.findIndex((b) => b.key === insp.date.slice(0, 4)),
  };
}

router.get("/report", async (req, res) => {
  try {
    const period = ["hourly", "daily", "weekly", "monthly", "yearly"].includes(req.query.period)
      ? req.query.period
      : "hourly";
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "")
      ? req.query.date
      : istDateString();

    const spec = buildPeriod(period, anchor);

    const [viewer, deptConfigured] = await Promise.all([
      qcViewer.resolveViewer(req),
      qcViewer.departmentConfigured(),
    ]);

    const filter = spec.dates
      ? { date: { $in: spec.dates } }
      : { date: { $gte: spec.range.start, $lte: spec.range.end } };
    qcViewer.applyViewerFilter(
      filter,
      qcViewer.viewerFilter(viewer, { departmentConfigured: deptConfigured }),
    );

    const inspections = await QCInspection.find(filter).sort({ inspectedAt: 1 }).lean();

    const buckets = spec.makeBuckets(inspections);

    // ── Reference data, batched ──────────────────────────────────────────────
    const woIds = [...new Set(inspections.map(i => i.workOrderId).filter(Boolean).map(String))];
    const moIds = [...new Set(inspections.map(i => i.manufacturingOrderId).filter(Boolean).map(String))];
    const [wos, mos, stages, masterOps] = await Promise.all([
      woIds.length ? WorkOrder.find({ _id: { $in: woIds } })
        .select("workOrderNumber stockItemName variantAttributes").lean() : [],
      moIds.length ? CustomerRequest.find({ _id: { $in: moIds } })
        .select("requestId customerInfo").lean() : [],
      qcStages.listStages({ includeRetired: true }).catch(() => []),
      getMasterOperations().catch(() => []),
    ]);
    const woMap = new Map(wos.map(w => [w._id.toString(), w]));
    const moMap = new Map(mos.map(m => [m._id.toString(), m]));
    const opNameByCode = new Map(
      masterOps.map(o => [(o.operationCode || "").trim().toLowerCase(), o.name]),
    );

    /* One sheet per checking point, in line order — the paper form is one sheet
       per checking point too. Scans with no checkpoint (recorded before
       checkpoints existed) collect in their own sheet rather than being folded
       into the first one, which would attribute them to a checkpoint they were
       never taken at. */
    const sheetOrder = [];
    const sheets = new Map();

    const sheetFor = (insp) => {
      const key = insp.stageId ? String(insp.stageId) : "__unstaged__";
      if (!sheets.has(key)) {
        const stage = insp.stageId ? stages.find(st => String(st._id) === key) : null;
        sheets.set(key, {
          stageId: key === "__unstaged__" ? null : key,
          stageCode: stage?.code || insp.stageCode || "",
          stageName: stage?.name || insp.stageName || "No checkpoint",
          serial: stage?.serial ?? 999,
          buyers: new Set(), styles: new Set(), colors: new Set(), inspectors: new Set(),
          pieces: new Map(),          // barcode -> ordered verdicts in span
          defectRows: new Map(),      // opCode -> { code, name, counts[] }
          scans: 0, passedScans: 0, defectiveScans: 0, rejectedScans: 0,
        });
        sheetOrder.push(key);
      }
      return sheets.get(key);
    };

    for (const insp of inspections) {
      const sheet = sheetFor(insp);
      const col = spec.bucketOf(insp, buckets);
      const wo = insp.workOrderId ? woMap.get(insp.workOrderId.toString()) : null;
      const mo = insp.manufacturingOrderId ? moMap.get(insp.manufacturingOrderId.toString()) : null;

      if (mo?.customerInfo?.name) sheet.buyers.add(mo.customerInfo.name.trim());
      if (wo?.stockItemName) sheet.styles.add(wo.stockItemName);
      for (const attr of wo?.variantAttributes || []) {
        if (/colou?r/i.test(attr.name || "")) sheet.colors.add(String(attr.value));
      }
      if (insp.inspectedByQCName) sheet.inspectors.add(insp.inspectedByQCName);

      sheet.scans++;
      if (insp.status === "passed") sheet.passedScans++;
      else if (insp.status === "rejected") { sheet.defectiveScans++; sheet.rejectedScans++; }
      else sheet.defectiveScans++;

      if (!sheet.pieces.has(insp.barcodeId)) sheet.pieces.set(insp.barcodeId, []);
      sheet.pieces.get(insp.barcodeId).push(insp.status);

      // One tally per flagged defect per bucket. A piece failed for three
      // things counts three times here and once in the summary — the form's
      // matrix counts DEFECTS, its summary counts GARMENTS, and conflating them
      // is the classic way a QC report stops adding up.
      //
      // DEFECT TYPES WIN OVER OPERATIONS WHERE BOTH EXIST, and each inspection
      // contributes through exactly one of the two. The form's CODE / DEFECT
      // columns are a defect taxonomy (S4 PUCKERING), which is precisely what a
      // defect type is and what an operation (S008 Sew Btn Placket) is not —
      // so when the inspector has said what was wrong, that is what the report
      // says. Falling back to operations keeps every inspection recorded before
      // the catalogue existed, and every one where the inspector only flagged a
      // position, in the report rather than silently absent.
      //
      // Counting BOTH would double every garment where an inspector did the
      // thorough thing and recorded where AND what — punishing the better
      // inspection with a worse-looking number.
      if (insp.status === "defective" || insp.status === "rejected") {
        // Types now live nested under the operation they belong to, and, for a
        // fault no operation caused, at the top level. Both are the same kind
        // of statement to this matrix, so both are gathered.
        const typed = [
          ...(insp.defects || []).flatMap((d) => d.types || []),
          ...(insp.defectTypes || []),
        ].filter((d) => d && d.code);
        const entries = typed.length
          ? typed.map((d) => ({
              code: String(d.code).trim(),
              // OTHER is one code carrying many different findings, so the
              // inspector's own words are what make the row worth reading.
              defect: d.note ? `${d.name || d.code} — ${d.note}` : (d.name || d.code),
              category: d.category || null,
            }))
          : (insp.defects || []).map((d) => ({
              code: (d.operationCode || "").trim(),
              defect: d.operationName || opNameByCode.get((d.operationCode || "").trim().toLowerCase()) || d.operationCode,
              category: null,
            }));

        for (const e of entries) {
          if (!e.code) continue;
          // OTHER rows are kept apart by their note: two different findings
          // filed under one code are two rows, not one with a count of 2.
          const key = e.code === "OTHER" ? `OTHER::${e.defect}` : e.code;
          if (!sheet.defectRows.has(key)) {
            const letter = (e.code.match(/^[A-Za-z]/) || [""])[0].toUpperCase();
            sheet.defectRows.set(key, {
              category: e.category || QUALCOM_CATEGORIES[letter] || "OTHER",
              code: e.code,
              defect: e.defect || e.code,
              counts: new Array(buckets.length).fill(0),
              total: 0,
            });
          }
          const row = sheet.defectRows.get(key);
          if (col >= 0) row.counts[col]++;
          row.total++;
        }
      }
    }

    // ── Pending rework — a LIVE snapshot, independent of the reporting period
    // (29 Aug 2026, explicit request: same "how many products are sent for
    // rework right now" question the overview's tile answers, wanted here
    // too). Computed once, scoped the same way as the rest of this report,
    // then split per checkpoint below — a piece stuck at end-line belongs on
    // the end-line sheet's summary, not folded into a department-wide figure
    // that would tell an individual checkpoint nothing about its own floor.
    const viewerOnlyFilter = qcViewer.applyViewerFilter(
      {}, qcViewer.viewerFilter(viewer, { departmentConfigured: deptConfigured }),
    );
    const pendingSnapshot = await qcStages
      .pendingReworkSnapshot(viewerOnlyFilter)
      .catch((e) => { console.warn("[QC report] pending-rework snapshot skipped:", e.message); return { count: 0, pieces: [] }; });
    const pendingByStage = new Map();
    for (const piece of pendingSnapshot.pieces) {
      for (const open of piece.openRework) {
        pendingByStage.set(open.stageId, (pendingByStage.get(open.stageId) || 0) + 1);
      }
    }

    const out = sheetOrder
      .map((key) => sheets.get(key))
      .sort((a, b) => a.serial - b.serial)
      .map((sh) => {
        const pieceVerdicts = [...sh.pieces.values()];
        // RIGHT FIRST TIME — the garment passed this checking point the first
        // time it was presented. The single number the floor is judged on.
        const rft = pieceVerdicts.filter(v => v[0] === "passed").length;
        // REJECT means two things now, and the form's column wants both: a
        // garment explicitly scrapped, and one presented, failed and never
        // brought back good. Both end the same way — it does not ship.
        const reject = pieceVerdicts.filter(
          (v) => v.includes("rejected") || v[v.length - 1] === "defective",
        ).length;
        /**
         * GARMENTS SENT BACK, NOT SCANS TAKEN OF THEM (29 Aug 2026, explicit
         * request: "defects should be count as per the product ok, means even
         * though 2-3 defects made for an single product but the count need to
         * mark as 1"). This used to be `sh.defectiveScans - sh.rejectedScans`
         * — a raw scan-event count, sitting inside a block every OTHER figure
         * (RFT, REJECT, INSPECTED) already counts by garment. A piece failed
         * twice in this period, or failed at a re-inspection after a fix that
         * didn't hold, counted twice; it counts once now, matching RFT/REJECT.
         */
        const rework = pieceVerdicts.filter((v) => v.includes("defective")).length;
        const inspected = pieceVerdicts.length;
        // Currently stuck at THIS checkpoint, as of right now — not a period
        // total, a snapshot. See pendingSnapshot above.
        const pendingRework = pendingByStage.get(sh.stageId) || 0;

        const rows = [...sh.defectRows.values()].sort(
          (a, b) => a.category.localeCompare(b.category) || a.code.localeCompare(b.code),
        );

        return {
          stageId: sh.stageId,
          stageCode: sh.stageCode,
          stageName: sh.stageName,
          serial: sh.serial,
          buyers: [...sh.buyers], styles: [...sh.styles], colors: [...sh.colors],
          inspectors: [...sh.inspectors],
          rows,
          bucketTotals: buckets.map((_, i) => rows.reduce((n, r) => n + r.counts[i], 0)),
          defectTotal: rows.reduce((n, r) => n + r.total, 0),
          inspected, rft, rework, reject, pendingRework,
          scans: sh.scans, passedScans: sh.passedScans, defectiveScans: sh.defectiveScans,
          rejectedScans: sh.rejectedScans,
          rftPct:    inspected ? +((rft / inspected) * 100).toFixed(1) : 0,
          reworkPct: inspected ? +((rework / inspected) * 100).toFixed(1) : 0,
          rejectPct: inspected ? +((reject / inspected) * 100).toFixed(1) : 0,
        };
      });

    const allPieces = new Set(inspections.map(i => i.barcodeId));

    res.json({
      success: true,
      period,
      anchor,
      spanLabel: spec.spanLabel,
      buckets,
      sheets: out,
      totals: {
        scans: inspections.length,
        pieces: allPieces.size,
        defectiveScans: inspections.filter(i => i.status === "defective").length,
        rejectedScans: inspections.filter(i => i.status === "rejected").length,
        defects: inspections.reduce((n, i) => n + (i.defects || []).length, 0),
        checkpoints: out.length,
        // Live, not period-scoped — see pendingSnapshot above.
        pendingRework: pendingSnapshot.count,
      },
      viewer: {
        name: viewer.name,
        role: viewer.role,
        scope: viewer.canSeeEveryone ? "all" : "mine",
        canSeeEveryone: viewer.canSeeEveryone,
      },
    });
  } catch (err) {
    console.error("[QC report] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /orders, GET /orders/:moId ────────────────────────────────────────────
//
// THE DEPARTMENT'S BOOK OF ORDERS, MO FIRST (explicit request, 29 Aug 2026:
// "the qc person who got the full access... can see the orders also...
// showcase as like showing in the production manager page or like in the
// cutting dashboard page... first is mo which is need to showcase in card,
// and upon click on that then the corresponding wo"). Mirrors the cutting
// master's `/manufacturing-orders` → `/manufacturing-orders/:moId` shape:
// a card per Manufacturing Order (== CustomerRequest, `WorkOrder.customerRequestId`
// is the FK), each rolling up every work order under it; clicking one drills
// into that MO's own work orders, each with the same five-bucket breakdown
// the flat list used to show for everything at once.
//
// Five buckets, one garment counted in exactly one of them, derived from
// `qcStages.pieceProgressMany` — the same primitive the checkpoint page and
// piece tracker use for "0/2 cleared", so a garment's status here always
// agrees with what it says everywhere else it is shown:
//   REJECTED     progress.rejected — scrapped, terminal, checked first.
//   COMPLETED    progress.complete — every checkpoint cleared.
//   IN REWORK    progress.openRework.length > 0 — sent back, not yet cleared.
//   IN PROGRESS  inspected at least once, still short of the above three —
//                cleared some checkpoints, mid-pipeline.
//   PENDING      never scanned at all — total ordered minus every barcode QC
//                has ever seen for this work order. Not a piece state (no scan
//                exists to hold one), so it is the one bucket not sourced from
//                pieceProgressMany.
//
// A work order with no `customerRequestId` (recorded before an MO was tied to
// it, or genuinely stand-alone) is not dropped — it collects under a synthetic
// "unassigned" card, same convention the overview's "By customer" panel
// already uses for the same situation.

/** Every non-cancelled work order matching `extraQuery`, with its QC bucket
 *  counts attached — the one query pair (scans, then piece progress) this
 *  whole file's /orders routes are built from.
 *
 *  `withDetail: true` additionally resolves each work order's photo and
 *  gender, the same way `/inspections` does (`resolveProductImage`) — worth
 *  the extra StockItem batch only where a card actually shows a photo (the
 *  per-MO work-order list), not the MO rollup, which never does. */
async function computeWorkOrderQcStats(extraQuery = {}, { withDetail = false } = {}) {
  const workOrders = await WorkOrder.find({ status: { $ne: "cancelled" }, ...extraQuery })
    .select("workOrderNumber quantity stockItemName stockItemReference stockItemId variantAttributes customerName status createdAt customerRequestId assignedDeadline")
    .sort({ createdAt: -1 })
    .lean();

  if (!workOrders.length) return [];

  let siMap = new Map();
  if (withDetail) {
    const stockItemIds = [...new Set(workOrders.map((wo) => wo.stockItemId?.toString()).filter(Boolean))];
    const stockItems = stockItemIds.length
      ? await StockItem.find({ _id: { $in: stockItemIds } })
        .select("images genderCategory variants.images variants.attributes").lean()
      : [];
    siMap = new Map(stockItems.map((si) => [si._id.toString(), si]));
  }

  // The short id is never stored — every other reader of it (parseBarcode,
  // findWorkOrderByShortId) derives it the same way, from the last 8 hex
  // characters of the ObjectId, so this has to match them exactly.
  const shortIdOf = (id) => id.toString().slice(-8);
  const shortIds = workOrders.map((wo) => shortIdOf(wo._id));

  const scans = await QCInspection.find({ workOrderShortId: { $in: shortIds } })
    .select("workOrderShortId barcodeId")
    .lean();

  const barcodesByShortId = new Map();
  for (const s of scans) {
    if (!barcodesByShortId.has(s.workOrderShortId)) barcodesByShortId.set(s.workOrderShortId, new Set());
    barcodesByShortId.get(s.workOrderShortId).add(s.barcodeId);
  }

  const allBarcodes = [...new Set(scans.map((s) => s.barcodeId))];
  const progressByBarcode = await qcStages.pieceProgressMany(allBarcodes);

  return workOrders.map((wo) => {
    const shortId = shortIdOf(wo._id);
    const barcodes = [...(barcodesByShortId.get(shortId) || [])];

    let completed = 0, inProgress = 0, inRework = 0, rejected = 0;
    for (const bc of barcodes) {
      const p = progressByBarcode[bc];
      if (!p) continue;
      if (p.rejected) rejected++;
      else if (p.complete) completed++;
      else if (p.openRework.length > 0) inRework++;
      else inProgress++;
    }

    const total = wo.quantity || 0;
    const inspected = barcodes.length;
    const pending = Math.max(0, total - inspected);

    return {
      workOrderId: String(wo._id),
      workOrderNumber: wo.workOrderNumber,
      shortId,
      customerRequestId: wo.customerRequestId ? String(wo.customerRequestId) : null,
      productName: wo.stockItemName || "—",
      customerName: wo.customerName || "—",
      status: wo.status,
      assignedDeadline: wo.assignedDeadline || null,
      total,
      inspected,
      completed,
      inProgress,
      inRework,
      rejected,
      pending,
      ...(withDetail ? {
        stockItemReference: wo.stockItemReference || null,
        variantAttributes: wo.variantAttributes || [],
        productImage: resolveProductImage(wo, siMap),
        genderCategory: (wo.stockItemId && siMap.get(wo.stockItemId.toString())?.genderCategory) || null,
      } : {}),
    };
  });
}

const ZERO_BUCKETS = { total: 0, inspected: 0, completed: 0, inProgress: 0, inRework: 0, rejected: 0, pending: 0 };

async function requireQcOwnerViewer(req, res) {
  const viewer = await qcViewer.resolveViewer(req);
  if (!viewer.canSeeEveryone) {
    res.status(403).json({
      success: false,
      message: "Only the QC owner can see the department's orders.",
    });
    return null;
  }
  return viewer;
}

// GET /orders — one card per Manufacturing Order, QC progress rolled up
// across every work order under it.
router.get("/orders", async (req, res) => {
  try {
    if (!(await requireQcOwnerViewer(req, res))) return;

    const perWo = await computeWorkOrderQcStats();
    if (!perWo.length) return res.json({ success: true, manufacturingOrders: [] });

    const moIds = [...new Set(perWo.map((o) => o.customerRequestId).filter(Boolean))];
    const mos = await CustomerRequest.find({ _id: { $in: moIds } })
      .select("requestId customerInfo requestType measurementName status createdAt deliveryDeadline estimatedCompletion finalOrderPrice")
      .lean();
    const moMap = new Map(mos.map((m) => [String(m._id), m]));

    const rollups = new Map();
    for (const o of perWo) {
      const key = o.customerRequestId || "unassigned";
      if (!rollups.has(key)) rollups.set(key, { ...ZERO_BUCKETS, workOrdersCount: 0, latestWoAt: null });
      const r = rollups.get(key);
      r.workOrdersCount++;
      for (const b of Object.keys(ZERO_BUCKETS)) r[b] += o[b];
    }

    const manufacturingOrders = [...rollups.entries()].map(([key, r]) => {
      const mo = key === "unassigned" ? null : moMap.get(key);
      return {
        manufacturingOrderId: key,
        requestId: mo?.requestId || (key === "unassigned" ? "Unassigned" : `MO-${key.slice(-6)}`),
        customerName: mo?.customerInfo?.name || "—",
        customerEmail: mo?.customerInfo?.email || null,
        requestType: mo?.requestType || null,
        measurementName: mo?.measurementName || null,
        status: mo?.status || null,
        createdAt: mo?.createdAt || null,
        deadline: mo?.deliveryDeadline || mo?.estimatedCompletion || null,
        orderValue: mo?.finalOrderPrice || 0,
        ...r,
      };
    }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    res.json({ success: true, manufacturingOrders });
  } catch (err) {
    console.error("[QC orders] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /orders/:moId — the work orders under one Manufacturing Order, each
// with its own five-bucket breakdown. `moId` is "unassigned" for the
// synthetic card, otherwise a CustomerRequest _id.
router.get("/orders/:moId", async (req, res) => {
  try {
    if (!(await requireQcOwnerViewer(req, res))) return;

    const { moId } = req.params;
    const isUnassigned = moId === "unassigned";
    if (!isUnassigned && !/^[0-9a-fA-F]{24}$/.test(moId)) {
      return res.status(400).json({ success: false, message: "That is not a valid order id." });
    }

    const [orders, mo] = await Promise.all([
      computeWorkOrderQcStats(isUnassigned
        ? { $or: [{ customerRequestId: null }, { customerRequestId: { $exists: false } }] }
        : { customerRequestId: moId }, { withDetail: true }),
      isUnassigned ? null : CustomerRequest.findById(moId)
        .select("requestId customerInfo requestType measurementName status createdAt deliveryDeadline estimatedCompletion finalOrderPrice")
        .lean(),
    ]);

    if (!isUnassigned && !mo) {
      return res.status(404).json({ success: false, message: "That manufacturing order no longer exists." });
    }

    res.json({
      success: true,
      manufacturingOrder: isUnassigned
        ? { manufacturingOrderId: "unassigned", requestId: "Unassigned", customerName: "—", customerEmail: null, requestType: null, measurementName: null, status: null, createdAt: null, deadline: null, orderValue: 0 }
        : {
            manufacturingOrderId: String(mo._id),
            requestId: mo.requestId,
            customerName: mo.customerInfo?.name || "—",
            customerEmail: mo.customerInfo?.email || null,
            requestType: mo.requestType || null,
            measurementName: mo.measurementName || null,
            status: mo.status || null,
            createdAt: mo.createdAt || null,
            deadline: mo.deliveryDeadline || mo.estimatedCompletion || null,
            orderValue: mo.finalOrderPrice || 0,
          },
      orders,
    });
  } catch (err) {
    console.error("[QC orders detail] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /orders/:moId/analytics ──────────────────────────────────────────────
//
// EVERYTHING QC KNOWS ABOUT ONE ORDER, IN ONE PAYLOAD (explicit request, 29 Aug
// 2026: "so that they can do there analysis like an certain period defect rate,
// DHU rates as per the order wise, defects rates, rework rates, most common
// defect faced and all... don't make it lack of data").
//
// Served SEPARATELY from /orders/:moId so the order page can paint its work-order
// cards immediately and fill the analysis panels in behind them — the cards are
// what the page is for, and making them wait on a full defect rollup is what
// made this screen feel slow.
//
// EVERY RATE HERE IS DEFINED ON THE WAY OUT, in `definitions`, and the UI prints
// those definitions next to the figures. Two of them genuinely disagree by
// design and always will:
//   DHU counts DEFECTS (a garment with 3 faults contributes 3) — it can exceed
//        100%, and that is what the metric means.
//   Defect rate counts GARMENTS (that same garment contributes 1) — it cannot.
// A reader who sees "DHU 140%, defect rate 60%" and has not been told this
// assumes one of them is broken, so they are never shown without their formula.
router.get("/orders/:moId/analytics", async (req, res) => {
  try {
    if (!(await requireQcOwnerViewer(req, res))) return;

    const { moId } = req.params;
    const isUnassigned = moId === "unassigned";
    if (!isUnassigned && !/^[0-9a-fA-F]{24}$/.test(moId)) {
      return res.status(400).json({ success: false, message: "That is not a valid order id." });
    }

    // Optional period window — the "certain period defect rate" half of the ask.
    // Absent, the whole life of the order.
    const { from, to } = req.query;
    const dateFilter = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(from || "")) dateFilter.$gte = from;
    if (/^\d{4}-\d{2}-\d{2}$/.test(to || "")) dateFilter.$lte = to;

    const workOrders = await WorkOrder.find(isUnassigned
      ? { status: { $ne: "cancelled" }, $or: [{ customerRequestId: null }, { customerRequestId: { $exists: false } }] }
      : { status: { $ne: "cancelled" }, customerRequestId: moId })
      .select("_id quantity stockItemName").lean();

    const orderedQty = workOrders.reduce((n, wo) => n + (wo.quantity || 0), 0);
    const shortIds = workOrders.map((wo) => wo._id.toString().slice(-8));
    const woNameByShortId = new Map(workOrders.map((wo) => [wo._id.toString().slice(-8), wo.stockItemName || "—"]));

    if (!shortIds.length) {
      return res.json({ success: true, analytics: emptyOrderAnalytics(orderedQty) });
    }

    const scanFilter = { workOrderShortId: { $in: shortIds } };
    if (Object.keys(dateFilter).length) scanFilter.date = dateFilter;

    const scans = await QCInspection.find(scanFilter)
      .select("barcodeId workOrderShortId date status defects defectTypes stageName stageSerial inspectedByQCName inspectedAt reworkRound")
      .sort({ inspectedAt: 1 })
      .lean();

    res.json({ success: true, analytics: buildOrderAnalytics(scans, orderedQty, woNameByShortId, { from, to }) });
  } catch (err) {
    console.error("[QC order analytics] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

const ANALYTIC_DEFINITIONS = {
  dhu: "Defects per Hundred Units. Total individual defects recorded ÷ garments inspected × 100. Counts DEFECTS, so one garment with three faults adds three — this is why DHU can exceed 100%.",
  defectRate: "Garments that failed at least once ÷ garments inspected × 100. Counts GARMENTS, so a garment with three faults still adds one. Always ≤ 100%.",
  reworkRate: "Garments sent back to be fixed at least once ÷ garments inspected × 100. A garment failed twice still counts once.",
  rft: "Right First Time. Garments that passed every checkpoint on the first presentation, with no failure on record ÷ garments inspected × 100.",
  rejectRate: "Garments scrapped outright ÷ garments inspected × 100. These cannot be reworked and will not ship.",
  coverage: "Garments QC has inspected at least once ÷ garments ordered × 100. How much of the order QC has actually seen — not how much passed.",
  avgDefectsPerFailed: "Total defects ÷ garments that failed. How bad a failure typically is, as opposed to how often one happens.",
};

function emptyOrderAnalytics(orderedQty) {
  return {
    definitions: ANALYTIC_DEFINITIONS,
    period: { from: null, to: null, firstScan: null, lastScan: null },
    headline: {
      orderedQty, inspected: 0, scans: 0, defects: 0,
      dhu: 0, defectRate: 0, reworkRate: 0, rft: 0, rejectRate: 0, coverage: 0, avgDefectsPerFailed: 0,
      passedGarments: 0, failedGarments: 0, reworkGarments: 0, rejectedGarments: 0,
    },
    topDefectTypes: [], topOperations: [], byCheckpoint: [], byInspector: [], byProduct: [], daily: [], recent: [],
  };
}

/** All the rollups the order page draws, from one pass over that order's scans. */
function buildOrderAnalytics(scans, orderedQty, woNameByShortId, window) {
  const pct = (n, d) => (d ? +((n / d) * 100).toFixed(1) : 0);

  // ── Garment-level truth. Every "rate" below counts garments, except DHU. ──
  const byGarment = new Map();
  for (const s of scans) {
    if (!byGarment.has(s.barcodeId)) {
      byGarment.set(s.barcodeId, { scans: [], failed: false, rejected: false, rework: false, shortId: s.workOrderShortId });
    }
    const g = byGarment.get(s.barcodeId);
    g.scans.push(s);
    if (s.status === "rejected") { g.rejected = true; g.failed = true; }
    else if (s.status === "defective") { g.failed = true; g.rework = true; }
  }

  const inspected = byGarment.size;
  const garments = [...byGarment.values()];
  const failedGarments = garments.filter((g) => g.failed).length;
  const rejectedGarments = garments.filter((g) => g.rejected).length;
  const reworkGarments = garments.filter((g) => g.rework).length;
  const passedGarments = inspected - failedGarments;

  // ── Defect-level tallies. Types nest under the operation that caused them,
  // and also stand alone when no operation was named — both are real defects. ──
  const typeMap = new Map(), opMap = new Map();
  let defectCount = 0;
  const addType = (t, opName) => {
    const code = t.code || t.name;
    if (!code) return;
    const key = String(code).toUpperCase();
    if (!typeMap.has(key)) typeMap.set(key, { code: t.code || "", name: t.name || t.code || "", category: t.category || "", count: 0, operations: new Set() });
    const row = typeMap.get(key);
    row.count++;
    if (opName) row.operations.add(opName);
  };

  for (const s of scans) {
    for (const d of (s.defects || [])) {
      const opKey = (d.operationCode || "").trim() || "—";
      if (!opMap.has(opKey)) opMap.set(opKey, { code: opKey, name: d.operationName || opKey, count: 0, types: new Map(), operators: new Set() });
      const op = opMap.get(opKey);
      op.count++;
      for (const o of (d.operators || [])) if (o.operatorName) op.operators.add(o.operatorName);
      if ((d.types || []).length) {
        for (const t of d.types) {
          defectCount++;
          addType(t, d.operationName || opKey);
          const tk = String(t.code || t.name || "").toUpperCase();
          op.types.set(tk, (op.types.get(tk) || 0) + 1);
        }
      } else {
        // An operation flagged with no type named is still one defect.
        defectCount++;
      }
    }
    for (const t of (s.defectTypes || [])) { defectCount++; addType(t, null); }
  }

  // ── Per-checkpoint, per-inspector, per-product, per-day. ──
  const group = (keyFn, labelFn) => {
    const m = new Map();
    for (const s of scans) {
      const k = keyFn(s);
      if (k == null) continue;
      if (!m.has(k)) m.set(k, { key: k, label: labelFn(s), scans: 0, passed: 0, defective: 0, rejected: 0, garments: new Set(), defects: 0 });
      const row = m.get(k);
      row.scans++;
      row.garments.add(s.barcodeId);
      row[s.status === "passed" ? "passed" : s.status === "rejected" ? "rejected" : "defective"]++;
      row.defects += (s.defects || []).reduce((n, d) => n + Math.max(1, (d.types || []).length), 0) + (s.defectTypes || []).length;
    }
    return [...m.values()].map((r) => {
      const g = r.garments.size;
      return {
        ...r, garments: g,
        passRate: pct(r.passed, r.scans),
        dhu: pct(r.defects, g),
      };
    }).sort((a, b) => b.scans - a.scans);
  };

  const daily = group((s) => s.date, (s) => s.date).sort((a, b) => a.key.localeCompare(b.key))
    .map((d) => ({ ...d, defectRate: pct(d.defective + d.rejected, d.scans) }));

  const dates = scans.map((s) => s.date).filter(Boolean).sort();

  return {
    definitions: ANALYTIC_DEFINITIONS,
    period: {
      from: window.from || null, to: window.to || null,
      firstScan: dates[0] || null, lastScan: dates[dates.length - 1] || null,
    },
    headline: {
      orderedQty,
      inspected,
      scans: scans.length,
      defects: defectCount,
      dhu: pct(defectCount, inspected),
      defectRate: pct(failedGarments, inspected),
      reworkRate: pct(reworkGarments, inspected),
      rft: pct(passedGarments, inspected),
      rejectRate: pct(rejectedGarments, inspected),
      coverage: pct(inspected, orderedQty),
      avgDefectsPerFailed: failedGarments ? +(defectCount / failedGarments).toFixed(1) : 0,
      passedGarments, failedGarments, reworkGarments, rejectedGarments,
    },
    topDefectTypes: [...typeMap.values()]
      .map((t) => ({ ...t, operations: [...t.operations].slice(0, 4), share: pct(t.count, defectCount) }))
      .sort((a, b) => b.count - a.count).slice(0, 12),
    topOperations: [...opMap.values()]
      .map((o) => ({
        code: o.code, name: o.name, count: o.count, share: pct(o.count, defectCount),
        operators: [...o.operators].slice(0, 4),
        types: [...o.types.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count).slice(0, 5),
      }))
      .sort((a, b) => b.count - a.count).slice(0, 12),
    byCheckpoint: group((s) => s.stageName || null, (s) => s.stageName || "No checkpoint"),
    byInspector: group((s) => s.inspectedByQCName || null, (s) => s.inspectedByQCName || "—"),
    byProduct: group((s) => s.workOrderShortId || null, (s) => woNameByShortId.get(s.workOrderShortId) || s.workOrderShortId),
    daily,
    recent: scans.slice(-40).reverse().map((s) => ({
      barcodeId: s.barcodeId, date: s.date, at: s.inspectedAt, status: s.status,
      stageName: s.stageName || "", by: s.inspectedByQCName || "",
      reworkRound: s.reworkRound || 0,
      defects: (s.defects || []).map((d) => ({
        operationCode: d.operationCode, operationName: d.operationName,
        types: (d.types || []).map((t) => ({ code: t.code, name: t.name, note: t.note })),
        operators: (d.operators || []).map((o) => o.operatorName).filter(Boolean),
      })),
      defectTypes: (s.defectTypes || []).map((t) => ({ code: t.code, name: t.name, note: t.note })),
    })),
  };
}

module.exports = router;