// services/production/salesLineWorkOrderLink.service.js
//
// THE CONFIRMED SALES LINE ↔ WORK ORDER BRIDGE.
//
// ── WHAT THIS CLOSES ────────────────────────────────────────────────────────
// A WorkOrder carried `customerRequestId` and nothing finer. A customer
// request routinely holds several lines — the same product twice, for two
// colourways or two deliveries — so "which WorkOrders make THIS line" could
// only be answered by product, style, name or order number, every one of
// which is a guess. PPC plans per permanent Sales line (`LN-…`), and Cutting
// and Embroidery report against WorkOrders, so without an exact bridge the two
// cannot be joined honestly.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// A newly created WorkOrder belongs to exactly ONE permanent Sales `lineRef`
// and ONE server-proven company, written in the same save that creates it and
// never changed afterwards (the model refuses a later write). Nothing here is
// ever read from a request body: the line comes from the stored
// CustomerRequest line the WorkOrder is being built from, and the company from
// the owner of that line's approved style (checked against the actor's own
// membership where the route resolves one).
//
// Where each creation path gets its identity:
//   - Sales release (bulk):    the exact `items[]` line being iterated.
//   - Sales release (measurement): grouped by the person's CONFIRMED line
//     first, then by production size. A person whose measured size disagrees
//     with their line's size, or a line whose people do not add up to its
//     quantity, is refused — never silently moved. See planMeasurementRelease.
//   - Add product (measurement person edit): the exact line for the product
//     AND size, never "the first line carrying the product".
//   - Split: inherits the parent's stored link, unchanged. An unlinked
//     (historical) parent yields an unlinked child — absence is inherited
//     as absence, never filled in.
//   - Return / remake: the NEW return request's own line, plus an explicit
//     `origin` naming the source WorkOrders and their lines. It does not claim
//     to be the original Sales line.
//
// Historical WorkOrders have no link and are reported as `unlinked`. Nothing
// here backfills them by product, style, size, name or number.
"use strict";

const mongoose = require("mongoose");

const { fail, sendError } = require("../storePurchase/errors");
const workOrderStyleLink = require("../industrialEngineering/workOrderStyleLink.service");
const { mintLineRef } = require("../../models/Customer_Models/customerRequestLineIdentity");

const model = (name, path) => (mongoose.models[name] || require(path));
const WorkOrder = () => model("WorkOrder", "../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");
const StockItem = () => model("StockItem", "../../models/CMS_Models/Inventory/Products/StockItem");
const Measurement = () => model("Measurement", "../../models/Customer_Models/Measurement");
const MeasurementSizeConfig = () =>
  model("MeasurementSizeConfig", "../../models/CMS_Models/Inventory/Configurations/MeasurementSizeConfig");

const str = (v) => String(v?._id ?? v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

const LINK_STATE = Object.freeze({ LINKED: "linked", UNLINKED: "unlinked" });
const BASIS = Object.freeze({
  SALES_LINE: "sales_line",
  SPLIT_PARENT: "split_parent",
  RETURN_LINE: "return_line",
});

/* Codes of our own, carried on the shared error shape. The shared registry
   (services/storePurchase/errors.js) belongs to another lane, so the status is
   borrowed from an existing key and the code is set on the instance —
   `sendError` reads both from the instance. */
const CODES = Object.freeze({
  LINE_REF_MISSING: "WORK_ORDER_SALES_LINE_REF_MISSING",
  LINE_NOT_FOUND: "WORK_ORDER_SALES_LINE_NOT_FOUND",
  LINE_AMBIGUOUS: "WORK_ORDER_SALES_LINE_AMBIGUOUS",
  LINE_CHANGED: "WORK_ORDER_SALES_LINE_CHANGED",
  COMPANY_UNPROVEN: "WORK_ORDER_SALES_LINE_COMPANY_UNPROVEN",
  COMPANY_MISMATCH: "WORK_ORDER_SALES_LINE_COMPANY_MISMATCH",
  MEASUREMENT_CONFLICT: "WORK_ORDER_MEASUREMENT_LINE_CONFLICT",
});

function lineFail(code, message, details = {}, statusKey = "CONFLICT") {
  const err = fail(statusKey, message, details);
  err.code = code;
  return err;
}

const lineVariantIds = (line) => (line?.variants || []).map((v) => str(v?.variantId)).filter(Boolean);

/* ═══ SALES RELEASE ════════════════════════════════════════════════════════ */

/**
 * Make sure every line about to be released has a STORED permanent name.
 *
 * Every CustomerRequest save mints missing line references (model hook), but
 * the release routes build WorkOrders BEFORE they save the request, and some
 * open requests predate line references. A WorkOrder must never point at a
 * reference that exists only in memory, so the missing ones are minted here
 * and persisted first, each with a guarded positional update: it applies only
 * if that position still holds the same product with no reference. If the
 * order moved underneath us the release refuses rather than naming the wrong
 * line. This is the same mint the next save would perform — not a backfill of
 * any WorkOrder, and no reference that already exists is ever changed.
 */
async function ensureStoredLineRefs(request, lines = null) {
  const items = Array.isArray(request?.items) ? request.items : [];
  const wanted = lines ? new Set(lines) : null;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (wanted && !wanted.has(item)) continue;
    if (str(item?.lineRef)) continue;
    const taken = new Set(items.map((x) => str(x?.lineRef)).filter(Boolean));
    let minted = mintLineRef();
    while (taken.has(minted)) minted = mintLineRef();
    const result = await CustomerRequest().updateOne(
      {
        _id: request._id,
        [`items.${i}.stockItemId`]: item.stockItemId?._id || item.stockItemId,
        $or: [{ [`items.${i}.lineRef`]: { $exists: false } }, { [`items.${i}.lineRef`]: { $in: [null, ""] } }],
      },
      { $set: { [`items.${i}.lineRef`]: minted } },
    );
    if (!result.matchedCount) {
      throw lineFail(CODES.LINE_CHANGED,
        "This order changed while it was being released, so its lines cannot be named safely. "
        + "Reload the order and release it again.");
    }
    if (typeof item.set === "function") item.set("lineRef", minted);
    else item.lineRef = minted;
  }
}

/**
 * Prove the Sales-line identity and company for a whole release, before its
 * first WorkOrder is written.
 *
 * @param {object} request   the CustomerRequest being released (document)
 * @param {string[]} styleIds the styles the IE pre-flight already proved
 * @param {{expectedCompanyId?: string|null, lines?: object[]}} opts  `lines`
 *   limits the proof to the lines actually being linked (default: all)
 * @returns {Promise<{companyId: string, linkFor: (line) => object}>}
 */
async function proveReleaseLines(request, styleIds, { expectedCompanyId = null, lines = null } = {}) {
  await ensureStoredLineRefs(request, lines);

  /* The stored record is the authority, not the in-memory document. */
  const stored = await CustomerRequest().findById(request._id).select("items.lineRef").lean();
  const storedRefs = new Set((stored?.items || []).map((i) => str(i.lineRef)).filter(Boolean));
  const proving = lines || request.items || [];
  for (const item of proving) {
    if (!storedRefs.has(str(item.lineRef))) {
      throw lineFail(CODES.LINE_REF_MISSING,
        `This order cannot be released for production: the line for ${item.stockItemName || "a product"} `
        + "has no permanent line reference on the stored order. Reload the order and release it again.");
    }
  }

  const { companyId } = await workOrderStyleLink.assertStylesUsable(styleIds, { expectedCompanyId });
  if (!isId(companyId)) {
    throw lineFail(CODES.COMPANY_UNPROVEN,
      "This order cannot be released for production: the company it belongs to cannot be proved.");
  }

  return {
    companyId,
    linkFor: (line) => {
      if (!storedRefs.has(str(line?.lineRef))) {
        throw lineFail(CODES.LINE_REF_MISSING,
          "A work order cannot be linked to a line that is not on the stored order.");
      }
      return {
        companyId: oid(companyId),
        customerRequestId: request._id,
        lineRef: str(line.lineRef),
        basis: BASIS.SALES_LINE,
        linkedAt: new Date(),
      };
    },
  };
}

/**
 * A release retried after a partial failure must not make a second WorkOrder
 * for a line and size it already made. Returns the live WorkOrder previously
 * released for exactly this line and variant, or null.
 */
async function existingReleaseWorkOrder(customerRequestId, lineRef, variantId) {
  return WorkOrder().findOne({
    "salesLineLink.customerRequestId": customerRequestId,
    "salesLineLink.lineRef": str(lineRef),
    "salesLineLink.basis": BASIS.SALES_LINE,
    variantId: str(variantId),
    status: { $nin: ["cancelled"] },
  });
}

/* ═══ MEASUREMENT ORDERS ═══════════════════════════════════════════════════ */

/**
 * The production size a person's measurements resolve to under the Settings
 * size configuration for that product, or null when nothing resolves.
 *
 * The one statement of this rule: `resolveMeasurementRequestItems` in the
 * Sales routes uses it too, so the release check and the raw-material view can
 * never disagree about a person's size.
 */
function measuredVariantFor(stockItem, measuredProduct, candidateConfigs = []) {
  for (const cfg of candidateConfigs) {
    const measField = (measuredProduct?.measurements || []).find(
      (m) => m.measurementName?.trim().toLowerCase() === cfg.measurementParameter?.trim().toLowerCase(),
    );
    const val = parseFloat(measField?.value);
    if (measField?.value === undefined || measField.value === "" || Number.isNaN(val)) continue;
    const rule = (cfg.rules || []).find((r) => val >= r.fromValue && val < r.toValue);
    if (!rule) continue;

    let resolved = null;
    if (rule.variantId) {
      resolved = (stockItem?.variants || []).find((v) => str(v._id) === str(rule.variantId)) || null;
    }
    if (!resolved) {
      const normSize = String(rule.sizeValue || "").trim().toLowerCase();
      resolved = (stockItem?.variants || []).find((v) =>
        (v.attributes || []).some((a) => String(a.value || "").trim().toLowerCase() === normSize)) || null;
    }
    if (resolved) return resolved;
  }
  return null;
}

const sizeLabel = (variant) => ((variant?.attributes || []).map((a) => a.value).filter(Boolean).join(" / ")
  || variant?.sku || "unnamed size");

/**
 * Which people make which confirmed line, for a measurement order — or a
 * precise refusal.
 *
 * Membership is the person's CURRENT product assignment on the order's
 * measurement (the record the person-edit route maintains), matched to the
 * line with that product and that size. An assignment with no size takes the
 * product's first size, which is the rule convert-to-po used to build the line.
 *
 * Refused, all conflicts listed at once, nothing written:
 *   - a person whose product/size is on no line, or on two;
 *   - a person whose measured size resolves to a different size than their
 *     line's — Sales must move them to the right line first;
 *   - a line size whose people do not add up to its confirmed quantity.
 *
 * Keyed by the line OBJECT, not its reference: an older line may not have a
 * stored reference yet, and nothing is written before this has passed.
 *
 * @returns {Promise<Map<object, Map<string, object[]>>|null>} line → size
 *   (variant id) → people; null when there are no measurement people to plan.
 */
async function planMeasurementRelease(request) {
  if (!isId(request?.measurementId)) return null;
  const measurement = await Measurement().findById(request.measurementId)
    .select("_id employeeMeasurements").lean();
  if (!measurement || !measurement.employeeMeasurements?.length) return null;

  const productIds = new Set();
  for (const emp of measurement.employeeMeasurements) {
    for (const p of emp.products || []) if (isId(p.productId)) productIds.add(str(p.productId));
  }
  for (const line of request.items || []) if (isId(line.stockItemId)) productIds.add(str(line.stockItemId));

  const ids = [...productIds].map(oid);
  const [stockItems, configs] = await Promise.all([
    ids.length ? StockItem().find({ _id: { $in: ids } }).select("name variants").lean() : [],
    ids.length ? MeasurementSizeConfig().find({ productId: { $in: ids }, isActive: true }).lean() : [],
  ]);
  const stockById = new Map(stockItems.map((s) => [str(s._id), s]));
  const configsByProduct = new Map();
  for (const c of configs) {
    const pid = str(c.productId);
    if (!configsByProduct.has(pid)) configsByProduct.set(pid, []);
    configsByProduct.get(pid).push(c);
  }

  const lines = request.items || [];
  const members = new Map();
  const conflicts = [];
  const who = (emp) => emp.employeeName || emp.employeeUIN || "A person";

  for (const emp of measurement.employeeMeasurements) {
    for (const p of emp.products || []) {
      const pid = str(p.productId);
      if (!pid) continue;
      const si = stockById.get(pid);
      const productName = si?.name || p.productName || "a product";
      const heldVid = str(p.variantId);
      const vid = heldVid && !["null", "undefined"].includes(heldVid) ? heldVid : str(si?.variants?.[0]?._id);

      const matches = lines.filter((l) => str(l.stockItemId) === pid && lineVariantIds(l).includes(vid));
      if (matches.length !== 1) {
        conflicts.push({
          kind: matches.length ? "person_on_several_lines" : "person_on_no_line",
          person: who(emp), employeeUIN: emp.employeeUIN || "", product: productName,
          message: matches.length
            ? `${who(emp)}'s ${productName} matches ${matches.length} lines of this order; Sales must keep one line per product and size.`
            : `${who(emp)}'s ${productName} (${sizeLabel((si?.variants || []).find((v) => str(v._id) === vid))}) is on no line of this order; Sales must add it to the order or remove it from the person.`,
        });
        continue;
      }
      const line = matches[0];

      const measured = measuredVariantFor(si, p, configsByProduct.get(pid) || []);
      if (measured && str(measured._id) !== vid) {
        const lineSize = sizeLabel((si?.variants || []).find((v) => str(v._id) === vid));
        conflicts.push({
          kind: "measured_size_differs",
          person: who(emp), employeeUIN: emp.employeeUIN || "", product: productName,
          lineRef: str(line.lineRef), lineSize, measuredSize: sizeLabel(measured),
          message: `${who(emp)} measures ${sizeLabel(measured)} in ${productName} but is on the ${lineSize} line; Sales must move them to a ${sizeLabel(measured)} line before release.`,
        });
        continue;
      }

      if (!members.has(line)) members.set(line, new Map());
      const bySize = members.get(line);
      if (!bySize.has(vid)) bySize.set(vid, []);
      bySize.get(vid).push({
        employeeId: emp.employeeId, employeeName: emp.employeeName,
        employeeUIN: emp.employeeUIN, gender: emp.gender,
        quantity: Number(p.quantity) || 1,
      });
    }
  }

  for (const line of lines) {
    for (const v of line.variants || []) {
      const people = (members.get(line)?.get(str(v.variantId)) || []).reduce((n, m) => n + m.quantity, 0);
      const confirmed = Number(v.quantity) || 0;
      if (people !== confirmed) {
        const si = stockById.get(str(line.stockItemId));
        const size = sizeLabel((si?.variants || []).find((x) => str(x._id) === str(v.variantId)) || v);
        conflicts.push({
          kind: "line_quantity_differs",
          lineRef: str(line.lineRef), product: line.stockItemName || si?.name || "a product",
          size, confirmedQuantity: confirmed, peopleQuantity: people,
          message: `The ${size} line for ${line.stockItemName || si?.name || "a product"} is confirmed for ${confirmed} but its people add up to ${people}; Sales must correct the line or the people.`,
        });
      }
    }
  }

  if (conflicts.length) {
    throw lineFail(CODES.MEASUREMENT_CONFLICT,
      `This order cannot be released for production: ${conflicts.length} measurement `
      + `${conflicts.length === 1 ? "entry disagrees" : "entries disagree"} with the confirmed order lines. `
      + `${conflicts[0].message}${conflicts.length > 1 ? ` (and ${conflicts.length - 1} more)` : ""}`,
      { conflicts });
  }
  return members;
}

/* ═══ ADD PRODUCT (measurement person edit) ════════════════════════════════ */

/**
 * The exact line a product in a given size belongs to — never the first line
 * that happens to carry the product.
 *
 *   - exactly one line carries this product in this size → that line;
 *   - several do → ambiguous;
 *   - none carries the size but exactly one carries the product → that line
 *     (the size is being added to it);
 *   - otherwise → none, or ambiguous.
 *
 * @returns {{line: object|null, reason: "found"|"none"|"ambiguous"}}
 */
function selectLineForProductVariant(request, productId, variantId) {
  const pid = str(productId);
  const vid = str(variantId);
  const candidates = (request?.items || []).filter((l) => str(l.stockItemId) === pid);
  const withSize = vid ? candidates.filter((l) => lineVariantIds(l).includes(vid)) : [];
  if (withSize.length === 1) return { line: withSize[0], reason: "found" };
  if (withSize.length > 1) return { line: null, reason: "ambiguous" };
  if (candidates.length === 1) return { line: candidates[0], reason: "found" };
  return { line: null, reason: candidates.length ? "ambiguous" : "none" };
}

function requireLineForProductVariant(request, productId, variantId, { label = "this product" } = {}) {
  const { line, reason } = selectLineForProductVariant(request, productId, variantId);
  if (line) return line;
  if (reason === "ambiguous") {
    throw lineFail(CODES.LINE_AMBIGUOUS,
      `A work order cannot be created for ${label}: it appears on several lines of this order and `
      + "nothing stored says which one these units belong to. Reconcile the lines in Sales.");
  }
  throw lineFail(CODES.LINE_NOT_FOUND,
    `A work order cannot be created for ${label}: no line of this order carries it. Add it to the order first.`,
    {}, "VALIDATION");
}

/* ═══ SPLIT ════════════════════════════════════════════════════════════════ */

/**
 * The link a split child carries: the parent's, exactly. An unlinked parent
 * yields `undefined` (no link) — a historical order's absence is inherited as
 * absence. A linked parent in another company than the actor's is refused.
 */
function linkForSplit(parent, { actingCompanyId = null } = {}) {
  const link = parent?.salesLineLink;
  if (!link || !str(link.lineRef)) return undefined;
  if (actingCompanyId && str(link.companyId) !== str(actingCompanyId)) {
    throw lineFail(CODES.COMPANY_MISMATCH,
      "This split work order cannot be created: the original work order belongs to a different company "
      + "from the one you are working in.", {}, "WORK_ORDER_STYLE_COMPANY_MISMATCH");
  }
  return {
    companyId: link.companyId,
    customerRequestId: link.customerRequestId,
    lineRef: str(link.lineRef),
    basis: BASIS.SPLIT_PARENT,
    parentWorkOrderId: parent._id,
    linkedAt: new Date(),
  };
}

/* ═══ RETURN / REMAKE ══════════════════════════════════════════════════════ */

/** A server-minted permanent reference for a return line, known before save. */
const newReturnLineRef = () => mintLineRef();

/**
 * The link a remake WorkOrder carries: its OWN return line, plus where the
 * units came from. `origin.sourceLines` lists the Sales lines of the source
 * WorkOrders that had one; an unlinked source contributes nothing there.
 */
async function linkForReturn({
  companyId, returnCustomerRequestId, returnLineRef, returnRequestId,
  originalCustomerRequestId, sourceWorkOrderIds,
}) {
  if (!isId(companyId)) {
    throw lineFail(CODES.COMPANY_UNPROVEN,
      "This remake cannot be created: the company it belongs to cannot be proved.");
  }
  const ids = [...new Set((sourceWorkOrderIds || []).map(str).filter(isId))];
  const sources = ids.length
    ? await WorkOrder().find({ _id: { $in: ids.map(oid) } }).select("_id salesLineLink").lean()
    : [];
  const sourceLines = [];
  const seen = new Set();
  for (const s of sources) {
    const l = s.salesLineLink;
    if (!l || !str(l.lineRef) || str(l.companyId) !== str(companyId)) continue;
    const key = `${str(l.customerRequestId)}|${str(l.lineRef)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sourceLines.push({ customerRequestId: l.customerRequestId, lineRef: str(l.lineRef) });
  }
  return {
    companyId: oid(companyId),
    customerRequestId: returnCustomerRequestId,
    lineRef: str(returnLineRef),
    basis: BASIS.RETURN_LINE,
    origin: {
      returnRequestId: returnRequestId || null,
      originalCustomerRequestId: originalCustomerRequestId || null,
      sourceWorkOrderIds: ids.map(oid),
      sourceLines,
    },
    linkedAt: new Date(),
  };
}

/* ═══ THE READ CONTRACT ════════════════════════════════════════════════════ */

const MAX_KEYS = 200;

const workOrderView = (wo) => ({
  workOrderId: str(wo._id),
  workOrderNumber: wo.workOrderNumber || null,
  basis: wo.salesLineLink.basis,
  customerRequestId: str(wo.salesLineLink.customerRequestId),
  lineRef: wo.salesLineLink.lineRef,
  variantId: wo.variantId || null,
  quantity: wo.quantity ?? null,
  status: wo.status || null,
  isSplitOrder: !!wo.isSplitOrder,
  parentWorkOrderId: wo.salesLineLink.parentWorkOrderId ? str(wo.salesLineLink.parentWorkOrderId) : null,
  origin: wo.salesLineLink.basis === BASIS.RETURN_LINE && wo.salesLineLink.origin
    ? {
      returnRequestId: wo.salesLineLink.origin.returnRequestId ? str(wo.salesLineLink.origin.returnRequestId) : null,
      originalCustomerRequestId: wo.salesLineLink.origin.originalCustomerRequestId
        ? str(wo.salesLineLink.origin.originalCustomerRequestId) : null,
      sourceWorkOrderIds: (wo.salesLineLink.origin.sourceWorkOrderIds || []).map(str),
      sourceLines: (wo.salesLineLink.origin.sourceLines || [])
        .map((l) => ({ customerRequestId: str(l.customerRequestId), lineRef: l.lineRef })),
    }
    : null,
});

const LINK_SELECT = "_id workOrderNumber salesLineLink variantId quantity status isSplitOrder";

/**
 * Line → WorkOrders, within ONE company.
 *
 * Every requested line answers: `linked` with its WorkOrders (direct Sales
 * WorkOrders, splits of them, and return WorkOrders whose origin names the
 * line), or `unlinked` with none. A line of another company, an unknown line,
 * and a line whose only WorkOrders are historical and unprovable all read
 * identically as `unlinked` — nothing about another company is disclosed.
 *
 * @param {string} companyId  the server-resolved acting company
 * @param {string[]} lineRefs
 */
async function workOrdersForLines(companyId, lineRefs) {
  if (!isId(companyId)) throw lineFail(CODES.COMPANY_UNPROVEN, "No company is in scope.", {}, "TENANT_MEMBERSHIP_UNPROVEN");
  const refs = [...new Set((lineRefs || []).map(str).filter(Boolean))];
  if (!refs.length) throw fail("VALIDATION", "Name at least one Sales line reference.");
  if (refs.length > MAX_KEYS) throw fail("VALIDATION", `At most ${MAX_KEYS} line references per request.`);

  const company = oid(companyId);
  const [direct, returns] = await Promise.all([
    WorkOrder().find({ "salesLineLink.companyId": company, "salesLineLink.lineRef": { $in: refs } })
      .select(LINK_SELECT).sort({ createdAt: 1, _id: 1 }).lean(),
    WorkOrder().find({ "salesLineLink.companyId": company, "salesLineLink.origin.sourceLines.lineRef": { $in: refs } })
      .select(LINK_SELECT).sort({ createdAt: 1, _id: 1 }).lean(),
  ]);

  return refs.map((lineRef) => {
    const own = direct.filter((w) => w.salesLineLink.lineRef === lineRef);
    const remakes = returns.filter((w) => (w.salesLineLink.origin?.sourceLines || []).some((l) => l.lineRef === lineRef));
    if (!own.length && !remakes.length) {
      return { lineRef, state: LINK_STATE.UNLINKED, customerRequestId: null, workOrders: [], returnWorkOrders: [] };
    }
    return {
      lineRef,
      state: LINK_STATE.LINKED,
      customerRequestId: own[0] ? str(own[0].salesLineLink.customerRequestId) : null,
      workOrders: own.map(workOrderView),
      returnWorkOrders: remakes.map(workOrderView),
    };
  });
}

/**
 * WorkOrder → line, within ONE company. For joining Cutting / Embroidery /
 * scan evidence (which names WorkOrders) back to the Sales line. A historical
 * WorkOrder, one of another company, and an unknown id all read `unlinked`.
 */
async function linesForWorkOrders(companyId, workOrderIds) {
  if (!isId(companyId)) throw lineFail(CODES.COMPANY_UNPROVEN, "No company is in scope.", {}, "TENANT_MEMBERSHIP_UNPROVEN");
  const ids = [...new Set((workOrderIds || []).map(str).filter(Boolean))];
  if (!ids.length) throw fail("VALIDATION", "Name at least one work order.");
  if (ids.length > MAX_KEYS) throw fail("VALIDATION", `At most ${MAX_KEYS} work orders per request.`);
  const valid = ids.filter(isId);

  const rows = valid.length
    ? await WorkOrder().find({ _id: { $in: valid.map(oid) }, "salesLineLink.companyId": oid(companyId) })
      .select(LINK_SELECT).lean()
    : [];
  const byId = new Map(rows.map((w) => [str(w._id), w]));
  return ids.map((id) => {
    const wo = byId.get(id);
    return wo
      ? { workOrderId: id, state: LINK_STATE.LINKED, ...workOrderView(wo) }
      : { workOrderId: id, state: LINK_STATE.UNLINKED };
  });
}

module.exports = {
  LINK_STATE, BASIS, CODES, MAX_KEYS,
  ensureStoredLineRefs, proveReleaseLines, existingReleaseWorkOrder,
  measuredVariantFor, planMeasurementRelease,
  selectLineForProductVariant, requireLineForProductVariant,
  linkForSplit, newReturnLineRef, linkForReturn,
  workOrdersForLines, linesForWorkOrders,
  sendError,
};
