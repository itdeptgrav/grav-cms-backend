// services/buyerReports.js
// ─────────────────────────────────────────────────────────────────────────────
// The four reports a buyer receives about an order, built from what the
// factory already records (report formats 5, 6, 7 and 10 of the Garment
// Order Process Format):
//
//   cutting      every day   pieces cut for each work order, fabric used
//   production   every day   pieces finished, target, defects, rework, people
//   inspection   per order   final QC, and the AQL inspection once recorded
//   closing      per order   ordered vs shipped, rejections, invoice, payment
//
// READ-ONLY, AND NEVER A COST. Unit, actual, waste and material costs stay
// with the factory; fabric is reported in quantities only.
//
// NOT RECORDED YET. A field the factory doesn't record is null here and the
// portal prints "Not recorded yet". The fields the CMS team is adding (the
// "Buyer Report Fields" spec) are read as soon as they exist: the cutting
// entry's cuttingNo, layNo and layers; the work order's cutIssues; and the
// order's closedAt and closingRemarks.
//
// DAYS are India days, "YYYY-MM-DD" (Asia/Kolkata). The sources keep days
// differently — cutting records by the UTC date they were saved on, machine
// scans by the server's midnight, QC by the India date, end-of-line scans by
// India midnight, the production schedule by the calendar date at 00:00 UTC —
// so each read below turns its source into India time.
//
// THE DAILY SAVE. Just after midnight, the Cutting and Production reports of
// every order that had work the day before are saved (BuyerDailyReport) and
// never overwritten, so a past day reads the same later even if the raw
// scans are cleaned up (services/productionSyncService.js deletes old machine
// scans). A past day with no saved copy is worked out from the records.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const cron = require("node-cron");

const WorkOrder = require("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CuttingMasterRecord = require("../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");
const ProductionCompletionScanRecord = require("../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");
const ProductionTracking = require("../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const ProductionSchedule = require("../models/CMS_Models/Manufacturing/Production/ProductionSchedule/ProductionSchedule");
const QCInspection = require("../models/CMS_Models/Manufacturing/QC/DefectRecord");
const DispatchChallan = require("../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");
const Barcode = require("../models/CMS_Models/Inventory/Operations/Barcode");
const RawItem = require("../models/CMS_Models/Inventory/Products/RawItem");
const StockItem = require("../models/CMS_Models/Inventory/Products/StockItem");
const Unit = require("../models/CMS_Models/Inventory/Configurations/Unit");
const CRMAccount = require("../models/CMS_Models/Sales/Account");
const Enquiry = require("../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../models/CMS_Models/Sales/SalesJourney");
const { Acc_Voucher } = require("../models/Accountant_model/Acc_VoucherModels");
const { Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
const Customer = require("../models/Customer_Models/Customer");
const CustomerRequest = require("../models/Customer_Models/CustomerRequest");
const BuyerDailyReport = require("../models/Customer_Models/BuyerDailyReport");
const { buildClosingReport } = require("./closingReport");

// ─── Days ────────────────────────────────────────────────────────────────────
const IST_MS = 330 * 60000;
const DAY_MS = 86400000;

// The India day a moment falls on, the moment an India day starts, and days
// either side of one.
const dayOf = (at) =>
  new Date(new Date(at).getTime() + IST_MS).toISOString().slice(0, 10);
const startOf = (day) => new Date(Date.parse(`${day}T00:00:00.000Z`) - IST_MS);
const addDays = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
const today = () => dayOf(new Date());
const isDay = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

// ─── Small helpers ───────────────────────────────────────────────────────────
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (n, places = 1) => Math.round(n * 10 ** places) / 10 ** places;
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every garment's barcode is WO-<last 8 of its work order's id>-<unit>.
const shortIdOf = (id) => String(id).slice(-8).toLowerCase();
const pieceOf = (barcode) => {
  const parts = String(barcode || "").trim().split("-");
  if (parts.length < 3 || parts[0] !== "WO") return null;
  const unit = parseInt(parts[2], 10);
  return Number.isInteger(unit) && unit > 0
    ? { shortId: parts[1].toLowerCase(), unit }
    : null;
};
const barcodeRx = (shortIds) =>
  new RegExp(`^WO-(${shortIds.map(escapeRx).join("|")})-`, "i");
// QC keeps the short id as the barcode carried it; match either case.
const qcIds = (shortIds) => [...new Set([...shortIds, ...shortIds.map((s) => s.toUpperCase())])];

const variantOf = (wo) =>
  (wo.variantAttributes || [])
    .map((a) => a?.value)
    .filter(Boolean)
    .join(" · ");

// ─── The order ───────────────────────────────────────────────────────────────
const ORDER_FIELDS =
  "requestId customerId customerInfo.name status createdAt grandTotal " +
  "quotations.poProof quotations.grandTotal quotations.paymentSchedule " +
  "closedAt closingRemarks";

const WO_FIELDS =
  "workOrderNumber stockItemId stockItemName stockItemReference variantId " +
  "variantAttributes quantity cuttingProgress operations.plannedTimeSeconds " +
  "operations.estimatedTimeSeconds productionNotes packagedQuantity " +
  "dispatchedQuantity dispatchRecords assignedDeadline " +
  "productionCompletion.operationCompletion cutIssues createdAt";

// The buyer's own order, or null when it isn't theirs.
async function orderFor(id, customerId) {
  return CustomerRequest.findOne({ _id: id, customerId })
    .select(ORDER_FIELDS)
    .lean();
}

async function contextOf(order) {
  const workOrders = await WorkOrder.find({ customerRequestId: order._id })
    .select(WO_FIELDS)
    .sort({ createdAt: 1 })
    .lean();
  return {
    order,
    workOrders,
    byId: new Map(workOrders.map((wo) => [String(wo._id), wo])),
    byShortId: new Map(workOrders.map((wo) => [shortIdOf(wo._id), wo])),
  };
}

// What heads every report.
function headOf(order) {
  const quote = (order.quotations || [])[0] || null;
  return {
    requestId: order.requestId,
    buyer: order.customerInfo?.name || null,
    poNumber: quote?.poProof?.poNumber || null,
    poDate: quote?.poProof?.poDate || null,
  };
}

// One work order as a report line.
const lineOf = (wo) => ({
  workOrderId: String(wo._id),
  workOrderNumber: wo.workOrderNumber || null,
  style: wo.stockItemReference || null,
  product: wo.stockItemName || null,
  variant: variantOf(wo) || null,
  orderQty: num(wo.quantity),
});

const stylesOf = (ctx) => [
  ...new Set(
    ctx.workOrders.map((wo) => wo.stockItemReference || wo.stockItemName).filter(Boolean),
  ),
];

// ─── Fabric: planned against used, in quantities ─────────────────────────────
// As the raw-item wastage screen works it out (routes/CEO_Routes/
// rawItemWastageRoutes.js, order-wise): each closed fabric-roll session's use
// (start length − end length) is shared among the work orders by the pieces
// scanned in it; planned is the product's bill of materials × the pieces cut.
// Costs are left out.

function unitConverter() {
  const cache = new Map();
  const unitDoc = async (name) => {
    if (!cache.has(name)) {
      cache.set(
        name,
        Unit.findOne({ name }).populate("conversions.toUnit", "name").lean().catch(() => null),
      );
    }
    return cache.get(name);
  };
  return async (quantity, from, to) => {
    if (!from || !to || from === to || !quantity) return quantity;
    const fromDoc = await unitDoc(from);
    const direct = (fromDoc?.conversions || []).find(
      (c) => (c.toUnit?.name || c.toUnit) === to,
    );
    if (direct?.quantity) return quantity * direct.quantity;
    const toDoc = await unitDoc(to);
    const reverse = (toDoc?.conversions || []).find(
      (c) => (c.toUnit?.name || c.toUnit) === from,
    );
    if (reverse?.quantity) return quantity / reverse.quantity;
    return quantity;
  };
}

const sameRawVariant = (a, b) => {
  if (a.variantId && b.variantId && String(a.variantId) === String(b.variantId)) return true;
  const ac = a.variantCombination || [];
  const bc = b.variantCombination || [];
  if (ac.length && bc.length) return ac.length === bc.length && ac.every((v, i) => v === bc[i]);
  return !a.variantId && !ac.length && !b.variantId && !bc.length;
};

// The work order's bill of materials: the raw items on its product variant.
function bomOf(wo, stockItem) {
  const variants = stockItem?.variants || [];
  let variant = null;
  if (wo.variantId) variant = variants.find((v) => String(v._id) === String(wo.variantId));
  if (!variant && wo.variantAttributes?.length) {
    variant = variants.find(
      (v) =>
        v.attributes?.length &&
        wo.variantAttributes.every((a) =>
          v.attributes.some((b) => b.name === a.name && b.value === a.value),
        ),
    );
  }
  if (!variant && variants.length === 1) variant = variants[0];
  return variant?.rawItems || [];
}

// Fabric used for the order's pieces in sessions closed in [from, to), or in
// every session when there is no window.
async function fabricUse(ctx, from = null, to = null) {
  const shortIds = [...ctx.byShortId.keys()];
  if (!shortIds.length) return [];
  const rolls = await Barcode.find({
    "cuttingSessions.scannedPieces": { $regex: barcodeRx(shortIds) },
  })
    .select("rawItem variantId variantCombination unit cuttingSessions")
    .lean();

  const materials = new Map();
  for (const roll of rolls) {
    for (const session of roll.cuttingSessions || []) {
      if (!session.closedAt) continue;
      const closed = new Date(session.closedAt);
      if (from && (closed < from || closed >= to)) continue;
      const scanned = session.scannedPieces || [];
      const used = num(session.startQty) - num(session.endQty);
      if (used <= 0 || !scanned.length) continue;

      const ours = new Map(); // shortId -> Set(unit)
      for (const code of scanned) {
        const piece = pieceOf(code);
        if (!piece || !ctx.byShortId.has(piece.shortId)) continue;
        if (!ours.has(piece.shortId)) ours.set(piece.shortId, new Set());
        ours.get(piece.shortId).add(piece.unit);
      }
      if (!ours.size) continue;

      const key = `${roll.rawItem}::${roll.variantId || (roll.variantCombination || []).join("|")}`;
      if (!materials.has(key)) {
        materials.set(key, {
          rawItemId: roll.rawItem,
          variantId: roll.variantId || null,
          variantCombination: roll.variantCombination || [],
          unit: roll.unit || "",
          used: 0,
          units: new Map(), // shortId -> Set(unit)
        });
      }
      const m = materials.get(key);
      for (const [shortId, units] of ours) {
        m.used += (used * units.size) / scanned.length;
        if (!m.units.has(shortId)) m.units.set(shortId, new Set());
        units.forEach((u) => m.units.get(shortId).add(u));
      }
    }
  }
  if (!materials.size) return [];

  const stockItemIds = [...new Set(ctx.workOrders.map((wo) => String(wo.stockItemId || "")).filter(Boolean))];
  const [stockItems, rawItems] = await Promise.all([
    StockItem.find({ _id: { $in: stockItemIds } })
      .select("variants._id variants.attributes variants.rawItems")
      .lean(),
    RawItem.find({ _id: { $in: [...materials.values()].map((m) => m.rawItemId).filter(Boolean) } })
      .select("name")
      .lean(),
  ]);
  const stockItemById = new Map(stockItems.map((s) => [String(s._id), s]));
  const nameById = new Map(rawItems.map((r) => [String(r._id), r.name]));
  const convert = unitConverter();

  const out = [];
  for (const m of materials.values()) {
    let planned = 0;
    let pieces = 0;
    for (const [shortId, units] of m.units) {
      const wo = ctx.byShortId.get(shortId);
      pieces += units.size;
      const line = bomOf(wo, stockItemById.get(String(wo.stockItemId || ""))).find(
        (l) =>
          String(l.rawItemId) === String(m.rawItemId) &&
          sameRawVariant(l, { variantId: m.variantId, variantCombination: m.variantCombination }),
      );
      if (line) planned += (await convert(num(line.quantity), line.unit, m.unit)) * units.size;
    }
    out.push({
      material: nameById.get(String(m.rawItemId)) || "Fabric",
      unit: m.unit,
      pieces,
      planned: planned > 0 ? round(planned, 2) : null,
      used: round(m.used, 2),
      wastagePct: planned > 0 ? round(((m.used - planned) / planned) * 100, 1) : null,
    });
  }
  return out.sort((a, b) => b.used - a.used);
}

// ─── Format 5 · Cutting Report ───────────────────────────────────────────────
async function cuttingReport(ctx, day) {
  const from = startOf(day);
  const to = startOf(addDays(day, 1));
  const woIds = ctx.workOrders.map((wo) => wo._id);

  // A cutting record is filed under the UTC date it was saved on, so an
  // India day spans two of them; the entry's own time decides.
  const records = woIds.length
    ? await CuttingMasterRecord.find({
        date: { $in: [addDays(day, -1), day] },
        "entries.woId": { $in: woIds },
      })
        .select("employeeName date entries")
        .lean()
    : [];

  const rows = new Map();
  for (const record of records) {
    for (const entry of record.entries || []) {
      const wo = entry.woId && ctx.byId.get(String(entry.woId));
      if (!wo) continue;
      const at = entry.timestamp ? new Date(entry.timestamp) : null;
      if (at ? at < from || at >= to : record.date !== day) continue;

      const id = String(wo._id);
      if (!rows.has(id)) {
        rows.set(id, {
          ...lineOf(wo),
          piecesCut: 0,
          cutToDate: num(wo.cuttingProgress?.completed),
          cutters: new Set(),
          cuttingNos: new Set(),
          layNos: new Set(),
          layers: new Map(), // one lay's plies, counted once however many sizes it cut
          firstUnit: null,
          lastUnit: null,
        });
      }
      const row = rows.get(id);
      row.piecesCut += num(entry.quantityCut);
      if (record.employeeName) row.cutters.add(record.employeeName);
      if (entry.cuttingNo) row.cuttingNos.add(entry.cuttingNo);
      if (entry.layNo) row.layNos.add(entry.layNo);
      if (entry.layers != null) {
        const lay = entry.layNo || entry.cuttingNo || String(entry._id);
        row.layers.set(lay, Math.max(row.layers.get(lay) || 0, num(entry.layers)));
      }
      if (num(entry.startUnit) > 0) {
        row.firstUnit = row.firstUnit == null ? num(entry.startUnit) : Math.min(row.firstUnit, num(entry.startUnit));
      }
      if (num(entry.endUnit) > 0) {
        row.lastUnit = row.lastUnit == null ? num(entry.endUnit) : Math.max(row.lastUnit, num(entry.endUnit));
      }
    }
  }

  // Pieces handed to the sewing line that day — once the CMS records it.
  const issuedOn = (wo) =>
    Array.isArray(wo.cutIssues)
      ? wo.cutIssues
          .filter((i) => i?.issuedAt && new Date(i.issuedAt) >= from && new Date(i.issuedAt) < to)
          .reduce((sum, i) => sum + num(i.quantity), 0)
      : null;

  const lines = [...rows.values()].map((row) => {
    const wo = ctx.byId.get(row.workOrderId);
    return {
      workOrderId: row.workOrderId,
      workOrderNumber: row.workOrderNumber,
      style: row.style,
      product: row.product,
      variant: row.variant,
      orderQty: row.orderQty,
      piecesCut: row.piecesCut,
      cutToDate: row.cutToDate,
      units: row.firstUnit && row.lastUnit ? `${row.firstUnit}–${row.lastUnit}` : null,
      cutters: [...row.cutters],
      cuttingNos: row.cuttingNos.size ? [...row.cuttingNos] : null,
      layNos: row.layNos.size ? [...row.layNos] : null,
      layers: row.layers.size ? [...row.layers.values()].reduce((sum, n) => sum + n, 0) : null,
      issuedToLine: issuedOn(wo),
    };
  });

  const issued = lines.filter((l) => l.issuedToLine != null);
  return {
    kind: "cutting",
    day,
    ...headOf(ctx.order),
    lines,
    totals: {
      piecesCut: lines.reduce((sum, l) => sum + l.piecesCut, 0),
      cutToDate: lines.reduce((sum, l) => sum + l.cutToDate, 0),
      orderQty: lines.reduce((sum, l) => sum + l.orderQty, 0),
      issuedToLine: issued.length ? issued.reduce((sum, l) => sum + l.issuedToLine, 0) : null,
    },
    fabric: lines.length ? await fabricUse(ctx, from, to) : [],
    hasWork: lines.length > 0,
  };
}

// ─── QC, counted as the QC screens count it ──────────────────────────────────
// routes/CMS_Routes/Manufacturing/QC/qcRoutes.js buildOrderAnalytics: a
// garment is defective when any check failed it, reworked when one sent it
// back, rejected when one scrapped it; a scan's defects are each operation
// flagged (or each type named on it) plus the types recorded without one.
const defectsOf = (scan) =>
  (scan.defects || []).reduce((n, d) => n + Math.max(1, (d.types || []).length), 0) +
  (scan.defectTypes || []).length;

function qcTally(scans) {
  const garments = new Map();
  let defects = 0;
  for (const s of scans) {
    if (!garments.has(s.barcodeId)) garments.set(s.barcodeId, { failed: false, rework: false, rejected: false });
    const g = garments.get(s.barcodeId);
    if (s.status === "rejected") {
      g.rejected = true;
      g.failed = true;
    } else if (s.status === "defective") {
      g.failed = true;
      g.rework = true;
    }
    defects += defectsOf(s);
  }
  const all = [...garments.values()];
  const inspected = garments.size;
  return {
    inspected,
    passed: all.filter((g) => !g.failed).length,
    defective: all.filter((g) => g.failed).length,
    rework: all.filter((g) => g.rework).length,
    rejected: all.filter((g) => g.rejected).length,
    defects,
    dhu: inspected ? round((defects / inspected) * 100, 1) : null,
  };
}

// Minutes of work in one piece, as the production schedule counts them
// (routes/CMS_Routes/Production/ProductionSchedule/productionScheduleRoutes.js
// calculateWODuration).
const minutesPerPiece = (wo) =>
  Math.ceil(
    (wo.operations || []).reduce(
      (sum, op) => sum + num(op.plannedTimeSeconds || op.estimatedTimeSeconds),
      0,
    ) / 60,
  );

// ─── Format 6 · Daily Production Report ──────────────────────────────────────
async function productionReport(ctx, day) {
  const from = startOf(day);
  const to = startOf(addDays(day, 1));
  const shortIds = [...ctx.byShortId.keys()];
  const empty = { kind: "production", day, ...headOf(ctx.order), lines: [], totals: null, hasWork: false };
  if (!shortIds.length) return empty;

  const [completion, qcScans, tracking, schedule] = await Promise.all([
    // Finished: the end-of-line scans, one document per India day.
    ProductionCompletionScanRecord.findOne({ date: from }).select("scans.barcodeId").lean(),
    QCInspection.find({ date: day, workOrderShortId: { $in: qcIds(shortIds) } })
      .select("barcodeId workOrderShortId status defects defectTypes")
      .lean(),
    // People: operators who scanned this order's pieces that day. Machine
    // days start at the server's midnight, so read a day either side.
    ProductionTracking.find({
      date: { $gte: new Date(from.getTime() - DAY_MS), $lt: new Date(to.getTime() + DAY_MS) },
      "machines.operators.barcodeScans.barcodeId": { $regex: barcodeRx(shortIds) },
    })
      .select(
        "machines.operators.operatorIdentityId machines.operators.operatorName " +
          "machines.operators.barcodeScans.barcodeId machines.operators.barcodeScans.timeStamp",
      )
      .lean(),
    // Target: the minutes planned for each work order on the schedule.
    ProductionSchedule.findOne({ date: new Date(`${day}T00:00:00.000Z`) })
      .select("scheduledWorkOrders.workOrderId scheduledWorkOrders.durationMinutes")
      .lean(),
  ]);

  const finished = new Map(); // shortId -> Set(barcode)
  for (const scan of completion?.scans || []) {
    const piece = pieceOf(scan.barcodeId);
    if (!piece || !ctx.byShortId.has(piece.shortId)) continue;
    if (!finished.has(piece.shortId)) finished.set(piece.shortId, new Set());
    finished.get(piece.shortId).add(String(scan.barcodeId).trim().toUpperCase());
  }

  const qcBy = new Map(); // shortId -> scans
  for (const scan of qcScans) {
    const shortId = String(scan.workOrderShortId || "").toLowerCase();
    if (!qcBy.has(shortId)) qcBy.set(shortId, []);
    qcBy.get(shortId).push(scan);
  }

  const operatorsBy = new Map(); // shortId -> Set(operator)
  const everyone = new Set();
  for (const doc of tracking) {
    for (const machine of doc.machines || []) {
      for (const op of machine.operators || []) {
        const who = op.operatorIdentityId || op.operatorName;
        if (!who) continue;
        for (const scan of op.barcodeScans || []) {
          const at = scan.timeStamp ? new Date(scan.timeStamp) : null;
          if (!at || at < from || at >= to) continue;
          const piece = pieceOf(scan.barcodeId);
          if (!piece || !ctx.byShortId.has(piece.shortId)) continue;
          if (!operatorsBy.has(piece.shortId)) operatorsBy.set(piece.shortId, new Set());
          operatorsBy.get(piece.shortId).add(who);
          everyone.add(who);
        }
      }
    }
  }

  const planned = new Map(); // workOrderId -> minutes
  for (const block of schedule?.scheduledWorkOrders || []) {
    const id = String(block.workOrderId || "");
    if (!ctx.byId.has(id)) continue;
    planned.set(id, (planned.get(id) || 0) + num(block.durationMinutes));
  }

  const lines = [];
  for (const wo of ctx.workOrders) {
    const shortId = shortIdOf(wo._id);
    const perPiece = minutesPerPiece(wo);
    const minutes = planned.get(String(wo._id));
    const target = minutes && perPiece > 0 ? Math.floor(minutes / perPiece) : null;
    const achieved = finished.get(shortId)?.size || 0;
    const qc = qcTally(qcBy.get(shortId) || []);
    const people = operatorsBy.get(shortId)?.size || 0;
    const remarks = (wo.productionNotes || [])
      .filter((n) => n?.note && n.addedAt && new Date(n.addedAt) >= from && new Date(n.addedAt) < to)
      .map((n) => n.note);
    if (!achieved && !qc.inspected && !people && !target && !remarks.length) continue;
    lines.push({
      ...lineOf(wo),
      // Once the CMS records lines, and the manpower and working minutes
      // efficiency needs (the daily line report).
      lineNo: null,
      efficiency: null,
      target,
      achieved,
      inspected: qc.inspected,
      defective: qc.defective,
      defects: qc.defects,
      dhu: qc.dhu,
      rework: qc.rework,
      rejected: qc.rejected,
      manpower: people || null,
      remarks,
    });
  }
  if (!lines.length) return empty;

  const total = (key) => lines.reduce((sum, l) => sum + num(l[key]), 0);
  const targets = lines.filter((l) => l.target != null);
  const inspected = total("inspected");
  return {
    kind: "production",
    day,
    ...headOf(ctx.order),
    lines,
    totals: {
      target: targets.length ? targets.reduce((sum, l) => sum + l.target, 0) : null,
      achieved: total("achieved"),
      inspected,
      defective: total("defective"),
      defects: total("defects"),
      dhu: inspected ? round((total("defects") / inspected) * 100, 1) : null,
      rework: total("rework"),
      rejected: total("rejected"),
      manpower: everyone.size || null,
      lineNo: null,
      efficiency: null,
    },
    hasWork: true,
  };
}

// ─── Format 7 · Final Inspection Report ──────────────────────────────────────
async function inspectionReport(ctx) {
  const shortIds = [...ctx.byShortId.keys()];
  const [account, scans] = await Promise.all([
    ctx.order.customerId
      ? CRMAccount.findOne({ linkedCustomer: ctx.order.customerId })
          .select("garmentSalesProfile.defaultAqlLevel garmentSalesProfile.defaultInspectionStandard")
          .lean()
      : null,
    shortIds.length
      ? QCInspection.find({ workOrderShortId: { $in: qcIds(shortIds) } })
          .select("barcodeId date status defects defectTypes stageCode stageName inspectedByQCName")
          .lean()
      : [],
  ]);

  // The final checkpoint's scans. Scans taken before QC had checkpoints
  // carry none, and then every check stands in for it.
  const staged = scans.filter((s) => s.stageCode || s.stageName);
  const final = staged.filter((s) => /final/i.test(`${s.stageCode || ""} ${s.stageName || ""}`));
  const basis = final.length ? "final" : staged.length ? "none" : scans.length ? "all" : "none";
  const used = basis === "final" ? final : basis === "all" ? scans : [];

  const types = new Map();
  for (const s of used) {
    const named = [
      ...(s.defects || []).flatMap((d) => (d.types || []).map((t) => t.name || t.code)),
      ...(s.defectTypes || []).map((t) => t.name || t.code),
    ].filter(Boolean);
    for (const name of named) types.set(name, (types.get(name) || 0) + 1);
  }
  const dates = used.map((s) => s.date).filter(Boolean).sort();

  return {
    kind: "inspection",
    ...headOf(ctx.order),
    styles: stylesOf(ctx),
    totalOrderQty: ctx.workOrders.reduce((sum, wo) => sum + num(wo.quantity), 0),
    aqlLevel: account?.garmentSalesProfile?.defaultAqlLevel || null,
    inspectionStandard: account?.garmentSalesProfile?.defaultInspectionStandard || null,
    // The AQL inspection itself, once the CMS records it (FinalInspection).
    lot: null,
    sampleSize: null,
    defectsBySeverity: null,
    measurementCheck: null,
    result: null,
    inspectors: [...new Set(used.map((s) => s.inspectedByQCName).filter((n) => n && n !== "QC"))],
    finalQc: {
      basis,
      ...qcTally(used),
      topDefects: [...types.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      from: dates[0] || null,
      to: dates[dates.length - 1] || null,
    },
  };
}

// ─── Format 10 · Order Closing Report ────────────────────────────────────────

// The buyer's final invoice: a posted sales invoice to their own ledger
// (found as the invoice history finds it, routes/Customer_Routes/
// CustomerRequests.js /invoice-history) that names this order.
async function finalInvoiceOf(order) {
  const customer = order.customerId
    ? await Customer.findById(order.customerId).select("name profile.companyName").lean()
    : null;
  if (!customer) return null;
  let ledgers = await Acc_Ledger.find({ linkedCustomerId: customer._id, isActive: { $ne: false } })
    .select("_id")
    .lean();
  if (!ledgers.length) {
    for (const candidate of [customer.profile?.companyName, customer.name].filter(Boolean)) {
      ledgers = await Acc_Ledger.find({
        name: new RegExp(`^${escapeRx(candidate.trim())}$`, "i"),
        isActive: { $ne: false },
      })
        .select("_id")
        .lean();
      if (ledgers.length) break;
    }
  }
  if (!ledgers.length) return null;

  const named = new RegExp(`^\\s*${escapeRx(order.requestId)}\\s*$`, "i");
  const invoices = await Acc_Voucher.find({
    voucherType: "sales",
    status: "posted",
    isOptional: { $ne: true },
    partyLedgerId: { $in: ledgers.map((l) => l._id) },
    $or: [{ sourceId: order._id }, { sourceReference: named }, { referenceNumber: named }],
  })
    .select("voucherNumber voucherDate")
    .sort({ voucherDate: -1 })
    .lean();
  if (!invoices.length) return null;
  return {
    number: invoices[0].voucherNumber,
    date: invoices[0].voucherDate,
    all: invoices.map((v) => v.voucherNumber),
  };
}

// When the order was closed: on the order once the CMS records it, or when
// its sales journey was closed.
async function closingDateOf(order) {
  if (order.closedAt) return order.closedAt;
  const enquiry = await Enquiry.findOne({ customerRequestId: order._id, isActive: true })
    .select("journeyId")
    .lean();
  if (!enquiry?.journeyId) return null;
  const journey = await SalesJourney.findById(enquiry.journeyId).select("closedAt").lean();
  return journey?.closedAt || null;
}

async function closingReport(ctx) {
  const { order } = ctx;
  const shortIds = [...ctx.byShortId.keys()];
  const [challans, invoice, closedAt, rejectedScans, fabric] = await Promise.all([
    DispatchChallan.find({ manufacturingOrderId: order._id })
      .select("challanNumber totalUnits createdAt")
      .lean(),
    finalInvoiceOf(order),
    closingDateOf(order),
    shortIds.length
      ? QCInspection.find({ workOrderShortId: { $in: qcIds(shortIds) }, status: "rejected" })
          .select("barcodeId")
          .lean()
      : [],
    fabricUse(ctx),
  ]);

  // Money and the last challan, from the closing report Sales uses.
  const report = buildClosingReport({ workOrders: ctx.workOrders, challans, request: order });

  // Packed and shipped as the buyer's tracking page counts them
  // (routes/Customer_Routes/OrderTracking.js): the work order's packed count,
  // and the larger of its dispatched count and its dispatch records. The
  // Sales report counts only pieces past the last stage scan, which reads 0
  // for an order made without stage scans.
  const shippedOf = (wo) =>
    Math.max(
      num(wo.dispatchedQuantity),
      (wo.dispatchRecords || []).reduce((sum, r) => sum + num(r.dispatchedQuantity), 0),
    );
  const sizeOf = (wo) => {
    const size = (wo.variantAttributes || []).find((a) => /size/i.test(a?.name || ""));
    return size?.value ? String(size.value) : variantOf(wo) || "—";
  };
  const lines = ctx.workOrders
    .map((wo) => {
      const ordered = num(wo.quantity);
      const shipped = shippedOf(wo);
      return {
        style: wo.stockItemName || wo.stockItemReference || "—",
        styleNo: wo.stockItemReference || null,
        size: sizeOf(wo),
        ordered,
        packed: num(wo.packagedQuantity),
        dispatched: shipped,
        short: Math.max(0, ordered - shipped),
        excess: Math.max(0, shipped - ordered),
      };
    })
    .sort((a, b) => a.style.localeCompare(b.style) || a.size.localeCompare(b.size));
  const dispatchDates = ctx.workOrders
    .flatMap((wo) => (wo.dispatchRecords || []).map((r) => r.dispatchedAt))
    .filter(Boolean)
    .map((d) => new Date(d).getTime());
  const lastDispatch =
    report.dates.lastDispatch ||
    (dispatchDates.length ? new Date(Math.max(...dispatchDates)) : null);
  const { money } = report;
  const payment = {
    invoiced: money.invoiced,
    received: money.received,
    outstanding: money.outstanding,
    overdue: money.overdue,
    status: money.settled
      ? "Paid in full"
      : money.overdue
        ? "Overdue"
        : money.received > 0
          ? "Part paid"
          : money.invoiced > 0
            ? "Not paid yet"
            : null,
  };

  return {
    kind: "closing",
    ...headOf(order),
    styles: stylesOf(ctx),
    lines,
    delivery: {
      ordered: lines.reduce((sum, l) => sum + l.ordered, 0),
      packed: lines.reduce((sum, l) => sum + l.packed, 0),
      dispatched: lines.reduce((sum, l) => sum + l.dispatched, 0),
      short: lines.reduce((sum, l) => sum + l.short, 0),
      excess: lines.reduce((sum, l) => sum + l.excess, 0),
      challans: challans.length,
      lastDispatch,
    },
    rejections: new Set(rejectedScans.map((s) => s.barcodeId)).size,
    fabric,
    invoice,
    payment,
    closedAt,
    closed: !!closedAt,
    remarks: order.closingRemarks || null,
  };
}

// ─── Which reports an order has ──────────────────────────────────────────────
async function reportDays(ctx) {
  const days = new Map();
  const mark = (day, kind, saved = false) => {
    if (!day) return;
    if (!days.has(day)) days.set(day, { day, cutting: false, production: false, saved: [] });
    const d = days.get(day);
    d[kind] = true;
    if (saved && !d.saved.includes(kind)) d.saved.push(kind);
  };

  const woIds = ctx.workOrders.map((wo) => wo._id);
  const shortIds = [...ctx.byShortId.keys()];
  const [records, completions, qcDays, saved] = await Promise.all([
    woIds.length
      ? CuttingMasterRecord.find({ "entries.woId": { $in: woIds } })
          .select("date entries.woId entries.timestamp")
          .lean()
      : [],
    shortIds.length
      ? ProductionCompletionScanRecord.find({ "scans.barcodeId": { $regex: barcodeRx(shortIds) } })
          .select("date")
          .lean()
      : [],
    shortIds.length ? QCInspection.distinct("date", { workOrderShortId: { $in: qcIds(shortIds) } }) : [],
    BuyerDailyReport.find({ customerRequestId: ctx.order._id }).select("day kind").lean(),
  ]);

  for (const record of records) {
    for (const entry of record.entries || []) {
      if (!entry.woId || !ctx.byId.has(String(entry.woId))) continue;
      mark(entry.timestamp ? dayOf(entry.timestamp) : record.date, "cutting");
    }
  }
  for (const doc of completions) mark(dayOf(doc.date), "production");
  for (const day of qcDays) if (isDay(day)) mark(day, "production");
  for (const s of saved) mark(s.day, s.kind, true);

  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

async function overview(order) {
  const ctx = await contextOf(order);
  const [days, closedAt] = await Promise.all([reportDays(ctx), closingDateOf(order)]);
  return {
    requestId: order.requestId,
    today: today(),
    days,
    inspection: { available: ctx.workOrders.length > 0 },
    closing: { available: ctx.workOrders.length > 0, closed: !!closedAt },
  };
}

// A day's report: the saved copy of a past day when there is one, otherwise
// worked out from the records.
async function dailyReportFor(order, kind, day) {
  if (day < today()) {
    const saved = await BuyerDailyReport.findOne({ customerRequestId: order._id, day, kind })
      .select("report savedAt")
      .lean();
    if (saved) return { ...saved.report, savedAt: saved.savedAt };
  }
  const ctx = await contextOf(order);
  const report = kind === "cutting" ? await cuttingReport(ctx, day) : await productionReport(ctx, day);
  return { ...report, savedAt: null };
}

const inspectionReportFor = async (order) => inspectionReport(await contextOf(order));
const closingReportFor = async (order) => closingReport(await contextOf(order));

// ─── The daily save ──────────────────────────────────────────────────────────

// Orders with cutting, finished pieces or QC on a day.
async function ordersWithWork(day) {
  const from = startOf(day);
  const to = startOf(addDays(day, 1));
  const woIds = new Set();
  const shortIds = new Set();

  const [records, completion, qcShortIds] = await Promise.all([
    CuttingMasterRecord.find({ date: { $in: [addDays(day, -1), day] } })
      .select("date entries.woId entries.timestamp")
      .lean(),
    ProductionCompletionScanRecord.findOne({ date: from }).select("scans.barcodeId").lean(),
    QCInspection.distinct("workOrderShortId", { date: day }),
  ]);
  for (const record of records) {
    for (const entry of record.entries || []) {
      if (!entry.woId) continue;
      const at = entry.timestamp ? new Date(entry.timestamp) : null;
      if (at ? at < from || at >= to : record.date !== day) continue;
      woIds.add(String(entry.woId));
    }
  }
  for (const scan of completion?.scans || []) {
    const piece = pieceOf(scan.barcodeId);
    if (piece) shortIds.add(piece.shortId);
  }
  for (const id of qcShortIds) if (id) shortIds.add(String(id).toLowerCase());

  const found = [];
  if (woIds.size) {
    found.push(...(await WorkOrder.find({ _id: { $in: [...woIds] } }).select("customerRequestId").lean()));
  }
  if (shortIds.size) {
    found.push(
      ...(await WorkOrder.find({
        $expr: {
          $in: [{ $toLower: { $substrCP: [{ $toString: "$_id" }, 16, 8] } }, [...shortIds]],
        },
      })
        .select("customerRequestId")
        .lean()),
    );
  }
  return [...new Set(found.map((wo) => wo.customerRequestId).filter(Boolean).map(String))];
}

// Saves the day's Cutting and Production reports of every order that had
// work, leaving any copy already saved as it was.
async function saveDay(day) {
  if (!isDay(day) || day >= today()) throw new Error(`Only a day that has ended can be saved: ${day}`);
  const orderIds = await ordersWithWork(day);
  let saved = 0;
  for (const id of orderIds) {
    try {
      const order = await CustomerRequest.findById(id).select(ORDER_FIELDS).lean();
      if (!order) continue;
      const ctx = await contextOf(order);
      for (const [kind, build] of [
        ["cutting", cuttingReport],
        ["production", productionReport],
      ]) {
        const report = await build(ctx, day);
        if (!report.hasWork) continue;
        const res = await BuyerDailyReport.updateOne(
          { customerRequestId: order._id, day, kind },
          { $setOnInsert: { customerRequestId: order._id, day, kind, report, savedAt: new Date() } },
          { upsert: true },
        );
        if (res.upsertedCount) saved += 1;
      }
    } catch (err) {
      console.error(`[buyerReports] could not save ${day} for order ${id}:`, err.message);
    }
  }
  console.log(
    `[buyerReports] ${day}: saved ${saved} daily report${saved === 1 ? "" : "s"} ` +
      `for ${orderIds.length} order${orderIds.length === 1 ? "" : "s"} with work`,
  );
  return { day, orders: orderIds.length, saved };
}

let job = null;
// Starts the nightly save: 00:15 India time, for the day that has just
// ended, and once a minute after boot in case the server was down at
// midnight. Call after the database connects.
function startDailySave() {
  if (job) return;
  BuyerDailyReport.createIndexes().catch((err) =>
    console.error("[buyerReports] could not build the index:", err.message),
  );
  const saveYesterday = () =>
    saveDay(addDays(today(), -1)).catch((err) =>
      console.error("[buyerReports] daily save failed:", err.message),
    );
  job = cron.schedule("15 0 * * *", saveYesterday, { timezone: "Asia/Kolkata" });
  const boot = setTimeout(saveYesterday, 60 * 1000);
  if (typeof boot.unref === "function") boot.unref();
}

module.exports = {
  orderFor,
  overview,
  dailyReportFor,
  inspectionReportFor,
  closingReportFor,
  saveDay,
  startDailySave,
  isDay,
  today,
  // For tests.
  _internal: { dayOf, startOf, addDays, pieceOf, qcTally, minutesPerPiece, cuttingReport, productionReport, contextOf },
};
