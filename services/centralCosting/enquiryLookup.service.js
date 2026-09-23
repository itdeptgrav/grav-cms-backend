"use strict";
/**
 * services/centralCosting/enquiryLookup.service.js
 *
 * Central Costing — WHICH ENQUIRY PRODUCTS CAN BE COSTED.
 *
 * ── THE PROBLEM THIS REPLACES ───────────────────────────────────────────────
 * Starting an enquiry costing required typing a raw Mongo `_id` and then the
 * product name EXACTLY as the enquiry spells it. Two things follow from that,
 * and both are bad. The obvious one is that nobody can do it: a merchandiser
 * has an enquiry number, not an ObjectId. The quieter one is that it made the
 * BROWSER responsible for naming a record correctly — and a client that
 * constructs an external key by hand is a client that can name a record it was
 * never shown.
 *
 * So the identifiers come from here. The picker renders what a person
 * recognises — enquiry number, customer, product, quantity — and hands back
 * the ids the server itself produced. The browser types nothing that matters.
 *
 * ── AND IT IS A LOOKUP, NOT A GRANT ─────────────────────────────────────────
 * Everything is scoped to the caller's own company by the same clause the
 * costing context resolver uses, so this cannot widen what anybody can reach.
 * A foreign enquiry is not "unavailable" — it is absent, exactly as it is
 * everywhere else in this domain.
 */

const mongoose = require("mongoose");

const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const contextResolver = require("./contextResolver.service");

const MAX = 40;

/** A regex-safe fragment, so a customer called "C++ Apparel" is searchable. */
const safe = (term) => String(term || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The company clause, borrowed rather than restated.
 *
 * `contextResolver` already owns what "this company's enquiry" means, including
 * the documented single-company allowance for records that predate ownership.
 * Writing a second version here is how a lookup ends up slightly more generous
 * than the create it feeds.
 */
async function enquiryClause(ctx) {
  const scoped = await contextResolver.enquiryIsCompanyScoped(ctx);
  if (!scoped) return {};
  const allowUnowned = await contextResolver.isSoleCompanyDeployment(ctx);
  return {
    $or: [
      { companyId: ctx.companyId },
      ...(allowUnowned ? [{ companyId: null }, { companyId: { $exists: false } }] : []),
    ],
  };
}

/**
 * Enquiry products this company could raise a costing against.
 *
 * One row per PRODUCT, not per enquiry: an enquiry for three garments is three
 * costings, and collapsing them to one row would make the person pick an
 * enquiry and then be asked for a product they had no way to see.
 */
async function eligibleProducts(ctx, { search = "", limit = 25 } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 25, 1), MAX);
  const clause = await enquiryClause(ctx);
  const term = safe(search);
  const rx = term ? new RegExp(term, "i") : null;

  /* ── THE COMPANY CLAUSE IS VISIBLE IN THE QUERY ────────────────────────
     Spreading it into the filter object scoped the read correctly and read as
     an unscoped `Enquiry.find(filter)` to anybody scanning the file — which
     the tenancy guard is, and which is the point of the guard. `$and` with the
     clause first says so at the call site. */
  const selector = {
    isActive: true,
    /* An enquiry with no products has nothing to cost. It is not an error and
       it is not shown — the person is choosing a product, and a row that
       cannot be chosen is noise. */
    "products.0": { $exists: true },
    ...(rx
      ? {
        $and: [{
          $or: [
            { enquiryId: rx }, { title: rx }, { "products.product": rx },
            { "products.colour": rx }, { "products.sizeRange": rx },
          ],
        }],
      }
      : {}),
  };

  const enquiries = await Enquiry.find({ $and: [clause, selector] })
    .select("enquiryId title accountId products requirementDeadline expectedClosingDate createdAt companyId")
    /* Newest first: the enquiry somebody is costing is almost always one they
       just took, and paging past six months of history to reach it is the
       kind of friction that sends people back to typing ids. */
    .sort({ createdAt: -1 })
    .limit(cap)
    .lean();
  if (!enquiries.length) return { products: [], capped: false };

  /* ── THE CUSTOMER'S NAME, THROUGH THE SCOPED ACCOUNT BOUNDARY ──────────
     The frozen context snapshot deliberately records the account ID rather
     than the name, because resolving it used to mean an UNSCOPED Sales read.
     Accounts carry their company now (Chunk 3B1), so a scoped read is
     legitimate — and a picker that showed "5f3a…" where the customer belongs
     would be the same unusable screen in a new place. An account that does
     not resolve is left blank, never guessed. */
  const accountIds = [...new Set(enquiries.map((e) => String(e.accountId || "")).filter(Boolean))];
  /* The same clause the enquiries were read under — re-deriving it was a
     second call that could, in principle, answer differently. */
  const accounts = accountIds.length
    ? await Account.find({ $and: [clause, { _id: { $in: accountIds.map((id) => new mongoose.Types.ObjectId(id)) } }] })
      .select("companyName accountId").lean()
    : [];
  const nameOf = new Map(accounts.map((a) => [String(a._id), a]));

  /* Which of these products already have a live costing, so the picker can
     send somebody to the existing one instead of creating a second. */
  const existing = await Costing.find({
    companyId: ctx.companyId,
    isArchived: false,
    "context.type": "ENQUIRY_STYLE",
    "context.primaryId": { $in: enquiries.map((e) => e._id) },
  }).select("context status currentVersionNumber").lean();
  const costingFor = new Map(existing.map((c) => [
    `${String(c.context?.primaryId)}::${String(c.context?.externalKey || "")}`, c,
  ]));

  const products = [];
  for (const e of enquiries) {
    const account = nameOf.get(String(e.accountId || "")) || null;
    for (const p of e.products || []) {
      const name = String(p.product || "").trim();
      if (!name) continue;
      /* With a search term, match the PRODUCT rows too — an enquiry matched
         on its number should show all its products, but one matched on a
         product name should not drag in its siblings. */
      if (rx && !rx.test(name) && !rx.test(e.enquiryId || "") && !rx.test(e.title || "")
        && !rx.test(p.colour || "") && !rx.test(p.sizeRange || "")) continue;

      const hit = costingFor.get(`${String(e._id)}::${name}`) || null;
      products.push({
        /* ── THE SERVER-OWNED IDENTIFIERS ────────────────────────────────
           Exactly what `POST /api/costings` expects as its context. The
           browser echoes these back and constructs neither. */
        context: { type: "ENQUIRY_STYLE", primaryId: String(e._id), externalKey: name },
        /* ── AND WHAT A PERSON RECOGNISES ───────────────────────────────── */
        enquiryNumber: e.enquiryId || "",
        enquiryTitle: e.title || "",
        customerName: account?.companyName || "",
        customerReference: account?.accountId || "",
        product: name,
        /* The nearest thing an enquiry product has to a variant. Absent stays
           absent — a blank chip is better than an invented one. */
        variant: [p.colour, p.sizeRange].filter(Boolean).join(" · ") || null,
        quantity: Number.isFinite(Number(p.quantity)) && Number(p.quantity) > 0 ? Number(p.quantity) : null,
        requiredBy: e.requirementDeadline || e.expectedClosingDate || null,
        enquiredAt: e.createdAt || null,
        /* Present means "this is already being costed" — the picker offers to
           open it rather than starting a second one for the same work. */
        existingCosting: hit
          ? {
            id: String(hit._id),
            status: hit.status,
            currentVersionNumber: hit.currentVersionNumber ?? null,
          }
          : null,
      });
    }
  }

  return { products: products.slice(0, MAX), capped: products.length > MAX };
}

/**
 * The business subject of a set of costings, for the work queue.
 *
 * ── WHY THE QUEUE NEEDS MORE THAN THE FROZEN LABEL ──────────────────────────
 * `contextSnapshot.label` is "Oxford Shirt — ENQ-441", frozen deliberately so a
 * costing from March still reads as it did in March. That is right for the
 * record and wrong for a queue: somebody deciding what to cost next needs the
 * customer, the quantity and the date it is wanted by, and none of those is in
 * the snapshot — the snapshot records the accountId rather than the name for
 * ownership reasons that no longer apply now Accounts carry their company.
 *
 * So this is a LIVE read alongside the frozen one, clearly separate. It never
 * replaces the snapshot and never reaches a version: it is what the row says
 * today, so the queue is about today's work.
 *
 * Carries no cost, no price and no margin — a list is a place to choose a
 * record, and putting money on it would mean gating every row.
 */
async function subjectsFor(ctx, costings = []) {
  const wanted = costings.filter((c) => c.context?.type === "ENQUIRY_STYLE" && c.context?.primaryId);
  if (!wanted.length) return new Map();

  const ids = [...new Set(wanted.map((c) => String(c.context.primaryId)))]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return new Map();

  const clause = await enquiryClause(ctx);
  const enquiries = await Enquiry.find({ $and: [clause, { _id: { $in: ids } }] })
    .select("enquiryId title accountId products requirementDeadline expectedClosingDate")
    .lean();
  const byId = new Map(enquiries.map((e) => [String(e._id), e]));

  const accountIds = [...new Set(enquiries.map((e) => String(e.accountId || "")).filter(Boolean))];
  const accounts = accountIds.length
    ? await Account.find({ $and: [clause, { _id: { $in: accountIds.map((id) => new mongoose.Types.ObjectId(id)) } }] })
      .select("companyName").lean()
    : [];
  const nameOf = new Map(accounts.map((a) => [String(a._id), a.companyName || ""]));

  const out = new Map();
  for (const c of wanted) {
    const e = byId.get(String(c.context.primaryId));
    /* An enquiry that no longer resolves — deleted, or moved out of this
       company — leaves the row with its frozen label and nothing invented. */
    if (!e) continue;
    const product = (e.products || []).find(
      (p) => String(p.product || "").trim() === String(c.context.externalKey || ""),
    ) || null;
    out.set(String(c._id), {
      enquiryNumber: e.enquiryId || "",
      enquiryTitle: e.title || "",
      customerName: nameOf.get(String(e.accountId || "")) || "",
      product: c.context.externalKey || "",
      variant: product ? ([product.colour, product.sizeRange].filter(Boolean).join(" · ") || null) : null,
      quantity: product && Number.isFinite(Number(product.quantity)) && Number(product.quantity) > 0
        ? Number(product.quantity) : null,
      requiredBy: e.requirementDeadline || e.expectedClosingDate || null,
    });
  }
  return out;
}

module.exports = { eligibleProducts, enquiryClause, subjectsFor, MAX };
