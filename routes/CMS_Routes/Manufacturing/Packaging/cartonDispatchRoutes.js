// routes/CMS_Routes/Manufacturing/Packaging/cartonDispatchRoutes.js
//
// DISPATCH IS A SCAN OF A SEALED CARTON — NEVER A TYPED QUANTITY (25 Sep 2026).
//
// Mount in server.js, beside the packaging-dispatch view:
//   app.use("/api/cms/manufacturing/carton-dispatch", cartonDispatchRoutes);
//
// ── WHY THE TYPED QUANTITY WENT ─────────────────────────────────────────────
// The Dispatch tab used to take a number against a work order ("dispatch 40 of
// WO-…") and a "custom receipt" that printed a challan for any figure at all.
// Nothing tied either to a box that left the building: the same forty units
// could be dispatched twice, a challan could name pieces still on the shelf,
// and a customer who opened a carton had no record saying it was the one that
// was sent. Every sealed carton already carries a QR with its number, and the
// carton record lists every piece inside it by work order, unit number and —
// on a measurement order — the person it was made for. So the only way a
// piece leaves now is inside a carton whose label was scanned here.
//
// ── WHAT ONE DISPATCH DOES, ALL OR NOTHING ──────────────────────────────────
//   1. Every carton named is re-read INSIDE the transaction and must be this
//      company's, this order's and still `packed`. One that is not refuses the
//      whole request — a challan naming a carton that did not leave is worse
//      than no challan.
//   2. A DispatchChallan is created from the cartons' lines (persons /
//      bulkProducts stay filled, because the PPC ledger, the order-target
//      reader, the closing verdict and the CEO dispatch screen read them).
//   3. Each carton becomes `dispatched`, with the challan number and who did it.
//   4. Each work order's `dispatchedQuantity` grows by its pieces in those
//      cartons, and a dispatchRecord names the cartons and the challan.
//   5. On a measurement order, each person's progress document is marked
//      dispatched the way the old person-wise route did, so their screens
//      keep reading the same field.
//
// The challan number is reserved the way carton numbers are: an atomic
// counter, not countDocuments()+1, so two people dispatching at once cannot
// print the same number.

"use strict";

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const PackingCarton = require("../../../../models/CMS_Models/Manufacturing/Packaging/PackingCarton");
const DispatchChallan = require("../../../../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");
const { normaliseCartonNumber, isCartonReference } = require("../../../../services/packingCartonRef");
const { displayWorkOrderNumber } = require("../../../../services/manufacturing/workOrderNumber");
const { resolvePhotos, resolveVariantAttributes, variantText } = require("../../../../services/manufacturing/workOrderPhoto");
const access = require("./packagingAccess");
const { poOf, PO_SELECT } = require("../../../../services/customerRequestPo");

router.use(EmployeeAuthMiddleware);

const canRead = [access.packagingReader(), access.packagingCompany];
const canRecord = [access.packagingDepartment("editor"), access.packagingCompany];
const companyOf = (req) => req.packaging.companyId;

/* ── the challan counter ──────────────────────────────────────────────────
   Same collection and shape as the carton counter (crm_sequences — the
   cluster is at its collection cap, see services/packingCartonRef.js). */
const Counter = mongoose.models.CRMSequence || mongoose.model("CRMSequence", new mongoose.Schema(
  { key: { type: String, required: true, unique: true, index: true }, seq: { type: Number, default: 0 } },
  { timestamps: true, collection: "crm_sequences" },
));

function istDayKey(d = new Date()) {
  const t = new Date(d.getTime() + 330 * 60 * 1000);
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** DC-YYYYMMDD-NNNN, sequential per IST day, safe under concurrency. The
 *  first number of a day starts after whatever the legacy count already
 *  reached, so a day that mixes old and new challans cannot collide. */
async function nextChallanNumber(now = new Date()) {
  const day = istDayKey(now);
  const key = `dispatchChallan:${day}`;
  const existing = await Counter.findOne({ key }).lean();
  if (!existing) {
    const legacy = await DispatchChallan.countDocuments({ challanNumber: new RegExp(`^DC-${day}-`) });
    await Counter.updateOne({ key }, { $setOnInsert: { seq: legacy } }, { upsert: true });
  }
  const doc = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { new: true }).lean();
  return `DC-${day}-${String(doc.seq).padStart(4, "0")}`;
}

/* ── describing a carton for the screen ─────────────────────────────────── */

async function describeLines(lines) {
  const [photos, variants] = await Promise.all([resolvePhotos(lines), resolveVariantAttributes(lines)]);
  return lines.map((l, i) => {
    const text = variantText({ attributes: variants[i]?.attributes });
    return {
      ...l,
      unitNumbers: undefined,
      productImage: photos[i],
      variantText: text === "Not specified" ? "" : text,
    };
  });
}

function weightState(c) {
  const last = c.lastPackedAt || c.packedAt;
  const needsReweigh = c.weightKg != null && c.weighedAt && last && new Date(c.weighedAt) < new Date(last);
  return { weightKg: c.weightKg ?? null, weighedAt: c.weighedAt || null, needsReweigh: Boolean(needsReweigh) };
}

/** Every order with pieces in the box — the list when it has one, else the head. */
function ordersOf(c) {
  if (Array.isArray(c.orders) && c.orders.length) return c.orders.map((o) => ({ manufacturingOrderId: o.manufacturingOrderId ? String(o.manufacturingOrderId) : null, moNumber: o.moNumber || "", poNumber: o.poNumber || "", customerName: o.customerName || "" }));
  return c.manufacturingOrderId ? [{ manufacturingOrderId: String(c.manufacturingOrderId), moNumber: c.moNumber || "", poNumber: c.poNumber || "", customerName: c.customerName || "" }] : [];
}
/** Does this box hold any piece of the order? */
const holdsOrder = (c, moId) => ordersOf(c).some((o) => o.manufacturingOrderId === String(moId));
/** The order a line belongs to: its own, else the carton's head. */
const lineOrderOf = (c, l) => String(l.manufacturingOrderId || c.manufacturingOrderId || "");
/** The pieces of ONE order in the box. */
const piecesOfOrder = (c, moId) => (c.lines || []).reduce((n, l) => n + (lineOrderOf(c, l) === String(moId) ? (Number(l.quantity) || 0) : 0), 0);
const cartonsHolding = (companyId, moId, extra = {}) => ({ companyId, ...extra, $or: [{ manufacturingOrderId: access.oid(moId) }, { "orders.manufacturingOrderId": access.oid(moId) }] });

async function publicCarton(c, forOrder = null) {
  const orders = ordersOf(c);
  return {
    _id: String(c._id),
    cartonNumber: c.cartonNumber,
    moNumber: c.moNumber,
    poNumber: c.poNumber || "",
    customerName: c.customerName || "",
    manufacturingOrderId: c.manufacturingOrderId ? String(c.manufacturingOrderId) : null,
    orders,
    mixed: orders.length > 1,
    piecesOfThisOrder: forOrder ? piecesOfOrder(c, forOrder) : null,
    dispatchChallans: (c.dispatchChallans || []).map((d) => ({ challanNumber: d.challanNumber, moNumber: d.moNumber })),
    totalQuantity: c.totalQuantity,
    workOrderCount: c.workOrderCount,
    status: c.status,
    packedBy: c.packedBy || null,
    packedAt: c.packedAt,
    lastPackedAt: c.lastPackedAt || c.packedAt,
    dispatchedAt: c.dispatchedAt || null,
    dispatchedBy: c.dispatchedBy || null,
    dispatchChallanNumber: c.dispatchChallanNumber || "",
    dispatchChallanId: c.dispatchChallanId ? String(c.dispatchChallanId) : null,
    notes: c.notes || "",
    ...weightState(c),
    lines: (await describeLines(c.lines || [])).map((l) => ({ ...l, manufacturingOrderId: l.manufacturingOrderId ? String(l.manufacturingOrderId) : (c.manufacturingOrderId ? String(c.manufacturingOrderId) : null), moNumber: l.moNumber || c.moNumber || "" })),
  };
}

const refuse = (res, status, code, message, extra = {}) => res.status(status).json({ success: false, code, message, ...extra });

/** The one place a scanned code becomes a carton of THIS order — or a reason. */
async function resolveForOrder(companyId, moId, rawCode) {
  const code = access.str(rawCode);
  if (!code) return { refusal: [400, "EMPTY", "Scan a carton label, or type its number."] };
  if (!isCartonReference(code)) {
    const looksLikePiece = /^WO-/i.test(code);
    return { refusal: [400, "NOT_A_CARTON", looksLikePiece
      ? `${code} is a piece barcode. Dispatch scans the CARTON label (CTN-…) — the box the piece is sealed in.`
      : `"${code}" is not a carton label. A carton is CTN-YYYY-NNNN, printed on the A4 label with its QR.`] };
  }
  const cartonNumber = normaliseCartonNumber(code);
  const carton = await PackingCarton.findOne({ companyId, cartonNumber }).lean();
  if (!carton) return { refusal: [404, "NOT_FOUND", `Carton ${cartonNumber} was not found. Check the label — it may belong to another company or never have been sealed.`] };
  /* A box holding ANY piece of this order may leave from here; a mixed box
     leaves whole, and every order inside it gets its own challan. */
  if (!holdsOrder(carton, moId)) {
    const theirs = ordersOf(carton).map((o) => [o.moNumber, o.customerName].filter(Boolean).join(" · ")).join(", ") || "another order";
    return { refusal: [409, "OTHER_ORDER", `Carton ${cartonNumber} holds ${theirs}, not this order. Open that order to dispatch it.`, { carton: { cartonNumber, moNumber: carton.moNumber, customerName: carton.customerName, manufacturingOrderId: carton.manufacturingOrderId } }] };
  }
  if (carton.status === "dispatched") {
    return { refusal: [409, "ALREADY_DISPATCHED", `Carton ${cartonNumber} already left${carton.dispatchChallanNumber ? ` on challan ${carton.dispatchChallanNumber}` : ""}${carton.dispatchedAt ? ` (${new Date(carton.dispatchedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })})` : ""}.`, { carton: { cartonNumber, dispatchChallanNumber: carton.dispatchChallanNumber, dispatchedAt: carton.dispatchedAt } }] };
  }
  if (!carton.totalQuantity || !(carton.lines || []).length) {
    return { refusal: [409, "EMPTY_CARTON", `Carton ${cartonNumber} holds no pieces — it cannot be dispatched.`] };
  }
  return { carton };
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /manufacturing-orders/:moId/overview
// The whole dispatch standing of one order: cartons ready, cartons gone,
// pieces in each state, and what is packed but sits in no carton (legacy).
// ═════════════════════════════════════════════════════════════════════════════
router.get("/manufacturing-orders/:moId/overview", ...canRead, async (req, res) => {
  try {
    const { moId } = req.params;
    const companyId = companyOf(req);
    const { visible, objectIds } = await access.moScope(companyId, moId);
    if (!visible) return access.notFound(res, "manufacturing order");

    const [mo, wos, cartons] = await Promise.all([
      CustomerRequest.findById(moId).select(`requestId customerInfo requestType measurementName deliveryDeadline ${PO_SELECT}`).lean(),
      WorkOrder.find(access.scoped(companyId, { customerRequestId: access.oid(moId) }))
        .select("workOrderNumber stockItemName quantity packagedQuantity dispatchedQuantity").lean(),
      PackingCarton.find(cartonsHolding(companyId, moId)).sort({ packedAt: -1 }).lean(),
    ]);

    const ready = [];
    const gone = [];
    for (const c of cartons) (c.status === "dispatched" ? gone : ready).push(await publicCarton(c, moId));

    /* This order's pieces in those boxes — a mixed box counts only its own. */
    const pieces = (list) => list.reduce((n, c) => n + (c.piecesOfThisOrder ?? c.totalQuantity ?? 0), 0);
    const orderQuantity = wos.reduce((n, w) => n + (w.quantity || 0), 0);
    const packedQuantity = wos.reduce((n, w) => n + (w.packagedQuantity || 0), 0);
    const dispatchedQuantity = wos.reduce((n, w) => n + (w.dispatchedQuantity || 0), 0);
    const inCartons = pieces(ready) + pieces(gone);

    return res.json({
      success: true,
      order: {
        _id: String(moId),
        moNumber: mo ? `MO-${mo.requestId}` : "",
        requestId: mo?.requestId || "",
        customerName: mo?.customerInfo?.name || "",
        customerInfo: mo?.customerInfo || null,
        poNumber: poOf(mo).poNumber,
        isMeasurement: mo?.requestType === "measurement_conversion" || Boolean(mo?.measurementName),
        deliveryDeadline: mo?.deliveryDeadline || mo?.customerInfo?.deliveryDeadline || null,
        workOrders: wos.length,
      },
      totals: {
        orderQuantity,
        packedQuantity,
        dispatchedQuantity,
        cartonsReady: ready.length,
        cartonsDispatched: gone.length,
        piecesReady: pieces(ready),
        piecesInDispatchedCartons: pieces(gone),
        /* Packed on the old quantity screens before cartons existed (24 Sep
           2026): counted as packed by the work orders, in no box. Nothing
           here can dispatch them — they need a carton first. */
        packedNotInCarton: Math.max(0, packedQuantity - inCartons),
        notYetPacked: Math.max(0, orderQuantity - packedQuantity),
      },
      ready,
      dispatched: gone,
    });
  } catch (err) {
    console.error("Carton dispatch overview error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /manufacturing-orders/:moId/resolve   { code }
// One scan → one carton of this order, described — or the exact reason not.
// Read-only: the carton is staged on the screen, nothing moves yet.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/manufacturing-orders/:moId/resolve", ...canRead, async (req, res) => {
  try {
    const { moId } = req.params;
    const companyId = companyOf(req);
    const { visible } = await access.moScope(companyId, moId);
    if (!visible) return access.notFound(res, "manufacturing order");
    const r = await resolveForOrder(companyId, moId, req.body?.code);
    if (r.refusal) { const [status, code, message, extra] = r.refusal; return refuse(res, status, code, message, extra); }
    return res.json({ success: true, carton: await publicCarton(r.carton, moId) });
  } catch (err) {
    console.error("Carton dispatch resolve error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /manufacturing-orders/:moId/dispatch
//   { cartonNumbers: [...], notes?, transport?: { vehicleNumber, driverName,
//     driverPhone, transporter, lrNumber } }
// ═════════════════════════════════════════════════════════════════════════════
const MAX_CARTONS = 200;
const clean = (v, max = 120) => access.str(v).slice(0, max);

router.post("/manufacturing-orders/:moId/dispatch", ...canRecord, async (req, res) => {
  try {
    const { moId } = req.params;
    const companyId = companyOf(req);
    const { visible } = await access.moScope(companyId, moId);
    if (!visible) return access.notFound(res, "manufacturing order");

    const asked = [...new Set((Array.isArray(req.body?.cartonNumbers) ? req.body.cartonNumbers : []).map((c) => normaliseCartonNumber(c)).filter(Boolean))];
    if (!asked.length) return refuse(res, 400, "NO_CARTONS", "Scan at least one carton before dispatching.");
    if (asked.length > MAX_CARTONS) return refuse(res, 400, "TOO_MANY", `One challan can carry at most ${MAX_CARTONS} cartons.`);
    for (const n of asked) if (!isCartonReference(n)) return refuse(res, 400, "NOT_A_CARTON", `"${n}" is not a carton number.`);

    const notes = clean(req.body?.notes, 500);
    const t = req.body?.transport || {};
    const transport = {
      vehicleNumber: clean(t.vehicleNumber, 32).toUpperCase(),
      driverName: clean(t.driverName, 80),
      driverPhone: clean(t.driverPhone, 20),
      transporter: clean(t.transporter, 120),
      lrNumber: clean(t.lrNumber, 60),
    };

    const mo = await CustomerRequest.findById(moId).select(`requestId customerInfo requestType measurementName ${PO_SELECT}`).lean();
    if (!mo) return access.notFound(res, "manufacturing order");

    const actor = {
      userId: access.str(req.user?.id),
      name: access.str(req.user?.name) || access.str(req.user?.employeeId) || "Dispatch Dept",
      employeeId: access.str(req.user?.employeeId),
      email: access.str(req.user?.email).toLowerCase(),
      role: access.str(req.user?.role),
    };
    const dispatchedBy = actor.name;
    const now = new Date();

    /* Pre-check outside the transaction so the person gets the precise reason
       (wrong order, already gone) rather than a transaction abort. The same
       conditions are enforced again inside it. */
    for (const n of asked) {
      const r = await resolveForOrder(companyId, moId, n);
      if (r.refusal) { const [status, code, message, extra] = r.refusal; return refuse(res, status, code, message, { ...extra, cartonNumber: n }); }
    }

    const session = await mongoose.startSession();
    let result = null;
    try {
      await session.withTransaction(async () => {
        const cartons = await PackingCarton.find(cartonsHolding(companyId, moId, { cartonNumber: { $in: asked }, status: "packed" })).session(session);
        if (cartons.length !== asked.length) {
          const have = new Set(cartons.map((c) => c.cartonNumber));
          const missing = asked.filter((n) => !have.has(n));
          throw Object.assign(new Error(`Carton ${missing.join(", ")} changed while you were dispatching — reload and scan again.`), { status: 409, code: "CHANGED" });
        }
        cartons.sort((a, b) => asked.indexOf(a.cartonNumber) - asked.indexOf(b.cartonNumber));

        /* Work orders touched, this company's, read once under the session. */
        const woIds = [...new Set(cartons.flatMap((c) => (c.lines || []).map((l) => String(l.workOrderId))))];
        const wos = await WorkOrder.find(access.scoped(companyId, { _id: { $in: woIds.map(access.oid) } })).session(session);
        const woById = new Map(wos.map((w) => [String(w._id), w]));
        const foreign = woIds.filter((id) => !woById.has(id));
        if (foreign.length) throw Object.assign(new Error("A carton names work that is not this company's."), { status: 409, code: "FOREIGN_WORK" });

        /* Variant text per line, resolved the way the carton page shows it. */
        const allLines = cartons.flatMap((c) => c.lines || []);
        const variants = await resolveVariantAttributes(allLines);
        let vi = 0;

        /* ── ONE CHALLAN PER ORDER IN THE LOAD (8 Oct 2026) ────────────────
           A mixed carton leaves whole, but each order's dispatch history is
           its own: the lines are grouped by order, and every order present
           gets a challan listing the cartons and ITS lines in them. The
           order this screen belongs to gets the first number and is the
           carton's head challan. */
        const orderIds = [String(moId), ...new Set(cartons.flatMap((c) => (c.lines || []).map((l) => lineOrderOf(c, l))).filter((k) => k && k !== String(moId)))];
        const mosById = new Map([[String(moId), mo]]);
        const others = orderIds.slice(1).filter(access.isId);
        if (others.length) {
          for (const m of await CustomerRequest.find({ _id: { $in: others.map(access.oid) } }).select(`requestId customerInfo requestType measurementName ${PO_SELECT}`).session(session).lean()) mosById.set(String(m._id), m);
        }
        const perOrder = new Map(orderIds.map((k) => [k, { persons: new Map(), bulk: new Map(), challanCartons: [], totalUnits: 0, cartonNumbers: new Set() }]));
        const perWo = new Map();
        const progressIds = [];
        let totalUnits = 0;

        for (const c of cartons) {
          const linesByOrder = new Map();
          for (const l of c.lines || []) {
            const ok = lineOrderOf(c, l) || String(moId);
            const bucket = perOrder.get(ok) || perOrder.get(String(moId));
            const { persons, bulk } = bucket;
            if (!linesByOrder.has(ok)) linesByOrder.set(ok, []);
            const lines = linesByOrder.get(ok);
            const wo = woById.get(String(l.workOrderId));
            const attrs = variants[vi++]?.attributes || l.variantAttributes || [];
            const vText = (() => { const t = variantText({ attributes: attrs }); return t === "Not specified" ? "" : t; })();
            const workOrderNumber = wo ? displayWorkOrderNumber(wo) : (l.workOrderNumber || "");
            const qty = Number(l.quantity) || 0;
            totalUnits += qty;
            lines.push({ workOrderId: l.workOrderId, workOrderNumber, productName: l.productName || wo?.stockItemName || "—", productRef: l.productReference || wo?.stockItemReference || "", variantText: vText, quantity: qty, employeeName: l.employee?.employeeName || "", employeeUIN: l.employee?.employeeUIN || "" });

            bucket.totalUnits += qty;
            bucket.cartonNumbers.add(c.cartonNumber);
            const wk = String(l.workOrderId);
            if (!perWo.has(wk)) perWo.set(wk, { qty: 0, cartons: new Set(), employeeIds: [], employeeNames: [], orderKey: ok });
            const agg = perWo.get(wk);
            agg.qty += qty; agg.cartons.add(c.cartonNumber);

            const product = { progressDocId: l.employee?.progressDocId || null, workOrderId: l.workOrderId, workOrderNumber, productName: l.productName || wo?.stockItemName || "—", productRef: l.productReference || wo?.stockItemReference || "", variantAttributes: attrs.map((a) => ({ name: a.name, value: a.value })), quantity: qty };
            if (l.packagingType === "person_wise" && (l.employee?.employeeName || l.employee?.employeeId)) {
              const pk = String(l.employee.employeeId || l.employee.employeeUIN || l.employee.employeeName);
              if (!persons.has(pk)) persons.set(pk, { employeeId: l.employee.employeeId || null, employeeName: l.employee.employeeName || "—", employeeUIN: l.employee.employeeUIN || "", department: "", designation: "", products: [], totalUnits: 0 });
              const p = persons.get(pk); p.products.push(product); p.totalUnits += qty;
              if (l.employee.employeeId) agg.employeeIds.push(l.employee.employeeId);
              if (l.employee.employeeName) agg.employeeNames.push(l.employee.employeeName);
              if (l.employee.progressDocId) progressIds.push(l.employee.progressDocId);
            } else {
              const bk = `${wk}|${vText}`;
              if (!bulk.has(bk)) bulk.set(bk, { ...product, progressDocId: null, quantity: 0 });
              bulk.get(bk).quantity += qty;
            }
          }
          for (const [ok, lines] of linesByOrder) {
            const bucket = perOrder.get(ok) || perOrder.get(String(moId));
            /* The carton on this order's challan: the whole box's number and
               weight, with THIS order's lines and their count. */
            bucket.challanCartons.push({ cartonId: c._id, cartonNumber: c.cartonNumber, totalQuantity: lines.reduce((n, l) => n + l.quantity, 0), weightKg: c.weightKg ?? null, lines });
          }
        }

        const challans = [];
        const challanByOrder = new Map();
        for (const ok of orderIds) {
          const b = perOrder.get(ok);
          if (!b || !b.challanCartons.length) continue;
          const m = mosById.get(ok) || null;
          const number = await nextChallanNumber(now);
          const dispatchType = b.persons.size && !b.bulk.size ? "person_wise" : "bulk";
          const [challan] = await DispatchChallan.create([{
            challanNumber: number,
            manufacturingOrderId: access.oid(ok),
            requestId: m?.requestId || "",
            customerName: m?.customerInfo?.name || "—",
            customerInfo: m?.customerInfo || null,
            dispatchType,
            persons: [...b.persons.values()],
            bulkProducts: [...b.bulk.values()],
            totalUnits: b.totalUnits,
            totalPersons: b.persons.size,
            totalProducts: dispatchType === "person_wise" ? [...b.persons.values()].reduce((n, p) => n + p.products.length, 0) : b.bulk.size,
            notes,
            dispatchedBy,
            createdBy: mongoose.Types.ObjectId.isValid(actor.userId) ? access.oid(actor.userId) : null,
            source: "carton",
            cartons: b.challanCartons,
            cartonCount: b.challanCartons.length,
            transport,
          }], { session });
          challans.push(challan);
          challanByOrder.set(ok, challan);
        }
        const challan = challanByOrder.get(String(moId)) || challans[0];
        const challanNumber = challan.challanNumber;

        for (const c of cartons) {
          c.status = "dispatched";
          c.dispatchedAt = now;
          c.dispatchChallanId = challan._id;
          c.dispatchChallanNumber = challanNumber;
          c.dispatchChallans = challans
            .filter((ch) => ch.cartons.some((k) => k.cartonNumber === c.cartonNumber))
            .map((ch) => ({ challanId: ch._id, challanNumber: ch.challanNumber, manufacturingOrderId: ch.manufacturingOrderId, moNumber: mosById.get(String(ch.manufacturingOrderId))?.requestId ? `MO-${mosById.get(String(ch.manufacturingOrderId)).requestId}` : "" }));
          c.dispatchedBy = actor;
          await c.save({ session });
        }

        for (const [wk, agg] of perWo) {
          const wo = woById.get(wk);
          /* Capped at the order quantity like the old routes; a work order
             with no quantity recorded takes the count as it is. */
          const cap = wo.quantity > 0 ? wo.quantity : Infinity;
          wo.dispatchedQuantity = Math.min(cap, (wo.dispatchedQuantity || 0) + agg.qty);
          wo.dispatchRecords = wo.dispatchRecords || [];
          wo.dispatchRecords.push({
            dispatchedQuantity: agg.qty, dispatchedAt: now, dispatchedBy, notes,
            dispatchType: agg.employeeIds.length ? "person_wise" : "bulk",
            employeeIds: agg.employeeIds, employeeNames: agg.employeeNames,
            cartonNumbers: [...agg.cartons], challanNumber: challanByOrder.get(agg.orderKey)?.challanNumber || challanNumber,
          });
          await wo.save({ session });
        }

        if (progressIds.length) {
          await EmployeeProductionProgress.updateMany(
            { _id: { $in: progressIds }, workOrderId: { $in: woIds.map(access.oid) } },
            { $set: { isDispatched: true, dispatchedAt: now, dispatchedBy, dispatchNotes: notes }, $push: { dispatchHistory: { dispatchedAt: now, dispatchedBy, notes: notes || `Carton dispatch ${challanNumber}` } } },
            { session },
          );
        }

        result = { challan: challan.toObject(), challans: challans.map((ch) => ({ challanNumber: ch.challanNumber, manufacturingOrderId: String(ch.manufacturingOrderId), moNumber: mosById.get(String(ch.manufacturingOrderId))?.requestId ? `MO-${mosById.get(String(ch.manufacturingOrderId)).requestId}` : "", totalUnits: ch.totalUnits, cartonCount: ch.cartonCount })), challanNumber, cartonNumbers: cartons.map((c) => c.cartonNumber), totalUnits, workOrders: perWo.size, persons: [...perOrder.values()].reduce((n, b) => n + b.persons.size, 0) };
      });
    } catch (e) {
      if (e?.status) return refuse(res, e.status, e.code || "REFUSED", e.message);
      throw e;
    } finally {
      await session.endSession();
    }

    const extra = result.challans.filter((ch) => ch.challanNumber !== result.challanNumber);
    return res.json({
      success: true,
      message: `Challan ${result.challanNumber}: ${result.cartonNumbers.length} carton${result.cartonNumbers.length !== 1 ? "s" : ""} · ${result.totalUnits} piece${result.totalUnits !== 1 ? "s" : ""} dispatched.${extra.length ? ` Also ${extra.map((ch) => `${ch.challanNumber} for ${ch.moNumber || "another order"}`).join(", ")} — the mixed carton${result.cartonNumbers.length !== 1 ? "s" : ""} left whole.` : ""}`,
      challan: result.challan,
      challans: result.challans,
      summary: { cartons: result.cartonNumbers.length, cartonNumbers: result.cartonNumbers, pieces: result.totalUnits, workOrders: result.workOrders, persons: result.persons },
    });
  } catch (err) {
    console.error("Carton dispatch error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

module.exports = router;
