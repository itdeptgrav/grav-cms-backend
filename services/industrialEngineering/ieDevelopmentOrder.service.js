"use strict";
// services/industrialEngineering/ieDevelopmentOrder.service.js
//
// THE DEVELOPMENT ORDER, HANDLED BY INDUSTRIAL ENGINEERING (4 Oct 2026, owner).
//
//   R&D   → "send to IE": the product variants with Sales' quantities, a
//           priority and a delivery deadline. Nothing is created yet.
//   IE    → assigns the operations, each with an ASSUMED SAM (minutes),
//           picked from the operation register the work orders run on.
//   IE    → "start processing": the operations are written onto the product
//           as its route and the sampling request + work orders are created
//           through the ONE release the R&D wizard used to run — so Cutting,
//           Production, the finishing stages, QC and Packaging see the work.
//   IE    → reads the departments' progress (the same ledger the PPC board
//           reads, for this one order), and
//   IE    → "complete order": the ACTUAL SAM per operation, a note; the live
//           work orders are marked completed and R&D is told.
//
// Everything is stored on the SampleStyle's `production.developmentOrder` —
// the cluster is at its collection cap, and the order is a fact about the
// style. The register row and workspace stay read-only; the writes are here
// and behind IE's editor rung.

const mongoose = require("mongoose");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const { ownershipProofFor } = require("../centralCosting/technicalSource.service");
const { fail, CODES } = require("../storePurchase/errors");
const { notifyEvent, APP_URL, escapeHtml } = require("../departmentNotify.service");

const str = (v) => (v == null ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));
const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const NOT_FOUND = () => fail(CODES.NOT_FOUND || "NOT_FOUND", "That development style was not found.");
const refuse = (message, details) => fail(CODES.VALIDATION || "VALIDATION", message, details);

/* the route file exports the shared release lazily — it requires half the
   Sales module and must not be loaded at this module's load time */
const sampleRoutes = () => require("../../routes/CMS_Routes/Sales/sampleStyles");

const actorRef = (a) => ({ id: a?.id || null, name: str(a?.name), email: str(a?.email) });

async function ownedStyle(ctx, styleId) {
  if (!isId(styleId)) throw NOT_FOUND();
  const style = await SampleStyle.findById(styleId);
  if (!style) throw NOT_FOUND();
  if (!(await ownershipProofFor(style, ctx.companyId))) throw NOT_FOUND();
  return style;
}

/* ── what one reader gets ──────────────────────────────────────────────── */

async function progressFor(ctx, style) {
  const moId = style.production?.customerRequestId;
  if (!moId) return null;
  try {
    const orders = require("../ppc/control/orders.service");
    const d = await orders.orderDetail(ctx.companyId, String(moId));
    if (!d) return null;
    /* projected by hand: the figures, and nothing about people, prices or
       customers — this is an engineering read */
    return {
      quantity: d.order?.quantity ?? null,
      produced: d.order?.produced ?? null,
      progressPct: d.order?.progressPct ?? null,
      stage: d.order?.stage || "",
      departments: (d.departments || []).map((p) => ({
        department: p.department, label: p.label, applicable: Boolean(p.applicable),
        quantity: p.quantity ?? null, done: p.done ?? 0, remaining: p.remaining ?? null, pct: p.pct ?? 0,
        today: p.today ?? 0, lastAt: p.lastAt || null,
      })),
      workOrders: (d.workOrders || []).map((w) => ({
        id: w.id, number: w.number, variant: w.variant || "", quantity: w.quantity, status: w.status,
        produced: w.produced ?? 0, progressPct: w.progressPct ?? 0, currentStage: w.currentStage || "",
        departments: (w.departments || []).filter((x) => x.applicable).map((x) => ({ department: x.department, label: x.label, done: x.done, pct: x.pct })),
      })),
    };
  } catch (e) {
    console.error("[ieDevelopmentOrder] progress read failed:", e?.message || e);
    return null;
  }
}

async function workOrdersFor(style) {
  const ids = style.production?.workOrderIds || [];
  if (!ids.length) return [];
  const rows = await WorkOrder.find({ _id: { $in: ids } })
    .select("workOrderNumber status quantity stockItemId stockItemName variantId variantAttributes productionCompletion.overallCompletedQuantity").lean();
  /* the product's photo, variant image first (5 Oct 2026, owner: "showcase
     the product photo as you are showing the WO") — the same resolver every
     department screen uses */
  const { resolvePhotos } = require("../manufacturing/workOrderPhoto");
  const photos = await resolvePhotos(rows).catch(() => rows.map(() => null));
  return rows.map((w, i) => ({
    id: String(w._id), number: w.workOrderNumber || `WO-${String(w._id).slice(-8)}`, status: w.status,
    quantity: Number(w.quantity) || 0, produced: Number(w.productionCompletion?.overallCompletedQuantity) || 0,
    variant: (w.variantAttributes || []).map((a) => a?.value).filter(Boolean).join(" · "),
    productName: str(w.stockItemName), photo: photos[i] || null,
  }));
}

async function view(ctx, style) {
  const p = style.production || {};
  const { developmentOrderView } = sampleRoutes();
  const order = developmentOrderView(p.developmentOrder);
  const variants = (p.orderVariants || []).map((v) => ({
    variantId: String(v.variantId), label: v.variantLabel || "Default", sku: v.sku || "", quantity: Number(v.quantity) || 0,
  }));
  const total = variants.reduce((n, v) => n + v.quantity, 0);
  const [workOrders, progress] = order.status === "processing" || order.status === "completed"
    ? await Promise.all([workOrdersFor(style), progressFor(ctx, style)])
    : [[], null];
  /* the progress read's work orders carry the same photo */
  if (progress?.workOrders?.length) {
    const photoOf = new Map(workOrders.map((w) => [w.id, w.photo]));
    progress.workOrders = progress.workOrders.map((w) => ({ ...w, photo: photoOf.get(String(w.id)) || null }));
  }
  return {
    order: {
      ...order,
      styleId: String(style._id),
      reference: str(style.styleCode) || str(style.sampleStyleId),
      productName: str(style.productName),
      variantLabel: str(style.variantLabel),
      variants, total,
      techSheetStatus: str(style.techSheet?.status),
      productRegistered: Boolean(p.stockItemId || style.sourceStockItemId),
      /* the approved materials with the merchandiser's assumed consumption —
         the same figures R&D's page shows (4 Oct 2026) */
      materials: (style.materials?.rawItems || []).map((r) => ({
        rawItemId: r.rawItemId ? String(r.rawItemId) : "", rawItemName: str(r.rawItemName), rawItemSku: str(r.rawItemSku),
        variant: (r.variantCombination || []).map(str).filter(Boolean).join(" · "),
        appliesTo: str(r.productVariantLabel) || "All variants",
        quantity: r.quantity ?? null, unit: str(r.unit),
      })),
      requestNumber: null,
      workOrders,
      progress,
      /* what the screen may offer */
      canAssign: ["sent_to_ie", "operations_assigned"].includes(order.status),
      canStart: order.status === "operations_assigned" && order.operations.length > 0,
      canComplete: order.status === "processing",
    },
  };
}

async function readOrder(ctx, { styleId } = {}) {
  const style = await ownedStyle(ctx, styleId);
  const out = await view(ctx, style);
  if (style.production?.customerRequestId) {
    const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
    const r = await CustomerRequest.findById(style.production.customerRequestId).select("requestId").lean();
    out.order.requestNumber = r?.requestId ? `MO-${r.requestId}` : null;
  }
  return out;
}

/* ── IE assigns the operations ─────────────────────────────────────────── */

async function assignOperations(ctx, { styleId, rows, actor } = {}) {
  const style = await ownedStyle(ctx, styleId);
  const dev = style.production?.developmentOrder || {};
  if (!["sent_to_ie", "operations_assigned"].includes(dev.status)) {
    throw refuse(dev.status === "none"
      ? "R&D has not sent this order to IE yet."
      : "The operations are fixed once processing has started.");
  }
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) throw refuse("Choose at least one operation.");
  const ids = list.map((r) => str(r?.operationId));
  if (ids.some((id) => !isId(id))) throw refuse("An operation in the list is not a registered operation.");
  const masters = await Operation.find({ _id: { $in: ids } }).select("name operationCode totalSam machineType").lean();
  const byId = new Map(masters.map((m) => [String(m._id), m]));
  const operations = [];
  list.forEach((r, i) => {
    const m = byId.get(str(r.operationId));
    if (!m) throw refuse(`Operation ${i + 1} no longer exists in the register.`);
    const sam = num(r.assumedSamMinutes);
    if (sam === null || sam < 0) throw refuse(`Give an assumed SAM (minutes) for "${m.name}".`);
    operations.push({
      operationId: m._id, operationCode: str(m.operationCode), name: str(m.name), machineType: str(m.machineType),
      assumedSamMinutes: sam, actualSamMinutes: null,
    });
  });
  const who = actorRef(actor);
  style.production.developmentOrder = {
    ...(dev.toObject ? dev.toObject() : dev),
    status: "operations_assigned", operations, operationsAssignedAt: new Date(), operationsAssignedBy: who,
  };
  style.production.log = style.production.log || [];
  const totalSam = operations.reduce((n, o) => n + (o.assumedSamMinutes || 0), 0);
  /* ONE LINE PER EDITING SESSION (5 Oct 2026). The order page autosaves, so
     every change is a save; a log line per save buried R&D's history under
     "IE assigned the operations" ×12. A save by the same person within 30
     minutes of their last one, with nothing logged in between, rewrites that
     line instead of adding another. */
  const entry = { kind: "ie_operations_assigned", note: `${operations.length} operation(s), ${Math.round(totalSam * 100) / 100} SAM assumed.`, by: who, at: new Date() };
  const last = style.production.log[style.production.log.length - 1];
  const sameHand = last && last.kind === "ie_operations_assigned"
    && (str(last.by?.id) === str(who.id) && str(last.by?.name) === str(who.name))
    && Date.now() - new Date(last.at).getTime() < 30 * 60 * 1000;
  if (sameHand) {
    last.note = entry.note; last.at = entry.at;
    if (typeof style.markModified === "function") style.markModified("production.log");
  } else {
    style.production.log.push(entry);
  }
  style.updatedBy = who;
  await style.save();
  return view(ctx, style);
}

/* ── IE starts the run: the product gets its route, the floor gets its work ── */

async function startOrder(ctx, { styleId, actor, userId } = {}) {
  const style = await ownedStyle(ctx, styleId);
  const dev = style.production?.developmentOrder || {};
  if (dev.status !== "operations_assigned") {
    throw refuse(dev.status === "processing" || dev.status === "completed"
      ? "This order has already been started."
      : "Assign the operations before starting the run.");
  }
  const operations = dev.operations || [];
  if (!operations.length) throw refuse("Assign the operations before starting the run.");
  const stockItemId = style.production?.stockItemId || style.sourceStockItemId;
  if (!stockItemId) throw refuse("The style has no registered product.");
  const stockItem = await StockItem.findById(stockItemId);
  if (!stockItem) throw refuse("The registered product could not be found.");

  /* the route the work orders are cut from — IE's operations with the
     assumed SAM, in the same shape the technical-route sync writes */
  stockItem.operations = operations.map((o) => {
    const totalSeconds = Math.max(0, Math.round((Number(o.assumedSamMinutes) || 0) * 60));
    return {
      type: o.name || "", operationCode: o.operationCode || "", machine: o.machineType || "", machineType: o.machineType || "",
      totalSeconds, minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60, operatorSalary: 0, operatorCost: 0,
    };
  });
  stockItem.updatedBy = userId;
  await stockItem.save();

  const who = actorRef(actor);
  style.production.developmentOrder = {
    ...(dev.toObject ? dev.toObject() : dev),
    status: "processing", startedAt: new Date(), startedBy: who,
  };
  style.production.log = style.production.log || [];
  style.production.log.push({ kind: "ie_started", note: "IE started processing the development order.", by: who, at: new Date() });

  const { releaseSampleToProduction } = sampleRoutes();
  let released;
  try {
    released = await releaseSampleToProduction(style, {
      priority: dev.priority, deliveryDeadline: dev.deliveryDeadline, userId, who, keepProductRoute: true,
    });
  } catch (e) {
    /* the style was not saved by a refused release — say why, with the code */
    throw fail(e.code || CODES.VALIDATION || "VALIDATION", e.message || "The run could not be released.", e.products ? { products: e.products } : undefined);
  }

  (async () => {
    const { styleEmailContext, imageGalleryHtml } = require("../sampleStyleEmail.service");
    const { createServiceContext } = require("../companyContext/serviceScope.service");
    const c = await styleEmailContext(style, createServiceContext({ companyId: ctx.companyId, reason: "development order e-mail", legacyAware: true })).catch(() => null);
    await notifyEvent("development_order_started", {
      vars: { product: style.productName || "", customer: c?.customerName || "", styleCode: style.styleCode || style.sampleStyleId || "", person: who.name || "IE" },
      heading: `Development order started: ${style.productName || style.styleCode || ""}`,
      bodyHtml: `<p><strong>${escapeHtml(who.name || "Industrial Engineering")}</strong> started processing this development order. ${released.createdWorkOrders.length} work order(s) are on the floor under ${escapeHtml(released.request.requestId || "the sampling request")}.</p>` + opsTableHtml(operations),
      details: [...(c?.details || [["Style", style.styleCode || style.sampleStyleId], ["Product", style.productName]]), ["Work orders", String(released.createdWorkOrders.length)], ["Request", released.request.requestId]],
      image: c?.images?.[0], extraHtml: imageGalleryHtml(c?.images || []),
      bodyText: `${who.name || "IE"} started the development order for "${style.productName || "a style"}" — ${released.createdWorkOrders.length} work order(s).`,
      ctaLabel: "Open in R&D", ctaUrl: `${APP_URL}/research-development/styles/${style._id}`,
    });
  })().catch((e) => console.error("[ieDevelopmentOrder] started mail:", e?.message || e));

  const fresh = await SampleStyle.findById(style._id);
  return { ...(await view(ctx, fresh)), released: { requestNumber: released.request.requestId, workOrders: released.createdWorkOrders.length } };
}

/* ── IE completes the run with the measured SAM ─────────────────────────── */

async function completeOrder(ctx, { styleId, rows, note, actor } = {}) {
  const style = await ownedStyle(ctx, styleId);
  const dev = style.production?.developmentOrder || {};
  if (dev.status !== "processing") {
    throw refuse(dev.status === "completed" ? "This order is already complete." : "The run has not been started yet.");
  }
  const actuals = new Map((Array.isArray(rows) ? rows : []).map((r) => [str(r?.operationId), num(r?.actualSamMinutes)]));
  const operations = (dev.operations || []).map((o) => {
    const a = actuals.get(String(o.operationId));
    if (a === null || a === undefined || a < 0) throw refuse(`Give the actual SAM (minutes) for "${o.name}".`);
    return { ...(o.toObject ? o.toObject() : o), actualSamMinutes: a };
  });
  if (!operations.length) throw refuse("This order has no operations recorded.");
  const who = actorRef(actor);

  /* the live work orders are declared complete by IE — the floor cannot be
     relied on to close a sample run through packaging */
  const liveIds = (style.production.workOrderIds || []);
  const closed = liveIds.length
    ? await WorkOrder.updateMany(
      { _id: { $in: liveIds }, status: { $nin: ["cancelled", "completed"] } },
      { $set: { status: "completed", "timeline.actualEndDate": new Date() } },
    )
    : { modifiedCount: 0 };

  style.production.developmentOrder = {
    ...(dev.toObject ? dev.toObject() : dev),
    status: "completed", operations, completedAt: new Date(), completedBy: who, completionNote: str(note).slice(0, 2000),
  };
  style.production.log = style.production.log || [];
  style.production.log.push({ kind: "ie_completed", note: `IE completed the run — ${closed.modifiedCount || 0} work order(s) closed.${str(note) ? ` ${str(note)}` : ""}`, by: who, at: new Date() });
  style.updatedBy = who;
  await style.save();

  (async () => {
    const { styleEmailContext, imageGalleryHtml } = require("../sampleStyleEmail.service");
    const { createServiceContext } = require("../companyContext/serviceScope.service");
    const c = await styleEmailContext(style, createServiceContext({ companyId: ctx.companyId, reason: "development order e-mail", legacyAware: true })).catch(() => null);
    await notifyEvent("development_order_completed", {
      vars: { product: style.productName || "", customer: c?.customerName || "", styleCode: style.styleCode || style.sampleStyleId || "", person: who.name || "IE" },
      heading: `Development order completed: ${style.productName || style.styleCode || ""}`,
      bodyHtml: `<p><strong>${escapeHtml(who.name || "Industrial Engineering")}</strong> completed the development order. Record the sample and send it to Sales for approval.</p>${str(note) ? `<p style="margin:10px 0 0;color:#475569">${escapeHtml(str(note))}</p>` : ""}` + opsTableHtml(operations),
      details: [...(c?.details || [["Style", style.styleCode || style.sampleStyleId], ["Product", style.productName]]), ["Operations", String(operations.length)]],
      image: c?.images?.[0], extraHtml: imageGalleryHtml(c?.images || []),
      bodyText: `${who.name || "IE"} completed the development order for "${style.productName || "a style"}".`,
      ctaLabel: "Open in R&D", ctaUrl: `${APP_URL}/research-development/styles/${style._id}`,
    });
  })().catch((e) => console.error("[ieDevelopmentOrder] completed mail:", e?.message || e));

  return view(ctx, style);
}

function opsTableHtml(operations) {
  const td = "padding:6px 10px 6px 0;border-bottom:1px solid #eef1f5;vertical-align:top";
  const rows = (operations || []).map((o, i) => `<tr><td style="${td};color:#94a3b8">${i + 1}</td><td style="${td}"><strong>${escapeHtml(o.name || "")}</strong>${o.operationCode ? `<br/><span style="color:#94a3b8;font-size:12px">${escapeHtml(o.operationCode)}</span>` : ""}</td><td style="${td};color:#475569">${escapeHtml(o.machineType || "—")}</td><td style="${td};text-align:right">${o.assumedSamMinutes ?? "—"}</td><td style="${td};text-align:right">${o.actualSamMinutes ?? "—"}</td></tr>`).join("");
  return `<p style="margin:16px 0 6px;font-size:12px;color:#64748b;font-weight:600">OPERATIONS (SAM in minutes)</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">
  <thead><tr style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:#94a3b8"><th style="padding:0 10px 6px 0">#</th><th style="padding:0 10px 6px 0">Operation</th><th style="padding:0 10px 6px 0">Machine</th><th style="padding:0 10px 6px 0;text-align:right">Assumed</th><th style="padding:0 10px 6px 0;text-align:right">Actual</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

module.exports = { readOrder, assignOperations, startOrder, completeOrder };
