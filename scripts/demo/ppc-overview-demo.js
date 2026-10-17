// scripts/demo/ppc-overview-demo.js
//
// DUMMY DATA SO THE PPC OVERVIEW HAS SOMETHING TO SHOW — AND ONE COMMAND THAT
// TAKES IT ALL BACK OUT.
//
//   node -r dotenv/config scripts/demo/ppc-overview-demo.js            # dry run
//   node -r dotenv/config scripts/demo/ppc-overview-demo.js --apply    # write it
//   node -r dotenv/config scripts/demo/ppc-overview-demo.js --clean --apply
//
// ── THIS WRITES TO WHATEVER MONGODB_URI POINTS AT ───────────────────────────
// On this machine that is the shared Atlas dev cluster, not a private copy.
// Everything it writes is therefore TAGGED with `PPC-DEMO` in a field a person
// reads — the target's note, the cutting entry's recorder, the scan's scanner,
// the QC inspector, the material request's reason — and `--clean` removes rows
// carrying that tag and nothing else. It never deletes by date, by order or by
// "everything in this collection".
//
// ── WHAT IT ADDS ────────────────────────────────────────────────────────────
// Against orders that already exist (it invents no order, no customer and no
// work order):
//   · a PPC target per department on a few active orders, through the real
//     `setTarget` — so the feasibility rules, the capacity checks and the
//     "nothing is left to make" refusals all apply, and a target this seed
//     creates is one PPC could have created;
//   · work recorded today in each of those departments' OWN books — the same
//     collections the control centre counts — so the day has a done figure
//     and the bars are not all zero;
//   · two material requests to the Store, one of them part-issued, so the
//     overview's materials panel and its "Needs you" row have something real
//     behind them.
//
// Nothing here fakes a figure on the overview itself: every number the screen
// shows is still counted by the server from these records.
"use strict";

const mongoose = require("mongoose");

const TAG = "PPC-DEMO";
const APPLY = process.argv.includes("--apply");
const CLEAN = process.argv.includes("--clean");

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
/* Registered because the services below populate through them. */
require("../../models/CMS_Models/Inventory/Products/StockItem");
require("../../models/Employee");
const StockIssuance = require("../../models/CMS_Models/Inventory/Operations/StockIssuance");
const CuttingMasterRecord = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");
const ProductionCompletionScanRecord = require("../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");
const QCInspection = require("../../models/CMS_Models/Manufacturing/QC/DefectRecord");
/* The model IS the export here, not a named property. */
const PpcOrderTarget = require("../../models/CMS_Models/PPC/PpcOrderTarget");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const targets = require("../../services/ppc/orderTargets.service");
const materials = require("../../services/ppc/materialRequests.service");
const packagingAccess = require("../../routes/CMS_Routes/Manufacturing/Packaging/packagingAccess");

const ist = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600_000);
const dayKey = (d = new Date()) => ist(d).toISOString().slice(0, 10);
const plusDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ACTOR = { userId: "", name: `${TAG} seed`, email: "" };
const say = (...a) => console.log(...a);

/** The company the Store and every other PPC read resolves to. */
async function company() {
  const row = await Acc_Company.findOne({ isPrimary: true }).select("_id companyName").lean()
    || await Acc_Company.findOne({}).sort({ isPrimary: -1, _id: 1 }).select("_id companyName").lean();
  if (!row) throw new Error("No company exists in this database.");
  return row;
}

/**
 * Active orders of that company, biggest first — the seed works on real ones.
 *
 * Scoped exactly as the control centre scopes itself (`packagingAccess`), which
 * while the legacy window is open also admits work orders carrying no
 * Sales-line link. Nearly every work order in this database is one, and a
 * stricter rule here would find no order at all and seed nothing.
 */
async function ordersOf(companyId) {
  const ids = await packagingAccess.findWorkOrders(companyId, {}, "customerRequestId").lean()
    .then((rows) => [...new Set(rows.map((r) => String(r.customerRequestId || "")).filter(Boolean))]);
  if (!ids.length) return [];
  const rows = await CustomerRequest.find({ _id: { $in: ids }, status: { $in: ["quotation_sales_approved", "production"] } })
    .select("requestId customerInfo.name items.totalQuantity").lean();
  const out = [];
  for (const mo of rows) {
    const wos = await packagingAccess.findWorkOrders(companyId, { customerRequestId: mo._id }, "_id workOrderNumber quantity status").lean();
    const quantity = wos.reduce((n, w) => n + (w.quantity || 0), 0);
    if (quantity > 0) out.push({ mo, wos, quantity });
  }
  return out.sort((a, b) => b.quantity - a.quantity);
}

/* ── what gets written ─────────────────────────────────────────────────── */

const PLAN = [
  { department: "cutting", share: 0.08 },
  { department: "production", share: 0.06 },
  { department: "qc", share: 0.05 },
  { department: "packaging", share: 0.04 },
];

async function seed() {
  const co = await company();
  say(`Company: ${co.companyName} (${co._id})`);
  const orders = await ordersOf(co._id);
  if (!orders.length) throw new Error("This company has no active order with a linked work order.");
  say(`Active orders with linked work: ${orders.length}`);

  const today = dayKey();
  const made = { targets: [], cutting: 0, sewing: 0, qc: 0, requests: [] };

  /* ── 1. a target per department, sized to what that department has LEFT ──
     `checkTarget` is the same check the form runs, so the seed asks for a
     figure PPC could actually ask for, on the first order that has room. */
  const usedOrders = new Set();
  for (const step of PLAN) {
    let placed = false;
    /* Spread the departments over different orders, so the board reads like a
       floor with several orders moving rather than one order doing everything.
       An order already carrying a seeded target is tried last. */
    const candidates = [...orders].sort((x, y) => (usedOrders.has(String(x.mo._id)) ? 1 : 0) - (usedOrders.has(String(y.mo._id)) ? 1 : 0));
    for (const pick of candidates) {
      const probe = await targets.checkTarget(co._id, String(pick.mo._id), {
        department: step.department, kind: "per_day", pieces: 1, from: today, to: plusDays(today, 6),
      });
      const left = probe?.facts?.left || 0;
      if (!left || probe.errors.some((e) => !/Too many pieces/.test(e))) continue;
      const pieces = Math.max(1, Math.floor(left / 7));
      const body = {
        department: step.department, kind: "per_day", pieces,
        from: today, to: plusDays(today, 6),
        note: `${TAG} — seeded so the overview has a running target`,
      };
      if (!APPLY) { say(`  would set ${step.department} ${pieces}/day on MO-${pick.mo.requestId} (${left} left)`); placed = true; break; }
      try {
        await targets.setTarget(co._id, String(pick.mo._id), body, ACTOR);
        made.targets.push(`${step.department} ${pieces}/day on MO-${pick.mo.requestId}`);
        say(`  set ${step.department}: ${pieces}/day on MO-${pick.mo.requestId} (${left} left)`);
        usedOrders.add(String(pick.mo._id));
        placed = true;
        break;
      } catch (e) { say(`  ${step.department} refused on MO-${pick.mo.requestId}: ${e.message}`); }
    }
    if (!placed) say(`  no order had room for a ${step.department} target`);
  }

  /* ── 2. work recorded TODAY in each department's own book ───────────── */
  const first = orders[0];
  const wo = first.wos[0];
  const shortId = String(wo._id).slice(-8);
  const pieces = Math.max(5, Math.round(first.quantity * 0.05));

  if (APPLY) {
    /* cutting — CuttingMasterRecord.entries, what the ledger counts */
    await CuttingMasterRecord.findOneAndUpdate(
      { employeeId: null, date: today, employeeName: `${TAG} cutter` },
      {
        $setOnInsert: { employeeId: null, employeeName: `${TAG} cutter`, date: today },
        $push: { entries: { woId: wo._id, woNumber: wo.workOrderNumber || "", quantityCut: pieces, startUnit: 1, endUnit: pieces, timestamp: new Date(), recordedBy: { name: TAG } } },
        $inc: { totalUnitsCut: pieces },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    made.cutting = pieces;

    /* sewing — the mark-done ledger, one scan per piece */
    const bucket = new Date(`${today}T00:00:00.000Z`);
    const scans = Array.from({ length: Math.min(pieces, 40) }, (_, i) => ({
      barcodeId: `WO-${shortId}-${String(i + 1).padStart(3, "0")}`,
      scannedAt: new Date(), scannedBy: `${TAG} (seed)`,
    }));
    await ProductionCompletionScanRecord.findOneAndUpdate(
      { date: bucket }, { $push: { scans: { $each: scans } }, $setOnInsert: { date: bucket } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    made.sewing = scans.length;

    /* QC — passed inspections, one per piece */
    const qcRows = Array.from({ length: Math.min(pieces, 25) }, (_, i) => ({
      date: today, barcodeId: `WO-${shortId}-${String(i + 1).padStart(3, "0")}`, workOrderShortId: shortId,
      workOrderId: wo._id, manufacturingOrderId: first.mo._id, status: "passed",
      inspectedByQCName: `${TAG} inspector`, inspectedAt: new Date(),
    }));
    await QCInspection.insertMany(qcRows);
    made.qc = qcRows.length;
    say(`  recorded today: cutting ${made.cutting}, sewing ${made.sewing}, QC ${made.qc} on ${wo.workOrderNumber || shortId}`);
  } else {
    say(`  would record today: cutting ${pieces}, sewing ≤40, QC ≤25 on ${wo.workOrderNumber || shortId}`);
  }

  /* ── 3. two material requests, one part-issued ──────────────────────── */
  const raws = await RawItem.find({}).select("_id name sku baseUnit variants").limit(2).lean();
  if (!raws.length) say("  no raw item exists, so no material request was raised");
  else if (!APPLY) say(`  would raise 2 material requests (${raws.map((r) => r.name).join(", ")})`);
  else {
    for (const [i, order] of orders.slice(0, 2).entries()) {
      const raw = raws[i % raws.length];
      try {
        const out = await materials.create(co._id, String(order.mo._id), {
          reason: `${TAG} — seeded so the Store has something to issue`,
          lines: [{ rawItemId: String(raw._id), quantity: 120, unit: raw.baseUnit || "Pcs", note: TAG }],
        }, ACTOR);
        const created = out?.created || out?.request || null;
        made.requests.push(`MO-${order.mo.requestId} · ${raw.name}`);
        say(`  raised a request on MO-${order.mo.requestId} for ${raw.name}`);

        /* The second one gets a part issue, so the panel shows both states. */
        if (i === 1 && created?.id) {
          const stored = await CustomerRequest.findById(order.mo._id).select("requestId materialRequests").lean();
          const req = (stored.materialRequests || []).find((r) => String(r._id) === String(created.id));
          const line = req?.lines?.[0];
          if (line) {
            await StockIssuance.create({
              manufacturingOrder: order.mo._id, moNumber: `MO-${stored.requestId}`, direction: "debit",
              reason: `${TAG} part issue`, performedByName: `${TAG} store`,
              materialRequestId: req._id,
              items: [{ rawItem: line.rawItemId, rawItemName: line.rawItemName, rawItemSku: line.rawItemSku,
                materialRequestLineId: line._id, issuedQty: 40, issuedUnit: line.unit, nativeQty: 40, nativeUnit: line.unit, notes: TAG }],
            });
            say("  …and issued 40 of it, so one request reads part-issued");
          }
        }
      } catch (e) { say(`  skipped a request on MO-${order.mo.requestId}: ${e.message}`); }
    }
  }

  say(APPLY ? "\nSeeded. Open /ppc." : "\nDry run — nothing was written. Re-run with --apply.");
}

/* ── taking it back out ───────────────────────────────────────────────── */

async function clean() {
  const counts = {};
  const tag = new RegExp(TAG);

  counts.targets = (await PpcOrderTarget.countDocuments({ note: tag }));
  counts.cuttingRecords = (await CuttingMasterRecord.countDocuments({ employeeName: tag }));
  counts.qc = (await QCInspection.countDocuments({ inspectedByQCName: tag }));
  counts.scanRecords = (await ProductionCompletionScanRecord.countDocuments({ "scans.scannedBy": tag }));
  counts.issues = (await StockIssuance.countDocuments({ performedByName: tag }));
  counts.ordersWithRequests = (await CustomerRequest.countDocuments({ "materialRequests.reason": tag }));

  say("Tagged rows found:", JSON.stringify(counts));
  if (!APPLY) return say("Dry run — nothing was removed. Re-run with --clean --apply.");

  await PpcOrderTarget.deleteMany({ note: tag });
  await CuttingMasterRecord.deleteMany({ employeeName: tag });
  await QCInspection.deleteMany({ inspectedByQCName: tag });
  await StockIssuance.deleteMany({ performedByName: tag });
  /* The scan ledger is one document per day shared with real scans: pull only
     the seeded scans out of it, never the document. */
  await ProductionCompletionScanRecord.updateMany(
    { "scans.scannedBy": tag }, { $pull: { scans: { scannedBy: tag } } },
  );
  await CustomerRequest.updateMany(
    { "materialRequests.reason": tag }, { $pull: { materialRequests: { reason: tag } } },
  );
  say("Removed every row carrying the tag.");
}

(async () => {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  say(`${CLEAN ? "Cleaning" : "Seeding"} ${APPLY ? "(writing)" : "(dry run)"} on ${uri.replace(/\/\/[^@]*@/, "//***@")}`);
  try { await (CLEAN ? clean() : seed()); }
  finally { await mongoose.disconnect(); }
})().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
