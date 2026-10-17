/* A DEMO ORDER for trying PPC → Cutting end to end (17 Oct 2026, owner: "ready another
   MO, work orders etc. … deadline / delivery date 24 Oct 2026 … I will plan it").

   Copies the GRAV PVT. LTD bulk order REQ-2026-0003 (Gm shirt S–XXL + Black Pant 30–38)
   as a NEW order with a new request number, small quantities, delivery 24 Oct 2026, and
   fresh work orders: nothing planned, nothing cut, no PPC target, no lay, no labels.
   The shirt sizes that had no fabric on their work order take the S size's per piece.

   Run:      node scripts/oneoff/createDemoOrder.js
   Re-run:   prints the demo order already made and stops (tagged by TAG below).
   Remove:   node scripts/oneoff/createDemoOrder.js --remove   (the order + its work orders)
   Another:  node scripts/oneoff/createDemoOrder.js --tag DEMO-2 --deadline 2026-10-31
             (a second demo beside the first; --remove with the same --tag removes it) */
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");

const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const TAG = argOf("tag") || "DEMO-CUTTING-24OCT";
const DEADLINE_DAY = argOf("deadline") || "2026-10-24";
if (!/^\d{4}-\d{2}-\d{2}$/.test(DEADLINE_DAY)) throw new Error("--deadline must be YYYY-MM-DD");
const DEADLINE = new Date(`${DEADLINE_DAY}T00:00:00.000Z`);
const DEADLINE_WORDS = DEADLINE.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/* pieces per size, by product */
const QTY = {
  "Black Pant": { 30: 10, 32: 20, 34: 20, 36: 10, 38: 10 },
  "Gm shirt": { s: 10, m: 20, l: 20, xl: 10, xxl: 10 },
};
const oid = () => new mongoose.Types.ObjectId();
const lineRef = () => `LN-${crypto.randomBytes(6).toString("hex")}`;
const sizeOf = (attrs = []) => String((attrs.find((a) => /size/i.test(a.name)) || attrs[0] || {}).value || "").toLowerCase();
const round = (n, d = 3) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const CR = db.collection("customerrequests");
  const WO = db.collection("workorders");

  const existing = await CR.findOne({ "customerInfo.description": new RegExp(`^${TAG} ·`) });
  if (process.argv.includes("--remove")) {
    if (!existing) { console.log("No demo order to remove."); return mongoose.disconnect(); }
    const w = await WO.deleteMany({ customerRequestId: existing._id });
    await CR.deleteOne({ _id: existing._id });
    console.log(`Removed ${existing.requestId} and ${w.deletedCount} work orders.`);
    return mongoose.disconnect();
  }
  if (existing) {
    console.log(`Already made: ${existing.requestId} (MO-${existing.requestId}) · id ${existing._id}`);
    return mongoose.disconnect();
  }

  const src = await CR.findOne({ requestId: "REQ-2026-0003", "customerInfo.name": "GRAV PVT. LTD" });
  if (!src) throw new Error("Template order REQ-2026-0003 (GRAV PVT. LTD) not found.");
  const srcWos = await WO.find({ customerRequestId: src._id }).toArray();

  const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
  const { nextRequestId } = require("../../services/requestId");
  const requestId = await nextRequestId(CustomerRequest);
  const now = new Date();
  const crId = oid();

  /* items: same products and variants, the demo quantities */
  let srcTotal = 0, newTotal = 0;
  const items = (src.items || []).map((it) => {
    const want = QTY[it.stockItemName] || {};
    const variants = (it.variants || []).map((v) => {
      const q = want[sizeOf(v.attributes)] ?? 0;
      srcTotal += v.quantity || 0; newTotal += q;
      const per = v.quantity ? (v.estimatedPrice || 0) / v.quantity : 0;
      return { ...v, quantity: q, estimatedPrice: round(per * q, 2) };
    }).filter((v) => v.quantity > 0);
    const totalQuantity = variants.reduce((a, v) => a + v.quantity, 0);
    return { ...it, lineRef: lineRef(), variants, totalQuantity, totalEstimatedPrice: round(variants.reduce((a, v) => a + (v.estimatedPrice || 0), 0), 2) };
  }).filter((it) => it.totalQuantity > 0);
  const f = srcTotal ? newTotal / srcTotal : 0;
  const scaleMoney = (x) => (typeof x === "number" ? round(x * f, 2) : x);

  const quotations = (src.quotations || []).map((q) => ({
    ...q,
    _id: oid(),
    items: (q.items || []).map((qi) => {
      const it = items.find((i) => String(i.stockItemId) === String(qi.stockItemId));
      const qty = it ? it.totalQuantity : 0;
      const unit = qi.quantity ? (qi.unitPrice ?? (qi.totalPrice || 0) / qi.quantity) : 0;
      return { ...qi, _id: oid(), quantity: qty, ...(qi.totalPrice != null ? { totalPrice: round(unit * qty, 2) } : {}) };
    }),
    subtotalBeforeGST: scaleMoney(q.subtotalBeforeGST),
    totalDiscount: scaleMoney(q.totalDiscount),
    totalGST: scaleMoney(q.totalGST),
    grandTotal: scaleMoney(q.grandTotal),
    paymentSchedule: (q.paymentSchedule || []).map((p) => ({ ...p, _id: oid(), amount: scaleMoney(p.amount) })),
    paymentSubmissions: (q.paymentSubmissions || []).map((p) => ({ ...p, _id: oid(), amount: scaleMoney(p.amount) })),
    createdAt: now, updatedAt: now,
  }));

  const order = {
    ...src,
    _id: crId,
    requestId,
    customerInfo: { ...src.customerInfo, deliveryDeadline: DEADLINE, description: `${TAG} · demo order for testing PPC planning and cutting — delivery ${DEADLINE_WORDS}` },
    items,
    quotations,
    taxSummary: src.taxSummary,
    totalPaidAmount: scaleMoney(src.totalPaidAmount),
    finalOrderPrice: scaleMoney(src.finalOrderPrice),
    priority: "high",
    notes: [],
    editRequests: [],
    quotationNotifications: [],
    materialRequests: [],
    processingStartedAt: now,
    createdAt: now, updatedAt: now,
  };
  await CR.insertOne(order);

  /* per-piece fabric of the shirt, for the sizes whose work order carried none */
  const perPieceRaw = {};
  for (const w of srcWos) if ((w.rawMaterials || []).length && w.quantity && !perPieceRaw[w.stockItemName]) {
    perPieceRaw[w.stockItemName] = w.rawMaterials.map((r) => ({ ...r, per: (r.quantityRequired || r.requiredQuantity || 0) / w.quantity, perCost: (r.totalCost || 0) / w.quantity }));
  }

  const made = [];
  for (const w of srcWos) {
    const q = (QTY[w.stockItemName] || {})[sizeOf(w.variantAttributes)] ?? 0;
    if (!q) continue;
    const _id = oid();
    const raws = (w.rawMaterials || []).length
      ? w.rawMaterials.map((r) => ({ ...r, per: (r.quantityRequired || r.requiredQuantity || 0) / w.quantity, perCost: (r.totalCost || 0) / w.quantity }))
      : (perPieceRaw[w.stockItemName] || []);
    const rawMaterials = raws.map(({ per, perCost, ...r }) => ({
      ...r, _id: oid(),
      requiredQuantity: round(per * q), quantityRequired: round(per * q),
      quantityAllocated: 0, quantityIssued: 0, totalCost: round(perCost * q, 2), allocationStatus: "not_allocated",
    }));
    const doc = {
      ...w,
      _id,
      workOrderNumber: `WO-${_id}`,
      customerRequestId: crId,
      variantAttributes: (w.variantAttributes || []).map((a) => ({ ...a, _id: oid() })),
      quantity: q, originalQuantity: q,
      priority: "high",
      status: "pending",
      operations: (w.operations || []).map((o) => ({ ...o, _id: oid(), status: "pending" })),
      rawMaterials,
      timeline: { plannedStartDate: null, plannedEndDate: null, actualStartDate: null, actualEndDate: null, scheduledStartDate: null, scheduledEndDate: null, totalEstimatedSeconds: 0, totalPlannedSeconds: w.timeline?.totalPlannedSeconds || 0, efficiencyPercentage: 100, _id: oid() },
      assignedDeadline: null, assignedDeadlineMeta: { assignedAt: null, assignedBy: null },
      storeDepartmentVerified: false, storeDepartmentVerifiedAt: null, storeDepartmentVerifiedBy: null, storeDepartmentNotes: "",
      estimatedCost: round(rawMaterials.reduce((a, r) => a + (r.totalCost || 0), 0), 2), actualCost: 0,
      qualityCheck: { passed: false },
      cuttingStatus: "pending", cuttingProgress: { completed: 0, remaining: q },
      packagedQuantity: 0, dispatchedQuantity: 0,
      plannedBy: null, plannedAt: null, planningNotes: "",
      isSplitOrder: false, parentWorkOrderId: null, splitReason: "",
      forwardedToVendor: null, forwardedAt: null, forwardedBy: null, vendorWorkOrderReference: null,
      productionNotes: [], packagingRecords: [], dispatchRecords: [], bulkDispatchHistory: [],
      createdAt: now, updatedAt: now, __v: 0,
    };
    delete doc.sentToCutting; delete doc.sentToCuttingAt; delete doc.sentToCuttingBy; delete doc.productionProgress; delete doc.salesLineLink;
    made.push(doc);
  }
  if (made.length) await WO.insertMany(made);

  console.log(`Made ${requestId} (MO-${requestId}) · id ${crId} · delivery ${DEADLINE_WORDS}`);
  for (const d of made) console.log(`  ${d.stockItemName} · ${d.variantAttributes.map((a) => a.value).join("/")} · ${d.quantity} pcs · fabric lines ${d.rawMaterials.length}`);
  console.log(`  ${made.length} work orders, ${made.reduce((a, d) => a + d.quantity, 0)} pieces. Nothing planned, nothing cut.`);
  await mongoose.disconnect();
})().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
