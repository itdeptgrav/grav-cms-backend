// services/studio/sampleStudioQueries.js
//
// Finding styles for GRAV Studio — always inside one company. The CMS routes
// pass the signed-in actor's company (salesScope.scopeFor); GRAV Studio's API
// passes the company its key was issued in. A style is the company's when it
// is stamped with it, or, unstamped, when ownershipProofFor finds it through
// its journey or enquiry (the rule every write on a style already uses).

"use strict";

const mongoose = require("mongoose");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Account = require("../../models/CMS_Models/Sales/Account");
const { ownershipProofFor } = require("../centralCosting/technicalSource.service");

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const isObjectId = (v) => mongoose.isValidObjectId(v) && String(new mongoose.Types.ObjectId(v)) === String(v);

/** The company's own styles among `docs`, in order. */
async function ownedOnly(docs, companyId) {
  if (!companyId) return [];
  const out = [];
  for (const d of docs) {
    if (d.companyId) {
      if (String(d.companyId) === String(companyId)) out.push(d);
    } else if (await ownershipProofFor(d, companyId)) {
      out.push(d);
    }
  }
  return out;
}

/** One style of the company, by _id or sampleStyleId — or 404, the same as a missing one. */
async function loadStyle(idOrRef, companyId, { lean = false } = {}) {
  const ref = String(idOrRef || "").trim();
  if (!ref) throw fail(404, "Style not found.");
  const q = isObjectId(ref) ? { $or: [{ _id: ref }, { sampleStyleId: ref }] } : { sampleStyleId: ref };
  let find = SampleStyle.findOne({ ...q, isActive: true });
  if (lean) find = find.lean();
  const style = await find;
  if (!style || !(await ownedOnly([style], companyId)).length) throw fail(404, "Style not found.");
  return style;
}

/**
 * Styles for a view:
 *   "design" — every active style with Design (R&D): the designer's cards;
 *   "review" — every style with a Studio version sent: the review list (Sales).
 */
async function listStyles(view, companyId, { limit = 300 } = {}) {
  const q = { isActive: true };
  if (view === "review") q["studio.versions.0"] = { $exists: true };
  else {
    q.stage = "rnd";
    q.status = "active";
  }
  const docs = await SampleStyle.find(q)
    // What a card shows, and what ownershipProofFor reads — nothing else.
    .select("sampleStyleId styleCode productName sampleType accountId journeyId enquiryId companyId stage status isActive brief sample.dueDate techSheet.dueDate studio updatedAt")
    .sort({ updatedAt: -1 })
    .limit(Math.min(Number(limit) || 300, 1000))
    .lean();
  return ownedOnly(docs, companyId);
}

/** Customer names for styles, batched (house samples have none). */
async function customerNames(styles, companyId) {
  const ids = [...new Set(styles.map((s) => s.accountId).filter(Boolean).map(String))].filter(isObjectId);
  const accounts = ids.length
    ? await Account.find({ _id: { $in: ids }, $or: [{ companyId }, { companyId: null }, { companyId: { $exists: false } }] })
      .select("companyName displayName")
      .lean()
    : [];
  const byId = new Map(accounts.map((a) => [String(a._id), a.displayName || a.companyName || ""]));
  return (style) => (style.sampleType === "house" ? "In-house sample" : byId.get(String(style.accountId)) || "");
}

module.exports = { loadStyle, listStyles, customerNames, ownedOnly };
