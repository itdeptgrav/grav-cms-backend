// services/sales/requestLineStyles.js
//
// WHICH APPROVED STYLE A CUSTOMER-REQUEST LINE IS MAKING.
//
// A work order must name the exact style its line was approved against
// (`services/industrialEngineering/workOrderStyleLink.service.js`), and the
// release refuses a line that names none: "the customer-request line for X
// names no approved style". The Sales order form raises its lines from the
// PRODUCT the customer approved, not from a style, and nothing filled
// `items[].sampleStyleId` — so every order raised that way was refused at
// "proceed to Production" (7 Oct 2026, owner's report on REQ-2026-0040).
//
// This resolves the style FROM THE PRODUCT, by the two stored links a style
// keeps to its registered product: `production.stockItemId` (the product R&D
// registered for it) and `sourceStockItemId` (an existing product it was
// raised from). Only a style whose sampling is SETTLED counts — approved, or
// waived because the product was made before — and among several the one the
// customer approved, then the newest, wins. It is stored on the line when the
// request is created and filled in at release for lines that still carry
// none, so an order raised before this fix can proceed too. A product with no
// settled style stays unlinked and the release's own refusal stands: nothing
// here guesses.
"use strict";

const mongoose = require("mongoose");
const { SETTLED_SAMPLE_STATUSES } = require("../sampleReadiness");

const model = (name, path) => (mongoose.models[name] || require(path));
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");
const Account = () => model("Account", "../../models/CMS_Models/Sales/Account");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

/**
 * The settled styles that make each of these products, keyed by product id.
 * @returns {Promise<Map<string, object[]>>}
 */
async function settledStylesFor(stockItemIds) {
  const ids = [...new Set((stockItemIds || []).map(str).filter(isId))].map(oid);
  if (!ids.length) return new Map();
  const styles = await SampleStyle().find({
    isActive: true,
    "sample.status": { $in: SETTLED_SAMPLE_STATUSES },
    $or: [{ "production.stockItemId": { $in: ids } }, { sourceStockItemId: { $in: ids } }],
  }).select("_id accountId productName sampleType customerApproval.approved sample.status production.stockItemId sourceStockItemId updatedAt createdAt").lean();
  const out = new Map();
  for (const s of styles) {
    for (const k of [str(s.production?.stockItemId), str(s.sourceStockItemId)]) {
      if (!k) continue;
      if (!out.has(k)) out.set(k, []);
      if (!out.get(k).some((x) => str(x._id) === str(s._id))) out.get(k).push(s);
    }
  }
  return out;
}

/** The account this portal customer belongs to, if an account links to them. */
async function accountIdForCustomer(customerId) {
  if (!isId(customerId)) return null;
  const acc = await Account().findOne({ linkedCustomer: oid(customerId) }).select("_id").lean();
  return acc ? str(acc._id) : null;
}

/**
 * Pick ONE style for a product from its settled candidates.
 * Customer-approved first, then the customer's own account, then the newest.
 */
function pickStyle(candidates, { accountId = null } = {}) {
  const list = Array.isArray(candidates) ? [...candidates] : [];
  if (!list.length) return null;
  const score = (s) => (s.customerApproval?.approved === true ? 4 : 0)
    + (accountId && str(s.accountId) === str(accountId) ? 2 : 0)
    + (s.sample?.status === "approved" ? 1 : 0);
  list.sort((a, b) => (score(b) - score(a)) || (new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)));
  return list[0];
}

/**
 * The style id for one product, or null when none is settled.
 * @param {string} stockItemId
 * @param {{customerId?: string, accountId?: string}} [ctx]
 */
async function resolveStyleForStockItem(stockItemId, ctx = {}) {
  const byProduct = await settledStylesFor([stockItemId]);
  const accountId = ctx.accountId || (await accountIdForCustomer(ctx.customerId));
  const pick = pickStyle(byProduct.get(str(stockItemId)), { accountId });
  return pick ? pick._id : null;
}

/**
 * Fill `items[].sampleStyleId` on a request wherever it is missing. Mutates
 * the request's items in place (a Mongoose document or a plain object) and
 * returns what was linked, so the caller can log it.
 * @returns {Promise<Array<{stockItemId:string, sampleStyleId:string, productName:string}>>}
 */
async function linkMissingLineStyles(request, ctx = {}) {
  const items = Array.isArray(request?.items) ? request.items : [];
  const missing = items.filter((i) => !i.sampleStyleId && i.stockItemId);
  if (!missing.length) return [];
  const byProduct = await settledStylesFor(missing.map((i) => i.stockItemId?._id || i.stockItemId));
  const accountId = ctx.accountId || (await accountIdForCustomer(ctx.customerId || request?.customerId));
  const linked = [];
  for (const line of missing) {
    const pid = str(line.stockItemId?._id || line.stockItemId);
    const pick = pickStyle(byProduct.get(pid), { accountId });
    if (!pick) continue;
    line.sampleStyleId = pick._id;
    linked.push({ stockItemId: pid, sampleStyleId: str(pick._id), productName: str(pick.productName) });
  }
  return linked;
}

module.exports = { settledStylesFor, pickStyle, resolveStyleForStockItem, linkMissingLineStyles, accountIdForCustomer };
