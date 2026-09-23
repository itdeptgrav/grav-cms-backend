// routes/CMS_Routes/Sales/enquiries.js
//
// Enquiry / RFQ — the FIRST real writer for a post-Account lifecycle stage.
//
// SCOPE (Chunk 1): get-or-create the one Enquiry that belongs to a Journey, and
// edit its header (dates, source, status, title, summary). Products, indicative
// pricing and qualification are additive fields landing in later chunks; this
// file grows with them.
//
// The enquiry is created LAZILY on first GET — the moment a salesperson opens
// the Enquiry stage of a journey, its ENQ reference is minted and the record is
// seeded from what we already know (the Account is the customer, its primary
// contact is the contact, the Journey owner is the salesperson, and the
// converting Lead — found via lead.conversion.journeyId — supplies the source).
// Nothing is invented; empty fields stay empty for the user to fill.

"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");
const Enquiry = require("../../../models/CMS_Models/Sales/Enquiry");
const { reconcileProductLineIdentities } = require("../../../models/CMS_Models/Sales/enquiryProductLineIdentity");
const SalesJourney = require("../../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../../models/CMS_Models/Sales/Account");
/* Structured payment terms — the duration half of financing, which the
   company rate has never had. Sales agrees them; Costing reads them. */
const paymentTermsResolution = require("../../../services/sales/paymentTermsResolution.service");
/* What Sales asks Central Costing to price. Read by the costing engine,
   written only here. */
const costingBrief = require("../../../services/sales/costingBrief.service");
const commercialLine = require("../../../services/sales/commercialLine.service");
const preparation = require("../../../services/sales/costingPreparation.service");
/* Sales asks for an estimate; this resolves every source and decides whether
   a version is even needed. Central Costing stays an engine. */
const costingPreparation = require("../../../services/sales/costingPreparation.service");
const costingResult = require("../../../services/sales/costingResult.service");
const { fail: costingFail } = require("../../../services/storePurchase/errors");
const { CAPABILITIES } = require("../../../services/centralCosting/capabilities");
const commercialReview = require("../../../services/sales/commercialReview.service");
const proformaRequest = require("../../../services/sales/proformaRequest.service");
const lineReadiness = require("../../../services/sales/lineReadiness.service");
const Customer = require("../../../models/Customer_Models/Customer");
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const Lead = require("../../../models/CMS_Models/Sales/Lead");
const Employee = require("../../../models/Employee");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { ownershipFieldsFor } = require("../../../services/companyContext/ownershipStamp.service");
const { createWithRef } = require("../../../services/enquiryRef");
const NotificationService = require("../../../services/NotificationService");
const { notifyEvent, APP_URL: DEPT_NOTIFY_APP_URL } = require("../../../services/departmentNotify.service");
const { recordChange, historyFor, diff } = require("../../../services/changeLog");
const { isSalesManager, bypassesApproval } = require("../../../services/salesAccess");
const CRMSettings = require("../../../models/CMS_Models/Sales/CRMSettings");
const { canSeeCost, costingTier, visibleParts, reduceCostLedger } = require("../../../services/crmCostVisibility");
const { costingTotals } = require("../../../services/costingTotals");
const SampleStyle = require("../../../models/CMS_Models/Sales/SampleStyle");
const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
const CustomerEmailService = require("../../../services/CustomerEmailService");

// Same three roles CoWork's own documents used — kept as the vocabulary for
// "who can see/edit this sheet" now that the sheet itself is native.
const SHARE_ROLES = new Set(["owner", "editor", "viewer"]);

// For the department-notification emails below — user-entered names/refs land
// straight in an HTML email, so they're escaped the same way every other
// HTML-building email sender in this backend does.
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// So every notification email below can say WHICH customer this is, not just
// which enquiry — a bare enquiry reference means nothing to someone on
// another department's dashboard who has never opened this record.
async function customerNameFor(enquiry, req) {
  if (!enquiry?.accountId) return "—";
  const acc = await Account.findOne(await scopedForEnquiry(enquiry, req, { _id: enquiry.accountId }))
    .select("displayName companyName").lean();
  return acc?.displayName || acc?.companyName || "—";
}

/**
 * SCOPE AN ENQUIRY'S OWN LOOKUP, WITH OR WITHOUT A SESSION.
 *
 * ── THE PUBLIC-ROUTE DEFECT THIS CLOSES ─────────────────────────────────────
 * `customerNameFor` used `scoped(req, …)` unconditionally, and `salesScope`
 * begins `if (!req.user?.id) throw UNAUTHENTICATED`. The customer-approval link
 * is deliberately session-less — a customer follows it from an email and has no
 * account — so every decision recorded through it threw 401 before anything was
 * written. The route was unusable in production, not merely untestable.
 *
 * ── AND WHY THE TOKEN IS A SUFFICIENT SCOPE ─────────────────────────────────
 * By the time this is called the opaque token has already been matched against
 * a single enquiry, and that enquiry carries the company it belongs to. So the
 * scope is not absent — it is narrower than a session's: exactly one company,
 * named by the record the token authorised, rather than every company the
 * caller is a member of.
 *
 * ── WHAT IS NOT WEAKENED ────────────────────────────────────────────────────
 * Nothing on an authenticated path. Where `req.user` exists this defers to
 * `scoped` unchanged, so a signed-in caller is still held to their own
 * memberships and a foreign enquiry is still simply not found. The token branch
 * is reachable only for a request that has no session at all, and it pins the
 * company to the enquiry rather than trusting anything the caller sent.
 */
async function scopedForEnquiry(enquiry, req, selector = {}) {
  if (req?.user?.id) return scoped(req, selector);
  /* The company comes from the enquiry the opaque token resolved to, never
     from the request. An enquiry with no company is not silently widened: the
     selector alone would match across tenants, so it is refused.

     This is a SCOPING HELPER, not an exemption — every path through it returns
     a filter carrying a company, or throws. It is named in the tenancy guard's
     own list of such helpers rather than carrying a reviewed-query marker,
     because there is no unscoped query here to review. */
  const companyId = enquiry?.companyId || null;
  if (!companyId) {
    const err = new Error("This enquiry has no company, so it cannot be read without a session.");
    err.status = 409;
    throw err;
  }
  return { ...selector, companyId };
}

// The account's own contact email — for the per-product costing approval
// email (24 Aug 2026). Falls back to nothing rather than guessing; the
// send-to-customer route refuses to fire without a real address.
async function customerEmailFor(enquiry, req) {
  if (!enquiry?.accountId) return null;
  const acc = await Account.findOne(await scoped(req, { _id: enquiry.accountId })).select("primaryEmail").lean();
  return acc?.primaryEmail || null;
}

// ── Per-product customer approval token (24 Aug 2026) ───────────────────────
// Same shape as Cowork's external-share tokens (services/shareInvite.service
// .js) — a random value whose SHA-256 hash alone is ever stored, so a
// database leak yields no usable link — Mongo-backed here since costingLifecycle
// already lives on this document. 7-day lifetime, single-use: the hash is
// cleared the moment a decision is recorded through it (see the decide route).
const COSTING_APPROVAL_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
function hashApprovalToken(plain) {
  return crypto.createHash("sha256").update(String(plain)).digest("hex");
}

// Resolve a plaintext token back to the enquiry + the ONE costingLifecycle
// entry it belongs to. Returns null on anything not live: unknown, expired,
// or already redeemed (hash cleared on decide).
//
// ── DELIBERATELY NOT COMPANY-SCOPED, AND REVIEWED AS SUCH (Chunk 3A) ────────
// Every other Enquiry lookup in this file now carries the caller's company.
// This one cannot and must not: it runs on a PUBLIC route for a customer who
// has no CMS session, so there is no actor to scope by, and inventing one
// would mean picking a company from the record being requested — the exact
// circularity the tenant rules refuse.
//
// What authorises it is the token itself. The lookup is keyed on a SHA-256 of
// an unguessable secret, so it is not an enumeration path: there is no id to
// walk, a wrong guess returns null, and the same null answers unknown, expired
// and already-redeemed alike. The token is single-use — the hash is cleared on
// decision — and time-bounded by COSTING_APPROVAL_TOKEN_LIFETIME_MS.
//
// The caller is a customer acting on ONE costing entry they were sent, not a
// user browsing enquiries, and the route must keep it that way.
async function resolveCostingApprovalToken(token) {
  const hash = hashApprovalToken(token);
  /* tenancy-guard:reviewed-public-token — authorised by the opaque token
     itself, not by a company; see the block comment above. The marker exempts
     THIS query only, and the guard scans the rest of this file normally. */
  const enquiry = await Enquiry.findOne({ "costingLifecycle.customerApprovalTokenHash": hash, isActive: true });
  if (!enquiry) return null;
  const entry = (enquiry.costingLifecycle || []).find((c) => c.customerApprovalTokenHash === hash);
  if (!entry) return null;
  if (!entry.customerApprovalTokenExpiresAt || entry.customerApprovalTokenExpiresAt < new Date()) return null;
  return { enquiry, entry };
}

/* ── REMOVED: THE CUSTOMER-APPROVAL PRICE NO LONGER TOUCHES THE ITEM MASTER ──
 *
 * This used to write the approved price onto `baseSalesPrice` and onto EVERY
 * variant of the linked stock item. Three things were wrong with it, and the
 * third was reaching the customer:
 *
 *   1. It found the price with `costLedger.find(l => l.productName === ...)`.
 *      Ledger rows carry a name even when they are keyed by the permanent
 *      pair, so an enquiry with the same garment in two colourways has two
 *      rows with one name and `.find` took the first — Navy's price could be
 *      written for Sand.
 *   2. It then fanned that single figure across every variant, so one
 *      colourway's approval overwrote the prices of all the others.
 *   3. `proformaRequest` read `variant.salesPrice || baseSalesPrice` back out
 *      as the PI price. A price approved for 500 therefore invoiced a line
 *      confirmed at 750, and nothing compared it to the floor.
 *
 * The item master is a catalogue, not a record of what one customer agreed.
 * What a customer approved lives on the enquiry's own commercial record, keyed
 * by `productLineRef + sampleStyleId`, and the PI resolves its price from the
 * approved costing version — see `services/sales/proformaRequest.service.js`.
 *
 * (Its catch also called `answeredTenantRefusal(res, err)` with no `res` in
 * scope, so any save failure raised a ReferenceError out of the handler and
 * failed the customer's approval. Removing the function removes that too.)
 */

// The margin policy. Hardcoded for now and deliberately server-side: the floor
// price is computed here and only the RESULT is sent, so cost never has to be
// on the wire for a salesperson to know what they may not go below. When the
// rate card lands this becomes a per-style-family setting.
/**
 * The markup policy, from Sales settings, cached briefly.
 *
 * It was `const MARGIN_FLOOR_PERCENT = 22` here — the THIRD hardcoded copy of
 * the same number (the other two were in the frontend and in costingTotals'
 * default). One of them is now the truth: CRMSettings.commercial.markupPct.
 * Cached for a minute because every costing read asks for it and it changes
 * about never.
 */
let _markupCache = { at: 0, pct: 22 };
async function markupPercent() {
  if (Date.now() - _markupCache.at < 60_000) return _markupCache.pct;
  try {
    const settings = await CRMSettings.getSingleton();
    const pct = Number(settings?.commercial?.markupPct);
    _markupCache = { at: Date.now(), pct: Number.isFinite(pct) ? pct : 22 };
  } catch {
    // Keep the last known figure rather than silently repricing everything at
    // a default because one settings read failed.
    _markupCache = { ..._markupCache, at: Date.now() };
  }
  return _markupCache.pct;
}

/* Costing visibility — see services/crmCostVisibility.js for the rules and
   why they live outside this file (it cannot be required without Firebase). */

const { ENQUIRY_STATUS_CODES, ENQUIRY_STATUS_TRANSITIONS, ENQUIRY_SOURCE_CODES, ENQUIRY_LOST_REASON_CODES, ENQUIRY_PRIORITY_CODES, CUSTOMER_SERIOUSNESS_CODES, ENQUIRY_REFERENCE_TYPE_CODES, FREIGHT_ARRANGEMENT_CODES } = require("../../../constants/crm");
/* The two registers a delivery term points at. Both are read company-scoped
   where they are used: an address on somebody else's account and a warehouse
   in another company must be indistinguishable from ones that do not exist. */
const {
  resolveShippingDestination, shippingAddressesFor, REASON: SHIPPING_REASON,
} = require("../../../services/centralCosting/shippingDestination.service");
const Warehouse = require("../../../models/CMS_Models/Inventory/Configurations/Warehouse");

const express = require("express");
const router = express.Router();

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

// Map a Lead's `source` (how a prospect was found) onto an Enquiry source (how
// this enquiry came in). Most conversions are "converted lead"; a few carry
// through cleanly.
function enquirySourceFromLead(lead) {
  if (!lead) return undefined;
  const s = lead.source;
  if (s === "referral") return "referral";
  if (s === "trade_show") return "exhibition";
  if (s === "website") return "website";
  if (s === "existing_customer") return "repeat_customer";
  return "existing_lead";
}

/**
 * The Lead's commercial picture, frozen at conversion.
 *
 * Every figure keeps its confidence and its stated source, because "4,800 pcs,
 * contact-confirmed, from the GM's expansion plan" and "4,800 pcs, assumed"
 * are different facts and only one of them should survive a challenge.
 *
 * Returns undefined when the lead had nothing, so an enquiry raised without a
 * lead carries an absent block rather than an empty one full of nulls.
 */
function leadEstimateSnapshot(lead) {
  if (!lead) return undefined;
  const snap = {
    annualQuantity: lead.estimatedAnnualQuantity ?? undefined,
    annualQuantityConfidence: lead.estimatedAnnualQuantityConfidence || undefined,
    annualQuantitySource: lead.estimatedAnnualQuantitySource || undefined,
    annualRevenue: lead.estimatedAnnualRevenue ?? undefined,
    annualRevenueConfidence: lead.estimatedAnnualRevenueConfidence || undefined,
    annualRevenueSource: lead.estimatedAnnualRevenueSource || undefined,
    unitPrice: lead.estimatedUnitPrice ?? undefined,
    unitPriceConfidence: lead.estimatedUnitPriceConfidence || undefined,
    unitPriceSource: lead.estimatedUnitPriceSource || undefined,
  };
  if (Object.values(snap).every((v) => v === undefined)) return undefined;
  snap.capturedAt = new Date();
  snap.capturedFromLeadRef = lead.leadId || undefined;
  return snap;
}

// The lead's requirement, as ONE readable line for the enquiry's summary.
//
// It used to be seeded straight into `enquiry.products[]` (26 Aug 2026,
// explicit request to stop: "the product requirement form which is asking in
// the lead shouldn't be auto create as an enquiry product in the pipeline
// section... that just need to ask for a record"). What a lead captured is a
// stated interest — a name and a rough quantity, typed before anyone knew
// whether it maps to a registered product. A pipeline product row is a
// different, heavier thing: it carries the full spec, the register link, and
// the SampleStyle raised from it. Promoting one to the other automatically
// created half-formed rows the salesperson then had to correct or delete.
//
// So the requirement stays on the Lead as the record it always was, and it is
// carried here only as TEXT the salesperson reads while registering the real
// products themselves.
function requirementSummaryFromLead(lead) {
  if (!lead) return "";
  const items = Array.isArray(lead.requirementItems) ? lead.requirementItems : [];
  const fromItems = items
    .filter((it) => it && String(it.product || "").trim())
    .map((it) => {
      const name = String(it.product).trim();
      return it.quantity != null ? `${name} (${Number(it.quantity)} pcs)` : name;
    });
  if (fromItems.length) return fromItems.join(", ");
  const names = Array.isArray(lead.productInterest) ? lead.productInterest : [];
  return names.map((n) => String(n || "").trim()).filter(Boolean).join(", ");
}

// Free-text spec fields carried through verbatim (trimmed). Kept in one list so
// adding a spec field to the model means adding it here only.
const PRODUCT_TEXT_FIELDS = [
  "note", "colour", "fabricPreference", "fabricComposition", "gsm", "fit",
  "sizeRange", "brandingPlacement", "trims", "specialConstruction", "existingUniform",
];
const GARMENT_GENDER_CODES = ["male", "female", "unisex"];

// Human labels for the header PATCH's EDITABLE fields, used to turn a raw
// diff into a readable log line — see summarizeEnquiryChange() below.
const FIELD_LABEL = {
  title: "title", enquiryDate: "enquiry date", source: "enquiry source",
  expectedClosingDate: "expected closing date", requirementDeadline: "requirement deadline",
  summary: "summary", status: "status", lostReason: "lost reason", lostReasonNote: "lost reason note",
  pricingCurrency: "pricing currency", targetPrice: "target price",
  estimatedPriceMin: "estimated price (min)", estimatedPriceMax: "estimated price (max)",
  pricingNote: "pricing note", opportunitySize: "opportunity size", winProbability: "win probability",
  priority: "priority", seriousness: "seriousness", expectedOrderDate: "expected order date",
};

function fmtFieldValue(v) {
  if (v === null || v === undefined || v === "") return "empty";
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (typeof v === "object") return "…";
  return String(v);
}

/**
 * Per-product diff: match old/new rows by NAME (the one thing that survives a
 * routine "Save requirement" — see sanitizeProducts' own comment on why _id
 * can't be the join key), then list which fields changed on each.
 */
function summarizeProductChanges(before, after) {
  const beforeByName = new Map((before || []).map((p) => [p.product, p]));
  const afterByName = new Map((after || []).map((p) => [p.product, p]));
  const bits = [];
  for (const name of afterByName.keys()) {
    if (!beforeByName.has(name)) { bits.push(`added "${name}"`); continue; }
    const b = beforeByName.get(name), a = afterByName.get(name);
    const changedFields = [];
    for (const key of new Set([...Object.keys(b || {}), ...Object.keys(a || {})])) {
      if (key === "_id") continue;
      if (JSON.stringify(b?.[key]) === JSON.stringify(a?.[key])) continue;
      changedFields.push(key === "images" ? "photo" : key);
    }
    if (changedFields.length) bits.push(`"${name}" (${changedFields.slice(0, 4).join(", ")}${changedFields.length > 4 ? ", …" : ""})`);
  }
  for (const name of beforeByName.keys()) {
    if (!afterByName.has(name)) bits.push(`removed "${name}"`);
  }
  return bits;
}

/**
 * A field-level "what actually changed" sentence for the change log — a bare
 * "updated ENQ-2026-00005" answers nothing when read a second time (21 Aug
 * 2026, explicit request: "what he change means what information he
 * changed... if u keep that log in form of any description... then the log
 * can be worth it").
 */
function summarizeEnquiryChange(before, after) {
  const d = diff(before, after);
  const bits = [];
  for (const key of d.changed) {
    if (key === "updatedBy" || key === "updatedAt" || key === "__v") continue;
    if (key === "products") {
      const productBits = summarizeProductChanges(before.products, after.products);
      if (productBits.length) bits.push(`products — ${productBits.slice(0, 3).join("; ")}${productBits.length > 3 ? "; …" : ""}`);
      continue;
    }
    if (key === "references") { bits.push("references"); continue; }
    const label = FIELD_LABEL[key] || key;
    bits.push(`${label}: ${fmtFieldValue(before[key])} → ${fmtFieldValue(after[key])}`);
  }
  return bits;
}

/**
 * Generic row-array diff for costing sheet tables. Rows have no stable id
 * across a save (the sanitizers below rebuild the array fresh, so Mongoose
 * assigns brand-new subdocument _ids every time) — matched by `keyFn` instead,
 * same reasoning as summarizeProductChanges' name-join above.
 */
function summarizeRowChanges(before, after, keyFn, label) {
  const beforeByKey = new Map((before || []).map((r) => [keyFn(r), r]));
  const afterByKey = new Map((after || []).map((r) => [keyFn(r), r]));
  const added = [], removed = [], changed = [];
  for (const [key, a] of afterByKey) {
    const b = beforeByKey.get(key);
    if (!b) { added.push(key); continue; }
    const isDiff = ["category", "item", "vendor", "unitCost", "unit", "consumption", "detail", "sam", "rate", "name", "price"]
      .some((f) => JSON.stringify(b[f]) !== JSON.stringify(a[f]));
    if (isDiff) changed.push(key);
  }
  for (const key of beforeByKey.keys()) {
    if (!afterByKey.has(key)) removed.push(key);
  }
  const bits = [];
  if (added.length) bits.push(`added ${added.slice(0, 3).map((k) => `"${k}"`).join(", ")}${added.length > 3 ? ` +${added.length - 3} more` : ""}`);
  if (changed.length) bits.push(`changed ${changed.slice(0, 3).map((k) => `"${k}"`).join(", ")}${changed.length > 3 ? ` +${changed.length - 3} more` : ""}`);
  if (removed.length) bits.push(`removed ${removed.slice(0, 3).map((k) => `"${k}"`).join(", ")}${removed.length > 3 ? ` +${removed.length - 3} more` : ""}`);
  return bits.length ? `${label}: ${bits.join("; ")}` : "";
}

function summarizeCostingSheetChange(before, after) {
  const parts = [];
  if (after.materials !== undefined) {
    const bit = summarizeRowChanges(before.materials, after.materials, (r) => `${r.category || ""} / ${r.item || "untitled"}`, "raw materials");
    if (bit) parts.push(bit);
  }
  if (after.operations !== undefined) {
    const bit = summarizeRowChanges(before.operations, after.operations, (r) => r.detail || "untitled", "operations");
    if (bit) parts.push(bit);
  }
  if (after.miscellaneous !== undefined) {
    const bit = summarizeRowChanges(before.miscellaneous, after.miscellaneous, (r) => r.name || "untitled", "miscellaneous");
    if (bit) parts.push(bit);
  }
  return parts.join(" · ");
}

/**
 * Undo `enquiry.products[]`'s own product→customer auto-link (see the PATCH
 * handler below) for products that no longer belong on the enquiry — a row
 * removed outright, or unpicked back to free text (26 Aug 2026, explicit
 * request: "if the sales person remove the product from here means the
 * linked product id get removed form that customer ok, means that product
 * id need to dis link form that customer").
 *
 * Two safety checks, both required, so this can never remove a link it
 * didn't create:
 *
 *  1. ONLY entries this auto-link mechanism itself created. A salesperson can
 *     independently assign a product to a customer from the Customer detail
 *     page's own Products tab (POST /:id/assign-items) — those entries carry
 *     no `notes`, only an enquiry-created one does (`"From <ref>'s
 *     requirement."`, set below). Removing a product from an enquiry must
 *     never silently undo a link someone set up by hand, somewhere else.
 *
 *  2. ONLY when no OTHER active enquiry for the same account still
 *     references the stock item. The same product can legitimately be asked
 *     for across more than one enquiry for a repeat customer; the link
 *     belongs to the RELATIONSHIP; removing it from one enquiry must not
 *     sever a need a different, still-open enquiry has for it.
 *
 * Best-effort and never awaited by its caller for the same reason the
 * forward link isn't: a product row saving must never fail on this.
 */
/**
 * @param {object} args.companyClause  the caller's already-resolved company
 *   filter. Passed in rather than re-resolved: this runs as background work
 *   after a write, and "which company" must be the one that made the write,
 *   not whatever a second lookup happens to decide.
 */
async function unlinkRemovedEnquiryProducts({ accountId, removedStockItemIds, excludeEnquiryId, companyClause }) {
  if (!accountId || !removedStockItemIds?.length) return;
  try {
    const account = await Account.findOne(await scoped(req, { _id: accountId })).select("linkedCustomer");
    if (!account?.linkedCustomer) return;

    const stillNeeded = new Set(
      (
        /* Scoped: "is this stock item still wanted" must be answered from
           THIS company's enquiries. Another company still wanting it is not a
           reason to keep this company's link, and reading their enquiries to
           find out is the leak. */
        await Enquiry.find(await scoped(req, {
          $and: [
            companyClause || {},
            {
              accountId,
              isActive: true,
              _id: { $ne: excludeEnquiryId },
              "products.stockItemId": { $in: removedStockItemIds },
            },
          ],
        }))
          .select("products.stockItemId")
          .lean()
      ).flatMap((e) => (e.products || []).map((p) => p.stockItemId && String(p.stockItemId))),
    );

    const toUnlink = removedStockItemIds.filter((id) => !stillNeeded.has(String(id)));
    if (!toUnlink.length) return;

    const customer = await Customer.findById(account.linkedCustomer).select("assignedStockItems");
    if (!customer) return;
    const unlinkSet = new Set(toUnlink.map(String));
    const before = customer.assignedStockItems.length;
    customer.assignedStockItems = customer.assignedStockItems.filter(
      (a) => !(a.stockItemId && unlinkSet.has(String(a.stockItemId)) && /^From .+'s requirement\.$/.test(a.notes || "")),
    );
    if (customer.assignedStockItems.length !== before) await customer.save();
  } catch (e) {
    console.error("[enquiries] product unlink failed:", e.message);
  }
}

// A client-supplied products array, cleaned to what the schema accepts: drop
// blank rows, coerce quantity to a non-negative number, validate the gender
// enum, and carry the garment-spec fields through trimmed.
function sanitizeProducts(input) {
  if (!Array.isArray(input)) return undefined;
  return input
    .filter((p) => p && String(p.product || "").trim())
    .map((p) => {
      const qty = p.quantity === "" || p.quantity == null ? undefined : Number(p.quantity);
      // A picked row carries its master id; a typed one does not, and both are
      // valid. Validated rather than trusted — this arrives from the client.
      const sid = String(p.stockItemId || "").trim();
      const validSid = mongoose.Types.ObjectId.isValid(sid) ? sid : undefined;
      const out = {
        /* The line this row claims to be — carried through UNTRUSTED. It is
           only a claim: `reconcileProductLineIdentities` accepts it solely if
           this enquiry already holds that exact reference. Dropping it here
           (as this function used to) made every save re-mint every line, and
           orphaned the Development Files rooted on the old references. */
        productLineRef: String(p.productLineRef || "").trim() || undefined,
        product: String(p.product).trim(),
        stockItemId: validSid,
        stockItemReference: String(p.stockItemReference || "").trim() || undefined,
        // Only meaningful alongside a real stockItemId (26 Aug 2026, bug fix)
        // — see the model's own comment on this field. Forced false whenever
        // there is no id at all, so a stray true can never survive a save
        // with nothing for it to describe.
        pickedFromRegister: validSid ? Boolean(p.pickedFromRegister) : false,
        quantity: Number.isFinite(qty) && qty >= 0 ? qty : undefined,
        // The per-piece cost ceiling for this product (2 Sept 2026). Same
        // treatment as quantity: an empty box means "no cap", not zero — a
        // zero budget would read as "this must cost nothing" and block every
        // raw item downstream.
        maxBudget: (() => {
          if (p.maxBudget === "" || p.maxBudget == null) return undefined;
          const n = Number(p.maxBudget);
          return Number.isFinite(n) && n >= 0 ? n : undefined;
        })(),
        gender: GARMENT_GENDER_CODES.includes(p.gender) ? p.gender : undefined,
        logo: Boolean(p.logo),
        embroidery: Boolean(p.embroidery),
        printing: Boolean(p.printing),
      };
      for (const f of PRODUCT_TEXT_FIELDS) {
        const v = p[f];
        if (v != null && String(v).trim()) out[f] = String(v).trim();
      }
      // Reference images (Cloudinary or, on older rows, Drive) — keep up to 8,
      // dropping entries with neither a publicId, a fileId, nor a URL.
      if (Array.isArray(p.images)) {
        const imgs = p.images
          .filter((im) => im && (String(im.publicId || "").trim() || String(im.fileId || "").trim() || String(im.url || "").trim()))
          .slice(0, 8)
          .map((im) => ({
            publicId: String(im.publicId || "").trim() || undefined,
            fileId: String(im.fileId || "").trim() || undefined,
            name: String(im.name || "").trim() || undefined,
            url: String(im.url || "").trim() || undefined,
          }));
        if (imgs.length) out.images = imgs;
      }
      // Salesperson-defined specification (label + answer). A row with no
      // label is dropped — an answer to an unnamed question tells R&D
      // nothing, and it is the label that makes this readable downstream.
      // Capped at 20 so a runaway client cannot grow the subdocument without
      // bound; labels trimmed to a sane length for the same reason.
      if (Array.isArray(p.customSpecs)) {
        const specs = p.customSpecs
          .filter((s) => s && String(s.label || "").trim())
          .slice(0, 20)
          .map((s) => ({
            label: String(s.label).trim().slice(0, 80),
            value: String(s.value == null ? "" : s.value).trim().slice(0, 500),
          }));
        if (specs.length) out.customSpecs = specs;
      }
      return out;
    });
}

// A client-supplied references array, cleaned: drop rows that are entirely
// empty (no label/url/note), validate the type enum (default "other"), trim.
function sanitizeReferences(input) {
  if (!Array.isArray(input)) return undefined;
  return input
    .filter((r) => r && (String(r.label || "").trim() || String(r.url || "").trim() || String(r.note || "").trim()))
    .map((r) => ({
      label: r.label ? String(r.label).trim() : undefined,
      type: ENQUIRY_REFERENCE_TYPE_CODES.includes(r.type) ? r.type : "other",
      url: r.url ? String(r.url).trim() : undefined,
      note: r.note ? String(r.note).trim() : undefined,
    }));
}

/**
 * Resolve the Journey by its human reference (SJ-YYYY-NNNN) or Mongo id, and
 * return the loaded document. Throws a 404-shaped error object if absent.
 */
/* ══════════════════════════════════════════════════════════════════════════
 * TENANT SCOPE (Chunk 3A correction)
 *
 * ── WHY EVERY LOOKUP IN THIS FILE GOES THROUGH ONE FUNCTION ────────────────
 * This router selects an Enquiry in thirty-five places. A rule that each of
 * them must remember to add `companyId` holds until the thirty-sixth is
 * written — and the one that forgets is indistinguishable from the ones that
 * did not: it works, it returns data, and nothing fails until the data belongs
 * to somebody else.
 *
 * So the company clause is built in
 * `services/companyContext/salesScope.service.js` and folded in here. A future
 * route that writes `Enquiry.findOne(await scoped(req, {_id}))` is now visibly doing something
 * the rest of the file does not.
 *
 * Foreign, missing and (in a multi-company deployment) unowned records are all
 * simply absent — one answer, no way to tell them apart.
 * ═════════════════════════════════════════════════════════════════════════ */
const { scopedFilter: salesScopedFilter, scopeFor: salesScopeFor } = require("../../../services/companyContext/salesScope.service");


/**
 * A tenant refusal keeps its own status.
 *
 * Every `catch` in this router ends in a generic 500. That is right for a bug
 * and wrong for a refusal: "choose which company you are working in" (409),
 * "your account is not linked to a company" (403) and "we could not check just
 * now" (503) are all actionable answers, and a 500 tells the caller none of
 * them and invites a retry that will fail the same way.
 *
 * Returns true when it has answered, so a catch block can fall through to its
 * existing behaviour for anything that is genuinely a fault.
 */
function answeredTenantRefusal(res, err) {
  if (err?.name !== "StorePurchaseError") return false;
  res.status(err.status).json(err.toResponse());
  return true;
}

/** A selector with this actor's company clause folded in. */
const scoped = (req, selector = {}) => salesScopedFilter(req, selector);

async function loadJourney(req, journeyRef) {
  const query = isObjectId(journeyRef)
    ? { $or: [{ _id: journeyRef }, { journeyId: journeyRef }] }
    : { journeyId: journeyRef };
  /* ── THE JOURNEY IS SCOPED TOO, AND THAT IS THE POINT ──────────────────
     An Enquiry is created FROM a journey. Loading the journey unscoped and
     then stamping the actor's company onto the resulting enquiry is a way to
     CLAIM one: open another company's journey and its opportunity is quietly
     adopted, with the adoption looking like ordinary use. The company is part
     of the same query, so a foreign journey is simply not found. */
  const journey = await SalesJourney.findOne(await scoped(req, { ...query, isActive: true }));
  return journey;
}

/** Populate the display names a client needs, without duplicating them in the DB. */
async function decorate(enquiry, req = null) {
  const obj = enquiry.toObject ? enquiry.toObject() : enquiry;
  const [account, contact, journey] = await Promise.all([
    obj.accountId ? Account.findOne(await scoped(req, { _id: obj.accountId })).select("accountId companyName displayName").lean() : null,
    obj.primaryContactId ? Contact.findOne(await scoped(req, { _id: obj.primaryContactId })).select("firstName lastName jobTitle email mobile whatsapp").lean() : null,
    obj.journeyId ? SalesJourney.findOne(await scoped(req, { _id: obj.journeyId })).select("journeyId name").lean() : null,
  ]);
  const out = {
    ...obj,
    customerName: account ? account.displayName || account.companyName : null,
    customerCode: account?.accountId || null,
    contact: contact
      ? { name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(), jobTitle: contact.jobTitle, email: contact.email, mobile: contact.mobile, whatsapp: contact.whatsapp }
      : null,
    journeyRef: journey?.journeyId || null,
    journeyName: journey?.name || null,
  };
  // `req` is optional so an internal caller (notifications, the PI resolver)
  // can decorate without a request — those never reach a browser. Every ROUTE
  // passes it, and a route that forgets falls through to the safe side.
  if (!Array.isArray(out.costLedger)) return out;
  // `req` is optional so an internal caller (notifications, the PI resolver)
  // can decorate without a request — those never reach a browser. Every ROUTE
  // passes it, and a route that forgets falls through to the safe side.
  return { ...out, costLedger: reduceCostLedger(out.costLedger, req ? canSeeCost(req.user) : false, await markupPercent()) };
}

// GET /api/cms/crm/enquiries/by-journey/:journeyRef
// Get-or-create the enquiry for a journey, seeded from account/contact/lead.
router.get("/by-journey/:journeyRef", salesAuth, async (req, res) => {
  try {
    const journey = await loadJourney(req, req.params.journeyRef);
    if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });

    let enquiry = await Enquiry.findOne(await scoped(req, { journeyId: journey._id, isActive: true }));

    if (!enquiry) {
      // Seed from the source Lead (the one whose conversion points at this
      // journey), if any — it carries the source, the summary and the
      // product-wise requirement captured at lead stage.
      const lead = await Lead.findOne(await scoped(req, { "conversion.journeyId": journey._id }))
        .select("leadId source company firstName lastName requirements requirementItems productInterest "
              + "estimatedUnitPrice estimatedUnitPriceConfidence estimatedUnitPriceSource "
              + "estimatedAnnualQuantity estimatedAnnualQuantityConfidence estimatedAnnualQuantitySource "
              + "estimatedAnnualRevenue estimatedAnnualRevenueConfidence estimatedAnnualRevenueSource")
        .lean();
      const primaryContact = journey.primaryContactId
        ? journey.primaryContactId
        : (await Contact.findOne(await scoped(req, { accountId: journey.accountId, isActive: true, isPrimary: true })).select("_id").lean())?._id
          || (await Contact.findOne(await scoped(req, { accountId: journey.accountId, isActive: true })).select("_id").lean())?._id;

      /* ── OWNERSHIP, FROM THE SERVER ──────────────────────────────────
         Resolved from the actor's own membership (or the documented
         single-company deployment rule) and never from the request. When it
         cannot be proved the enquiry is created UNOWNED with the reason
         recorded, rather than refused — Sales keeps working, and costing
         refuses to use an unowned enquiry once a second company exists. */
      const ownership = await ownershipFieldsFor(req.user);

      enquiry = await createWithRef(Enquiry, {
        ...ownership,
        journeyId: journey._id,
        accountId: journey.accountId,
        primaryContactId: primaryContact || undefined,
        ownerId: journey.ownerId,
        ownerName: journey.ownerName,
        sourceLeadId: lead?._id || undefined,
        title: journey.name,
        source: enquirySourceFromLead(lead),
        // The lead's own requirement note, plus what it said it wanted — kept
        // as readable text so nothing the lead established is lost now that
        // products are no longer auto-created from it (see
        // requirementSummaryFromLead).
        summary: [lead?.requirements, requirementSummaryFromLead(lead) && `Requirement from lead: ${requirementSummaryFromLead(lead)}`]
          .filter(Boolean).join("\n\n") || undefined,
        // Deliberately empty — the salesperson registers the real products in
        // the Enquiry stage, where the register link and full spec are
        // captured. See requirementSummaryFromLead above.
        products: [],
        // Seed our indicative estimate from the lead's researched unit price —
        // a starting point the salesperson refines. The customer's target is
        // left blank for them to capture.
        estimatedPriceMin: lead?.estimatedUnitPrice || undefined,
        estimatedPriceMax: lead?.estimatedUnitPrice || undefined,
        // …and keep what makes that number mean something. The Lead spent a
        // whole checklist establishing these and how sure it was of each; the
        // conversion used to keep one figure and throw the rest away, so the
        // enquiry opened showing a price nobody could account for. See the
        // `leadEstimate` block on the Enquiry model for why it is a snapshot.
        leadEstimate: leadEstimateSnapshot(lead),
        // Smart start: an enquiry converted FROM a lead has already been
        // contacted and had its requirement gathered (that's what let the lead
        // convert), so it opens at "qualified" rather than re-walking the funnel.
        // A direct RFQ (no lead) starts at "new" and runs the full funnel.
        status: lead ? "qualified" : "new",
        createdBy: actor(req),
        updatedBy: actor(req),
      });

      // Merchandising and the Project Manager both work this enquiry from
      // here on (see the "staged instead" comment on the products route
      // below) — best-effort, never awaited: an email failing must not
      // affect the enquiry that was just created.
      (async () => {
        const customerName = await customerNameFor(enquiry, req);
        const products = enquiry.products || [];
        const productSummary = products.length
          ? products.map((p) => (p.quantity ? `${p.product} (${p.quantity} pcs)` : p.product)).join(", ")
          : "Not specified yet";
        await notifyEvent("enquiry_created", {
          heading: `New enquiry: ${enquiry.title || enquiry.enquiryId}`,
          bodyHtml: `<p><strong>${escapeHtml(actor(req).name || "Sales")}</strong> opened a new Enquiry/RFQ.</p>`,
          details: [
            ["Customer", customerName],
            ["Enquiry ref", enquiry.enquiryId],
            ["Product(s)", productSummary],
            ["Source", enquiry.source],
          ],
          image: products[0]?.images?.[0],
          bodyText: `${actor(req).name || "Sales"} opened a new Enquiry/RFQ for ${customerName} — ${enquiry.enquiryId || ""}.`,
          ctaLabel: "Open Enquiry",
          ctaUrl: `${DEPT_NOTIFY_APP_URL}/sales/dashboard/journeys/${journey.journeyId}/enquiry`,
        });
      })().catch(() => {});
    }

    /* ── AND WHETHER A PROFORMA HAS BEEN RAISED ON IT ──────────────────
       The product board draws all three Pipeline stages from this one read,
       and had no way of knowing that the Cost & Invoicing work had finished
       in the only way it can finish — a document. It showed "Priced — ready
       to send / waiting on you" beside a raised invoice.

       On the SINGLE-enquiry read only. `decorate` also serves the list
       routes, and one extra lookup per row there would be a query per
       enquiry for a fact no list shows. */
    const decorated = await decorate(enquiry, req);
    let proforma = null;
    try {
      proforma = await proformaRequest.currentProformaFor(await costingCtxFor(req), enquiry);
    } catch (e) {
      /* A fact the board can do without. The enquiry itself must still load:
         failing the whole stage because a summary could not be built is the
         worse outcome by a distance. */
      proforma = null;
    }

    return res.json({ success: true, enquiry: { ...decorated, proforma } });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /by-journey", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/by-journey/:journeyRef/change-log
// The journey-level entry point into the SAME change log — the Activity
// drawer only ever has the journey reference on hand, not the enquiry's own
// Mongo _id, so it resolves through the journey exactly like the GET above
// does rather than making every caller look the enquiry up twice.
// Style & Sample's own timeline (SampleStyle.history — materials/tech-sheet/
// sample/stage-routing events, already recorded by routes/.../sampleStyles.js
// via logHistory()) predates this change log and lives on each style
// document, not in the shared ChangeLog collection. Normalized into the same
// {departmentSlug, action, summary, actorName, entityLabel, createdAt} shape
// here so ONE feed covers every department touching the journey — Sales'
// own edits AND R&D/Merchandising's style work — instead of Style & Sample
// activity being invisible from the journey-level log (21 Aug 2026, explicit
// request: "as this sales journey is happening via multiple department
// multiple persons... proper log need to keep... what happened when
// happened who did").
const STYLE_HISTORY_LABEL = {
  materials_set: "set the selected materials",
  materials_change_rejected: "rejected a proposed materials change",
  send_back: "sent the style back a stage",
  route: "moved the style forward",
  tech_submitted: "submitted the tech sheet",
  tech_approved: "approved the tech sheet",
  tech_changes: "requested changes to the tech sheet",
  sample_round: "logged a sample round",
  sample_submitted: "submitted the physical sample",
  sample_approved: "approved the sample",
  sample_rejected: "rejected the sample",
};
function styleHistoryEntries(style) {
  return (style.history || []).map((ev) => {
    const verb = STYLE_HISTORY_LABEL[ev.kind] || (ev.kind || "").replace(/_/g, " ");
    const stageNote = ev.kind === "route" || ev.kind === "send_back"
      ? ` (${ev.from || "?"} → ${ev.to || "?"}${ev.note ? ` — ${ev.note}` : ""})`
      : ev.kind === "materials_set"
        ? ` (${ev.from || "none"} → ${ev.to || "none"})`
        : ev.note ? ` — ${ev.note}` : "";
    return {
      departmentSlug: "research-development",
      entity: "crm-sample-style",
      entityId: String(style._id),
      entityLabel: style.productName || style.styleCode || style.sampleStyleId || "",
      action: ev.kind || "update",
      summary: `${ev.by?.name || "Someone"} ${verb} for "${style.productName || "a style"}"${stageNote}`,
      actorName: ev.by?.name || "",
      createdAt: ev.at,
    };
  });
}

// GET /api/cms/crm/enquiries/by-journey/:journeyRef/pending-approvals
//
// Every decision this journey is currently waiting on FROM SALES, in one
// list — costing changes Merchandising/PM proposed, tech sheets R&D
// submitted, samples R&D submitted, materials changes proposed — scanned
// across the Enquiry AND every SampleStyle under this journey, so it's one
// consolidated answer regardless of which stage the pending thing actually
// lives in. Powers a global "you have approvals waiting" banner shown on
// every stage tab, not just the one where the item sits (21 Aug 2026,
// explicit request — "so many approval and things are there... showcase
// the approvals... so the sales person can easily get to know").
//
// Deliberately narrow: this is SALES' OWN inbox, not a general activity feed
// — customer-approval and stock-item-request items are a different audience
// (the customer, and Merchandising, respectively) and stay out of this list.
router.get("/by-journey/:journeyRef/pending-approvals", salesAuth, async (req, res) => {
  try {
    const journey = await loadJourney(req, req.params.journeyRef);
    if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });

    const enquiry = await Enquiry.findOne(await scoped(req, { journeyId: journey._id, isActive: true }))
      .select("costingChangeLog").lean();
    const styles = await SampleStyle.find({ journeyId: journey._id, isActive: true })
      .select("productName styleCode sampleStyleId materialsChangeLog techSheet sample").lean();

    const approvals = [];

    for (const entry of (enquiry?.costingChangeLog || [])) {
      if (entry.status !== "pending") continue;
      approvals.push({
        key: `costing-${entry._id}`,
        type: "costing",
        stage: "costQuote",
        productName: entry.productName,
        label: `${PART_LABEL[entry.part || "combined"] || entry.part} costing for "${entry.productName}"`,
        submittedByName: entry.submittedBy?.name || "Someone",
        submittedAt: entry.submittedAt,
      });
    }

    for (const style of styles) {
      const label = style.productName || style.styleCode || style.sampleStyleId || "a style";
      for (const entry of (style.materialsChangeLog || [])) {
        if (entry.status !== "pending") continue;
        approvals.push({
          key: `materials-${entry._id}`,
          type: "materials",
          stage: "styleSample",
          productName: style.productName,
          label: `Materials for "${label}"`,
          submittedByName: entry.submittedBy?.name || "Someone",
          submittedAt: entry.submittedAt,
        });
      }
      if (style.techSheet?.status === "submitted") {
        approvals.push({
          key: `tech-${style._id}`,
          type: "techSheet",
          stage: "styleSample",
          productName: style.productName,
          label: `Tech sheet for "${label}"`,
          submittedByName: "R&D",
          submittedAt: style.techSheet.submittedAt,
        });
      }
      if (style.sample?.status === "submitted") {
        approvals.push({
          key: `sample-${style._id}`,
          type: "sample",
          stage: "styleSample",
          productName: style.productName,
          label: `Sample for "${label}"`,
          submittedByName: "R&D",
          submittedAt: style.sample.submittedAt,
        });
      }
    }

    approvals.sort((a, b) => new Date(a.submittedAt || 0) - new Date(b.submittedAt || 0));
    return res.json({ success: true, approvals });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /by-journey/:journeyRef/pending-approvals", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/by-journey/:journeyRef/change-log", salesAuth, async (req, res) => {
  try {
    const journey = await loadJourney(req, req.params.journeyRef);
    if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const enquiry = await Enquiry.findOne(await scoped(req, { journeyId: journey._id, isActive: true })).select("_id").lean();
    const styles = await SampleStyle.find({ journeyId: journey._id, isActive: true }).select("history productName styleCode sampleStyleId").lean();

    const enquiryEntries = enquiry ? await historyFor("crm-enquiry", enquiry._id, limit) : [];
    const styleEntries = styles.flatMap(styleHistoryEntries);

    const entries = [...enquiryEntries, ...styleEntries]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);

    return res.json({ success: true, entries });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /by-journey/:journeyRef/change-log", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Fields a client may set on the header (Chunk 1). Everything else is derived
// or server-owned (enquiryId, accountId, ownerId, references).
const EDITABLE = [
  "title", "enquiryDate", "source", "expectedClosingDate", "requirementDeadline", "summary",
  "status", "lostReason", "lostReasonNote",
  // Pricing + qualification (Chunk 4)
  "pricingCurrency", "targetPrice", "estimatedPriceMin", "estimatedPriceMax", "pricingNote",
  "opportunitySize", "winProbability", "priority", "seriousness", "expectedOrderDate",
];

// PATCH /api/cms/crm/enquiries/:id — update header fields.
/**
 * GET /:id/delivery-options — what the delivery-terms picker may offer.
 *
 * ── ONLY SHIPPING ADDRESSES, AND ONLY THIS COMPANY'S ────────────────────────
 * A picker that lists billing and office addresses is a picker somebody will
 * eventually choose one from, and the save refuses it — so it never offers
 * them. Warehouses are this company's active ones, by the same rule.
 *
 * No money of any kind: this answers where and how, never what it costs.
 */
/* ═══════════════════════════════════════════════════════════════════════════
   THE SALES COSTING BRIEF — WHAT SALES ASKS CENTRAL COSTING TO PRICE
   ═══════════════════════════════════════════════════════════════════════════
   Which approved style is being quoted, what quantities the customer wants
   priced, in what unit, at what proposed selling price, by when, and why.

   ── WHAT THESE ROUTES REFUSE TO STORE ────────────────────────────────────
   No material cost, no rate, no standard time, no supplier quotation, no
   company or Board policy value, no overhead and no margin floor. Sales says
   WHAT to cost; every figure that answers it belongs to a department or to the
   Board, and Central Costing reads them itself. A field accepted here would be
   Sales costing the garment.

   ── AND NOTHING IS RETARGETED ────────────────────────────────────────────
   A confirmed brief is what a frozen costing version cites. Moving the
   quotation to a different style confirms a NEW brief and supersedes the old
   one explicitly, with a reason. Editing the old one to point elsewhere would
   make every version citing it describe a garment it was not calculated for.
════════════════════════════════════════════════════════════════════════════ */

/* ══ THE COMMERCIAL LINE — SALES' OWN QUANTITY COMMAND ═══════════════════
   The number a garment is priced FOR. Confirmed in Cost & Invoicing, keyed by
   the product line's permanent reference and the approved style, and never by
   a product name.

   The routes below are the whole of Sales' involvement. Confirming a quantity
   writes the commercial line AND drives the costing request underneath it, so
   nobody has to know a "costing brief" exists.

   Deliberately absent: a portal customer. A prospect's order is priced before
   anybody is linked; that requirement belongs to issuing a proforma invoice.
════════════════════════════════════════════════════════════════════════════ */

/** GET every commercial line on one enquiry. */
router.get("/:id/commercial-lines", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const scope = await salesScopeFor(req);
    const out = await commercialLine.readLines(
      { companyId: scope.companyId }, { enquiryId: req.params.id },
    );
    return res.json({ success: true, ...out });
  } catch (err) {
    return sendBriefError(res, err, "GET /:id/commercial-lines");
  }
});

/**
 * POST the confirmed quantity for one product line.
 *
 * Idempotent by value: confirming the number already in force mints no
 * revision and starts no second costing.
 */
router.post("/:id/commercial-lines/confirm-quantity", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const scope = await salesScopeFor(req);
    const out = await commercialLine.confirmQuantity(
      { companyId: scope.companyId },
      {
        enquiryId: req.params.id,
        productLineRef: String(req.body?.productLineRef || ""),
        sampleStyleId: String(req.body?.sampleStyleId || ""),
        quantity: req.body?.quantity,
        reason: String(req.body?.reason || ""),
        actor: actor(req),
      },
    );
    return res.json({ success: true, ...out });
  } catch (err) {
    return sendBriefError(res, err, "POST /:id/commercial-lines/confirm-quantity");
  }
});

/** GET the briefs on one enquiry, and the styles Sales may choose from. */
router.get("/:id/costing-briefs", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const scope = await salesScopeFor(req);
    const out = await costingBrief.readBriefs(
      { companyId: scope.companyId },
      { enquiryId: req.params.id, productName: String(req.query.product || "").trim() },
    );
    return res.json({ success: true, ...out });
  } catch (err) {
    return sendBriefError(res, err, "GET /:id/costing-briefs");
  }
});

/** PUT a draft brief — the style, the quantities, the unit, the price, the note. */
router.put("/:id/costing-briefs", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const scope = await salesScopeFor(req);
    const out = await costingBrief.saveBrief(
      { companyId: scope.companyId },
      { enquiryId: req.params.id, body: req.body || {}, actor: actor(req) },
    );
    return res.json({ success: true, ...out });
  } catch (err) {
    return sendBriefError(res, err, "PUT /:id/costing-briefs");
  }
});

/**
 * POST the confirmation — the act that turns a draft into the fact a costing
 * may read, and supersedes whatever it replaces.
 */
router.post("/:id/costing-briefs/:briefId/confirm", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const scope = await salesScopeFor(req);
    const out = await costingBrief.confirmBrief(
      { companyId: scope.companyId },
      {
        enquiryId: req.params.id,
        briefId: req.params.briefId,
        reason: String(req.body?.reason || ""),
        actor: actor(req),
      },
    );
    return res.json({ success: true, ...out });
  } catch (err) {
    return sendBriefError(res, err, "POST /:id/costing-briefs/:briefId/confirm");
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   PREPARING THE ESTIMATE — SALES ASKS, THE ENGINE ANSWERS
   ═══════════════════════════════════════════════════════════════════════════
   Sales never opens Central Costing. These two routes are the whole of their
   involvement: read where the estimate stands, and ask for it to be prepared
   or refreshed.

   ── WHAT THE BROWSER SENDS ───────────────────────────────────────────────
   An enquiry, a product and an action key. Not a style, not a quantity, not a
   scenario, not a policy date — every one of those is resolved server-side
   from records. A browser that could compose a calculation could compose one
   from figures nobody recorded.

   ── AND READING WRITES NOTHING ───────────────────────────────────────────
   The GET is called on every page load. A screen that created a version by
   being looked at would fill the history with versions nobody asked for, and
   would make "how many times was this re-costed?" unanswerable.
════════════════════════════════════════════════════════════════════════════ */

/** GET where the estimate stands: readiness, blockers, freshness, result. */
/**
 * GET /api/cms/crm/enquiries/:id/proforma-readiness
 *
 * CAN EACH LINE BE INVOICED, AND IF NOT, WHAT IS THE NEXT THING TO DO?
 *
 * ── WHY A READ EXISTS AT ALL ────────────────────────────────────────────────
 * The screen used to work this out for itself — a confirmed quantity, a floor
 * on screen, a price typed, and a review whose stored state said APPROVED. Four
 * facts, and none of them the question. A price edited after approval leaves
 * that state saying APPROVED while the proforma command refuses, so the page
 * said "everything it needs is in place" above a button that could not work.
 *
 * This asks the command's own authority and publishes the answer. The summary
 * and the gate are then the same sentence.
 *
 * Read-only: it writes nothing, creates nothing, and is safe on every load.
 */
router.get("/:id/proforma-readiness", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    }
    const ctx = await costingCtxFor(req);

    /* ── COMPANY FIRST, THEN THE RECORD ────────────────────────────────
       A foreign enquiry is NOT FOUND, never forbidden: a refusal that varies
       with the answer is a way to enumerate other companies' enquiries. */
    const enquiry = await Enquiry.findOne(
      await scoped(req, { _id: req.params.id, isActive: true }),
    ).lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "That enquiry was not found." });

    /* One verdict per CONFIRMED LINE, keyed by the pair the commercial line
       itself is keyed by. A product row with no confirmed line has nothing to
       be ready for and is simply absent. */
    const lines = [];
    for (const line of enquiry.commercialLines || []) {
      const key = {
        productLineRef: String(line.productLineRef || ""),
        sampleStyleId: String(line.sampleStyleId || ""),
        productName: String(line.productName || ""),
      };
      if (!key.productLineRef || !key.sampleStyleId) continue;
      lines.push(await lineReadiness.issuanceProjection(ctx, enquiry, key));
    }

    /* ── AND WHAT HAS ALREADY BEEN RAISED ──────────────────────────────
       The page kept offering "Create proforma invoice" beside a document that
       existed, because nothing on the read side ever mentioned it — the only
       trace was a link the BROWSER wrote when somebody happened to open the
       request. The figures are the ones the document was stamped with, so the
       screen repeats what it says rather than recomputing it. */
    const proforma = await proformaRequest.currentProformaFor(ctx, enquiry);

    return res.json({ success: true, lines, proforma: proforma || null });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /:id/proforma-readiness", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/cms/crm/enquiries/:id/proforma-request
 *
 * RAISE THE CUSTOMER REQUEST A PROFORMA IS BUILT ON.
 *
 * ── WHY THIS AND NOT THE GENERIC ENDPOINT ───────────────────────────────────
 * `POST /customers/:id/create-request` takes items with quantities and has no
 * enquiry identity, so it cannot look up what Sales confirmed — it stores what
 * arrives. A draft at 500 against a line confirmed at 750 was creatable, and
 * only the later quotation-pricing command would notice.
 *
 * This route is owned by the enquiry, so it can resolve the commercial line
 * itself. It takes NO quantity. The generic endpoint is untouched for the
 * callers that still use it.
 */
router.post("/:id/proforma-request", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    }
    const ctx = await costingCtxFor(req);
    const out = await proformaRequest.createForEnquiry(ctx, req.params.id, {
      customerId: String(req.body?.customerId || "").trim(),
      items: Array.isArray(req.body?.items) ? req.body.items : [],
      customerInfo: req.body?.customerInfo || {},
      /* The idempotency anchor, so a lost response replays rather than
         raising a second proforma. */
      actionKey: String(req.headers["idempotency-key"] || req.body?.actionKey || ""),
      /* ── A SUCCESSOR IS NAMED, NEVER INFERRED ─────────────────────────
         Only set when the caller means to replace a proforma that already
         exists. Absent, a moved commercial state is refused with the
         reference of what is there rather than quietly raising a second
         document beside it. */
      supersedes: String(req.body?.supersedes || "").trim(),
      actor: actor(req),
    });
    return res.status(out.replayed ? 200 : 201).json({ success: true, ...out });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    if (err?.code === proformaRequest.CODES.LINE_REFUSED) {
      /* ── 409, NOT 422 ───────────────────────────────────────────────
         Every refusal here is well-formed and no longer true: the document
         asked for disagrees with the commercial state as it stands, and
         re-reading that state is the fix. The same distinction the
         quotation save door draws. */
      return res.status(409).json({
        success: false,
        code: "PROFORMA_COMMERCIAL_STATE_CONFLICT",
        message: err.message,
        lines: err.details?.lines || [],
      });
    }
    if (err?.code === proformaRequest.CODES.ALREADY_RAISED
      || err?.code === proformaRequest.CODES.SUPERSESSION_MISMATCH) {
      /* ── 409, AND IT NAMES WHAT EXISTS ──────────────────────────────
         Not a malformed request: a well-formed one aimed at an enquiry that
         already has a proforma. The reference travels with the refusal so a
         caller can open that document instead of guessing. */
      return res.status(409).json({
        success: false,
        code: err.code,
        message: err.message,
        ...(err.details || {}),
      });
    }
    if (err?.code === proformaRequest.CODES.NOT_FOUND) {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (err?.code === proformaRequest.CODES.VALIDATION) {
      return res.status(400).json({ success: false, message: err.message, ...(err.details || {}) });
    }
    console.error("[enquiries] POST /:id/proforma-request", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * THE LINE A COSTING REQUEST IS ABOUT.
 *
 * ── ADDITIVE, AND VERIFIED DOWNSTREAM ───────────────────────────────────────
 * These routes took only `product` — a NAME — so an enquiry carrying the same
 * garment twice in two colourways had one costing, one review and one floor
 * between them. Both fields are optional here, so an older client still works,
 * and `costingPreparation.resolve` refuses a pair that does not belong to this
 * enquiry rather than answering with whatever the name found.
 */
const lineFrom = (src = {}) => ({
  product: String(src.product || "").trim(),
  productLineRef: String(src.productLineRef || "").trim(),
  sampleStyleId: String(src.sampleStyleId || "").trim(),
});

router.get("/:id/costing-estimate", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const ctx = await costingCtxFor(req);
    const resolved = await costingPreparation.resolve(ctx, {
      enquiryId: req.params.id,
      ...lineFrom(req.query),
    });
    return res.json({
      success: true,
      ...costingResult.resultFor({ resolved, caps: ctx.capabilitySet }),
    });
  } catch (err) {
    return sendBriefError(res, err, "GET /:id/costing-estimate");
  }
});

/**
 * POST prepare or refresh.
 *
 * ── AN EXPLICIT ACTION, DELIBERATELY ─────────────────────────────────────
 * Not a background job and not a page-load side effect. Somebody presses a
 * button, and the fingerprint then decides whether that produces a version at
 * all — identical sources produce none, so pressing it twice is safe and so is
 * leaving the page open.
 */
router.post("/:id/costing-estimate/prepare", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const ctx = await costingCtxFor(req);
    /* ── THE GRANT TO ASK, CHECKED AT THE DOOR ────────────────────────
       `costingCtxFor` has proved WHICH company this actor belongs to. It has
       not asked what they may do in it, and company membership is not
       authority: every Sales rank belongs to the same company and only some
       of them may cause a costing to exist.

       Refused here so the work is never started, and again inside the
       service so a future route cannot arrive without it. The capability set
       is the shared resolver's, re-read from the database on this request —
       so a grant revoked a minute ago is gone now, not when a token
       expires. */
    assertMayPrepare(ctx);
    const out = await costingPreparation.prepare(ctx, {
      enquiryId: req.params.id,
      ...lineFrom(req.body),
      /* The idempotency anchor. Sent by the screen, so a retry after a lost
         response replays rather than making a second version. */
      actionKey: String(req.headers["idempotency-key"] || req.body?.actionKey || ""),
      actor: actor(req),
    });
    return res.json({
      success: true,
      outcome: out.outcome,
      ...costingResult.resultFor({ resolved: out, caps: ctx.capabilitySet }),
    });
  } catch (err) {
    return sendBriefError(res, err, "POST /:id/costing-estimate/prepare");
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE COMMERCIAL REVIEW — SALES DECIDES WHETHER A PRICE MAY BE QUOTED
   ═══════════════════════════════════════════════════════════════════════════
   Submit, approve, return, and the executive exception for a price below the
   company's own floor. All five are commercial acts on an enquiry, so all five
   live here rather than in the Costing workspace.

   ── WHAT THESE ROUTES DO NOT DO ──────────────────────────────────────────
   They release no procurement demand, create no purchase request, send no
   customer approval and touch no Board policy. Approving an estimate says a
   price may be quoted; it does not say an order exists. The customer-facing
   token flow at `/costing-approval/:token` is a separate workflow on a
   separate record and is not reached from here.
════════════════════════════════════════════════════════════════════════════ */

/** GET the review state — read-only, and writes nothing. */
router.get("/:id/costing-estimate/review", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const ctx = await costingCtxFor(req);
    return res.json({
      success: true,
      ...(await commercialReview.stateFor(ctx, {
        enquiryId: req.params.id,
        ...lineFrom(req.query),
      })),
    });
  } catch (err) {
    return sendBriefError(res, err, "GET /:id/costing-estimate/review");
  }
});

/**
 * The four commands, which differ only in which service verb they call.
 *
 * Each names the VERSION it is about. A decision taken on figures somebody
 * read is refused if the estimate has been prepared again since — approving
 * "the latest" would approve figures the approver never saw.
 */
const reviewCommand = (verb, where) => async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const ctx = await costingCtxFor(req);
    const body = req.body || {};
    const out = await commercialReview[verb](ctx, {
      enquiryId: req.params.id,
      ...lineFrom(body),
      versionId: String(body.versionId || "").trim() || null,
      reason: String(body.reason || ""),
      note: String(body.note || ""),
      /* The idempotency anchor, so a retry after a lost response replays the
         decision rather than taking a second one. */
      actionKey: String(req.headers["idempotency-key"] || body.actionKey || ""),
      actor: actor(req),
    });
    return res.json({ success: true, ...out });
  } catch (err) {
    return sendBriefError(res, err, where);
  }
};

router.post("/:id/costing-estimate/submit", salesAuth,
  reviewCommand("submit", "POST /:id/costing-estimate/submit"));

router.post("/:id/costing-estimate/approve", salesAuth,
  reviewCommand("approve", "POST /:id/costing-estimate/approve"));

router.post("/:id/costing-estimate/return", salesAuth,
  reviewCommand("returnToSales", "POST /:id/costing-estimate/return"));

/* The executive door. Same shape, different authority and a mandatory
   reason — enforced in the service, not here. */
router.post("/:id/costing-estimate/exception/approve", salesAuth,
  reviewCommand("approveException", "POST /:id/costing-estimate/exception/approve"));

/**
 * The caller's OWN costing context, resolved the way the costing app resolves
 * it.
 *
 * ── WHY NOT A STUB SET ──────────────────────────────────────────────────────
 * The result projection publishes a cost figure only to a caller holding
 * `costing.cost.read`. Handing it an empty set would withhold everything from
 * everybody — safe, and wrong: a Sales manager who legitimately holds the
 * capability would be shown nothing and would go looking for another way to
 * see it. Handing it a set this file invented would be worse.
 *
 * So it is the real one, from the same resolver `/api/costings` uses. Company
 * membership is proved there too, which is why the company below comes from
 * the resolved context rather than from the request.
 */
/**
 * The grant that lets somebody ASK for an estimate.
 *
 * Deliberately not applied to the GET. Reading where an estimate stands is
 * not preparing one — it writes nothing, and a Sales viewer is entitled to
 * the commercial output their own grant already carries. Gating the read too
 * would hide from a viewer the very number they are allowed to quote.
 */
function assertMayPrepare(ctx) {
  if (ctx?.capabilitySet?.has?.(CAPABILITIES.PREPARE)) return;
  throw costingFail(
    "COSTING_PREPARE_FORBIDDEN",
    "You do not have permission to prepare an estimate for this enquiry.",
    { reason: "PREPARE_NOT_GRANTED", required: CAPABILITIES.PREPARE },
  );
}

async function costingCtxFor(req) {
  const companyContext = require("../../../services/centralCosting/companyContext.service");
  const scope = await salesScopeFor(req);
  const ctx = await companyContext.resolveForActor(req.user, {
    requestedCompanyId: scope.companyId,
  });
  /* Belt and braces: the Sales scope and the costing context must agree about
     which company this is, or one of the two resolved something the other did
     not intend. */
  if (String(ctx.companyId) !== String(scope.companyId)) {
    throw costingFail("TENANT_MISMATCH", "Your company could not be confirmed for this estimate.");
  }
  return ctx;
}

/* One shape for every refusal these three raise: a stable code the screen can
   branch on, and a sentence a person can act on. */
function sendBriefError(res, err, where) {
  if (err?.status && typeof err.toResponse === "function") {
    return res.status(err.status).json(err.toResponse());
  }
  if (err?.code === costingBrief.CODES.NOT_FOUND) {
    return res.status(404).json({ success: false, message: "Not found." });
  }
  if (err?.code) {
    return res.status(err.status && err.status !== 500 ? err.status : 400).json({
      success: false, code: err.code, message: err.message, details: err.details || {},
    });
  }
  console.error(`[enquiries] ${where}`, err);
  return res.status(500).json({ success: false, message: err.message });
}

router.get("/:id/delivery-options", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }))
      .select("accountId").lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });
    const scope = await salesScopeFor(req);
    const [addresses, warehouses] = await Promise.all([
      shippingAddressesFor(scope.companyId, enquiry.accountId),
      Warehouse.find({ companyId: scope.companyId, status: "Active" })
        .select("name shortName addressDetail.city").sort({ name: 1 }).limit(100).lean(),
    ]);
    return res.json({
      success: true,
      shippingAddresses: addresses,
      warehouses: warehouses.map((wh) => ({
        id: String(wh._id),
        label: [wh.name, wh.addressDetail?.city].filter(Boolean).join(" — "),
        code: wh.shortName || "",
      })),
    });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error("[enquiries] GET /:id/delivery-options", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/:id", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const body = req.body || {};
    // Snapshot before any field is touched — multiple departments (Sales,
    // Merchandising, Project Manager) edit this same record, and this is
    // the one route with no log at all until now: it just overwrote fields
    // with only `updatedBy` set. See recordChange() below.
    const before = enquiry.toObject();

    // Enforce the status machine: a status change must be a legal transition.
    // A no-op (same status, e.g. saving other fields) always passes.
    if (typeof body.status === "string" && ENQUIRY_STATUS_CODES.includes(body.status) && body.status !== enquiry.status) {
      const allowed = ENQUIRY_STATUS_TRANSITIONS[enquiry.status] || [];
      if (!allowed.includes(body.status)) {
        return res.status(400).json({ success: false, message: `Can't move an enquiry from "${enquiry.status}" to "${body.status}".` });
      }
    }

    for (const key of EDITABLE) {
      if (!(key in body)) continue;
      if (key === "source" && body.source && !ENQUIRY_SOURCE_CODES.includes(body.source)) continue;
      if (key === "status" && body.status && !ENQUIRY_STATUS_CODES.includes(body.status)) continue;
      if (key === "lostReason" && body.lostReason && !ENQUIRY_LOST_REASON_CODES.includes(body.lostReason)) continue;
      if (key === "priority" && body.priority && !ENQUIRY_PRIORITY_CODES.includes(body.priority)) continue;
      if (key === "seriousness" && body.seriousness && !CUSTOMER_SERIOUSNESS_CODES.includes(body.seriousness)) continue;
      enquiry[key] = body[key] === "" ? undefined : body[key];
    }
    /* ── HOW THIS ORDER IS DELIVERED, AND WHO PAYS ──────────────────────
       An object, not a scalar, so it is validated rather than assigned. Every
       identity is checked against THIS company's records: an address on
       somebody else's account and a warehouse in another company must be
       indistinguishable from ones that do not exist.

       Sales is never asked for freight MONEY here. What is asked for is who
       bears it, where it goes, how it travels and — for a prepaid order —
       whether the company recovers it. The rate comes from Store's register. */
    if ("freight" in body) {
      const f = body.freight || {};
      const next = {};
      /* Absent means "leave it alone"; an explicit empty string is not a
         value either. Nothing here is defaulted into a claim. */
      const present = (v) => v !== null && v !== undefined && v !== "";

      if (present(f.arrangement)) {
        if (!FREIGHT_ARRANGEMENT_CODES.includes(f.arrangement)) {
          return res.status(400).json({ success: false, message: "That is not a delivery arrangement this system recognises." });
        }
        next.arrangement = f.arrangement;
      }
      if (present(f.mode)) {
        if (!["ROAD", "RAIL", "AIR", "SEA", "COURIER"].includes(String(f.mode).toUpperCase())) {
          return res.status(400).json({ success: false, message: "That is not a freight mode this system recognises." });
        }
        next.mode = String(f.mode).toUpperCase();
      }
      if (present(f.shippingAddressId)) {
        if (!isObjectId(f.shippingAddressId)) {
          return res.status(400).json({ success: false, message: "Invalid delivery address." });
        }
        /* ── A SHIPPING ADDRESS, ON A COMPANY-OWNED ACCOUNT ──────────
           Billing and shipping are separate records precisely because they
           differ, and delivering garments to the accounts department is a
           mistake nobody notices until the lorry arrives. The type is
           required; nothing here converts or falls back. */
        const scope = await salesScopeFor(req);
        const { destination, reason, addressType } = await resolveShippingDestination(
          scope.companyId, { addressId: f.shippingAddressId, accountId: enquiry.accountId },
        );
        if (!destination) {
          return res.status(400).json({
            success: false,
            message: reason === SHIPPING_REASON.NOT_SHIPPING
              ? `That is the ${addressType} address. Choose a shipping address, or add one to this customer.`
              : "That delivery address is not on this customer's account.",
          });
        }
        next.shippingAddressId = destination.addressId;
      }
      if (present(f.originWarehouseId)) {
        if (!isObjectId(f.originWarehouseId)) {
          return res.status(400).json({ success: false, message: "Invalid dispatch warehouse." });
        }
        const scope = await salesScopeFor(req);
        const warehouse = await Warehouse.findOne({
          _id: f.originWarehouseId, companyId: scope.companyId, status: "Active",
        }).select("_id").lean();
        if (!warehouse) {
          return res.status(400).json({ success: false, message: "That is not an active warehouse in this company." });
        }
        next.originWarehouseId = warehouse._id;
      }
      if (present(f.deliveryCount)) {
        const n = Number(f.deliveryCount);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ success: false, message: "A delivery count is a whole number of deliveries, at least one." });
        }
        next.deliveryCount = n;
      }
      if (present(f.prepaidTreatment)) {
        if (!["IN_PRICE", "RECOVERED_SEPARATELY"].includes(f.prepaidTreatment)) {
          return res.status(400).json({ success: false, message: "Say whether prepaid freight sits inside the price or is recovered separately." });
        }
        next.prepaidTreatment = f.prepaidTreatment;
      }
      if (present(f.notes)) next.notes = String(f.notes).trim().slice(0, 1000);

      enquiry.freight = { ...(enquiry.freight ? enquiry.freight.toObject?.() ?? enquiry.freight : {}), ...next };
    }

    /* ── WHEN THIS ORDER GETS PAID ────────────────────────────────────────
       Sales is never asked for a financing RATE here, or for an amount. What
       is asked for is the advance, how long the balance runs and what it runs
       from — the facts the company's financing rule has never had.

       `confirm: true` puts them in force. Until then they are a draft, and a
       costing reads an unconfirmed enquiry as unanswered rather than as an
       order paid in cash. */
    if ("paymentTerms" in body) {
      const account = enquiry.accountId
        ? await Account.findOne(await scoped(req, { _id: enquiry.accountId }))
          .select("advancePercent creditDays paymentTermsCode negotiatedTerms").lean()
        : null;
      const existing = enquiry.paymentTerms?.toObject?.() ?? enquiry.paymentTerms ?? null;
      const result = paymentTermsResolution.validate(body.paymentTerms || {}, {
        account,
        confirm: body.paymentTerms?.confirm === true,
        actor: actor(req),
        existing,
      });
      if (!result.ok) {
        /* Named by field, so the screen marks the box rather than the person
           hunting for what went wrong. */
        return res.status(400).json({
          success: false, code: "PAYMENT_TERMS_INVALID",
          field: result.field, message: result.message,
        });
      }
      enquiry.paymentTerms = { ...(existing || {}), ...result.terms };
    }

    // Products is an array — sanitize rather than trust the raw body.
    if ("products" in body) {
      /* ── EVERY LINE KEEPS ITS PERMANENT REFERENCE (G01) ─────────────────
         Each existing row must name the `productLineRef` it was issued; a
         genuinely new row names none and is minted by the model hook. A
         removal is declared in `removedProductLineRefs`, never inferred from
         a row going missing — see reconcileProductLineIdentities for why.
         Anything that cannot be decided for certain is refused BEFORE the
         save, so a refused request changes nothing on the enquiry. */
      const verdict = reconcileProductLineIdentities(
        enquiry.products,
        sanitizeProducts(body.products) || [],
        { removed: body.removedProductLineRefs },
      );
      if (!verdict.ok) {
        const status = verdict.code === "PRODUCT_LINES_STALE" || verdict.code === "PRODUCT_LINE_REF_UNKNOWN" ? 409 : 400;
        return res.status(status).json({
          success: false, code: verdict.code, message: verdict.message, ...verdict.details,
        });
      }
      enquiry.products = verdict.rows;

      // costingSheets is keyed by product NAME (see its own schema comment —
      // sanitizeProducts above discards every product's _id on every save,
      // so name was the one thing that survives a routine edit... except a
      // rename of the product itself, which is exactly a name changing.
      // Without this, renaming "Blazer" to "Blazer V2" left the costing
      // sheet keyed to the now-nonexistent "Blazer" — still alive in Mongo
      // and CoWork, just unreachable from this enquiry's product list, so
      // it silently vanished from the UI. `renames` (optional; sent by the
      // Requirement panel when it detects a same-position name change) lets
      // the sheet follow the rename instead. Only applied when `to` is
      // actually a product on the new list — never rename onto nothing.
      const renames = Array.isArray(body.renames) ? body.renames : [];
      if (renames.length) {
        const newNames = new Set(enquiry.products.map((p) => p.product));
        for (const { from, to } of renames) {
          if (!from || !to || from === to || !newNames.has(to)) continue;
          const sheet = enquiry.costingSheets?.find((s) => s.productName === from);
          if (sheet) sheet.productName = to;
          // The cost ledger is keyed by name for the same reason and breaks the
          // same way — renaming a product would strand its cost and price, and
          // the stage would quietly show an uncosted line for a product that
          // had been costed all along.
          const ledger = enquiry.costLedger?.find((l) => l.productName === from);
          if (ledger) ledger.productName = to;
        }
      }
    }
    // References likewise.
    if ("references" in body) {
      enquiry.references = sanitizeReferences(body.references) || [];
    }

    // Losing an enquiry needs a reason — that's the whole point of recording it.
    if (enquiry.status === "lost" && !enquiry.lostReason) {
      return res.status(400).json({ success: false, message: "A lost enquiry needs a reason." });
    }
    // Clear the lost reason if the enquiry is no longer lost.
    if (enquiry.status !== "lost") {
      enquiry.lostReason = undefined;
      enquiry.lostReasonNote = undefined;
    }

    enquiry.updatedBy = actor(req);
    await enquiry.save();

    // A product-wise requirement row picked from the item master carries that
    // product's stockItemId — so the moment it's saved onto this enquiry, it
    // is a product the account is asking for, and belongs on that account's
    // linked (portal) customer the same way Production registration links one
    // (see routes/CMS_Routes/Sales/sampleStyles.js's POST /:id/production/
    // stock-item) (24 Aug 2026, explicit request: "we are storing the
    // product id in the customer schema... here also need to do the same").
    // Non-blocking — a product row saving must never fail on this.
    //
    // The REVERSE also has to happen (26 Aug 2026, explicit request): a row
    // deleted outright, or unpicked back to free text via the register field's
    // own ✕ (both arrive here as `products` simply no longer containing that
    // stockItemId — this route has no separate "delete" signal), removes the
    // customer link the same way. `before` (captured pre-mutation, above)
    // is what makes the diff possible.
    if ("products" in body && enquiry.accountId) {
      const beforeIds = new Set((before.products || []).filter((p) => p.stockItemId).map((p) => String(p.stockItemId)));
      const afterIds = new Set((enquiry.products || []).filter((p) => p.stockItemId).map((p) => String(p.stockItemId)));
      const toAddIds = [...afterIds].filter((id) => !beforeIds.has(id));
      const removedIds = [...beforeIds].filter((id) => !afterIds.has(id));

      if (toAddIds.length) {
        (async () => {
          const account = await Account.findOne(await scoped(req, { _id: enquiry.accountId })).select("linkedCustomer");
          if (!account?.linkedCustomer) return;
          const customer = await Customer.findById(account.linkedCustomer).select("assignedStockItems");
          if (!customer) return;
          const already = new Set((customer.assignedStockItems || []).map((a) => String(a.stockItemId)));
          const addSet = new Set(toAddIds);
          const toAdd = enquiry.products.filter((p) => p.stockItemId && addSet.has(String(p.stockItemId)) && !already.has(String(p.stockItemId)));
          if (!toAdd.length) return;
          for (const p of toAdd) {
            customer.assignedStockItems.push({
              stockItemId: p.stockItemId, stockItemName: p.product, stockItemReference: p.stockItemReference,
              assignedBy: req.user?.id, assignedByName: req.user?.name,
              notes: `From ${enquiry.enquiryId}'s requirement.`,
            });
          }
          await customer.save();
        })().catch((e) => console.error("[enquiries] product→customer link failed:", e.message));
      }

      if (removedIds.length) {
        unlinkRemovedEnquiryProducts({
          accountId: enquiry.accountId,
          removedStockItemIds: removedIds,
          excludeEnquiryId: enquiry._id,
          companyClause: (await salesScopeFor(req)).clause,
        })
          .catch((e) => console.error("[enquiries] product unlink (PATCH) failed:", e.message));
      }
    }

    // Stage-progressive deal value: the enquiry's opportunity size is the
    // INDICATIVE value at this stage, so mirror it onto the journey's
    // expectedValue with confirmed=false (the header/board reads one number,
    // labelled "estimated"). A firmer number from Cost & Quote later sets
    // confirmed=true and outranks this — so we never overwrite a confirmed value.
    if ("opportunitySize" in body) {
      const journey = await SalesJourney.findOne(await scoped(req, { _id: enquiry.journeyId })).select("expectedValue");
      if (journey && !journey.expectedValue?.confirmed) {
        journey.expectedValue = {
          amount: enquiry.opportunitySize,
          currency: (enquiry.pricingCurrency || "INR").toUpperCase(),
          confirmed: false,
        };
        await journey.save();
      }
    }

    const after = enquiry.toObject();
    const changeBits = summarizeEnquiryChange(before, after);
    recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-enquiry",
      entityId: enquiry._id,
      entityLabel: enquiry.enquiryId,
      action: "update",
      summary: changeBits.length
        ? `${actor(req).name || "Someone"} updated ${enquiry.enquiryId} — ${changeBits.join("; ")}`
        : `${actor(req).name || "Someone"} updated ${enquiry.enquiryId}`,
      before,
      after,
    }).catch(() => {});

    return res.json({ success: true, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] PATCH /:id", err);
    return res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/:id/change-log
// Who changed what on this enquiry, newest first — Sales-auth-gated (unlike
// /api/admin/change-log, which is platform-admin-only and unreachable from a
// CRM screen). Reads the SAME ChangeLog collection recordChange() above and
// the lifecycle-mutation routes below already write to; nothing new to
// maintain, just a CRM-scoped door into it.
router.get("/:id/change-log", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    /* ── THE ENQUIRY IS PROVED VISIBLE BEFORE ITS HISTORY IS READ ────────
       This route reads the change log by entity id and never touched the
       Enquiry, so it answered for another company's enquiry — audit history is
       as confidential as the record it describes, and often more revealing.
       Absent enquiry, absent history: the same answer a missing one gets. */
    const visible = await Enquiry.findOne(await scoped(req, { _id: req.params.id }))
      .select("_id").lean();
    if (!visible) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const entries = await historyFor("crm-enquiry", req.params.id, limit);
    return res.json({ success: true, entries });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /:id/change-log", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/cowork-employees
// The "assign to" candidate list for a new costing sheet — every CoWork
// employee, so the picker can suggest people the same way CoWork's own
// ShareMenu does (Cowork/lib/legacy/employees.ts listMembers(), unrestricted
// to CEO/TL). Queried directly against Firestore rather than proxying that
// route: it requires a Firebase ID token, which a CMS session does not
// carry, and grav-backend already holds the Admin SDK credential for this
// same project — see services/coworkSheets.service.js's own header for why
// that's the established pattern here, not a workaround.
router.get("/cowork-employees", salesAuth, async (req, res) => {
  try {
    const { db } = require("../../../config/firebaseAdmin");
    const snap = await db.collection("cowork_employees").get();
    const employees = snap.docs
      .map((d) => {
        const x = d.data();
        return { employeeId: d.id, name: x.name || d.id, email: x.email || "", role: x.role || "employee" };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ success: true, employees });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /cowork-employees", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/my-pending-count
// "N need your input" — a live, computed count for the Merchandiser/PM nav
// badge (19 Aug 2026), not a stored/mark-as-read notification: how many of
// the caller's own assigned costing sheets (raw-materials or operations) are
// still empty. Always fresh off the same data the costing panel itself
// reads — nothing to keep in sync, nothing to mark seen.
router.get("/my-pending-count", salesAuth, async (req, res) => {
  try {
    const me = await coworkIdentity(req);
    if (!me) return res.json({ success: true, count: 0 });

    const enquiries = await Enquiry.find(await scoped(req, {
      isActive: true,
      "costingSheets.members.employeeId": me.coworkEmployeeId,
    })).select("costingSheets").lean();

    let count = 0;
    for (const enquiry of enquiries) {
      for (const sheet of enquiry.costingSheets || []) {
        const mine = (sheet.members || []).find((m) => m.employeeId === me.coworkEmployeeId);
        if (!canWrite(mine?.role)) continue;
        const part = sheet.part || "combined";
        if (part === "raw" && !(sheet.materials || []).length) count += 1;
        else if (part === "operations" && !(sheet.operations || []).length) count += 1;
        else if (part === "combined" && !(sheet.materials || []).length && !(sheet.operations || []).length) count += 1;
      }
    }

    return res.json({ success: true, count });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /my-pending-count", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Costing sheets ──────────────────────────────────────────────────────────
//
// ONE SHEET PER CONTRIBUTOR (17 Aug 2026). A costing used to be one shared
// document with two tabs, shared with the merchandiser and the industrial
// engineer together — one whole-document set of roles, no per-tab permission —
// so that arrangement could not express who owns what, and either contributor
// could overwrite the other's work with nothing to stop them.
//
// A costing is two row-sets:
//
//   part "raw"         raw materials      merchandiser        = editor
//   part "operations"  operations / CMP   industrial engineer = editor
//
// The other contributor is a viewer on each (an IE reading the fabric costs is
// normal; an IE editing them is not), and the salesperson who raised it owns
// both. Total FOB is not on either sheet on its own — the CMS composes the two
// and totals them (services/costingTotals.js).
//
// NATIVE, NOT COWORK (19 Aug 2026, explicit request). This used to be a
// pointer into a CoWork Firestore workbook — raw items and production cost are
// now defined directly on the Enquiry document itself; see the model's own
// comment on `costingSheets` for why. Rows written before the split have no
// `part` and default to "combined"; every route here still handles them.
const PART_LABEL = { raw: "Raw materials", operations: "Operations", combined: "Costing" };
const PART_ROLE = { raw: "merchandiser", operations: "industrialEngineer" };

// Telling the assignee they have work.
//
// Assignment used to write `costingTeam` and set the CoWork permissions and stop
// there — so the merchandiser or the IE only discovered a sheet was theirs if a
// salesperson messaged them. Web push is what this codebase already has
// (services/NotificationService.js); it no-ops when VAPID is unconfigured, so
// this is best-effort by design and must never fail the assignment.
async function notifyAssignee(assignee, { enquiry, productName, part }) {
  if (!assignee?.employeeId) return;
  const role = ROLE_LABEL[PART_ROLE[part]] || "contributor";
  try {
    await NotificationService.sendToUser(assignee.employeeId, {
      title: `Costing sheet assigned — ${productName}`,
      body: `You are the ${role} on ${enquiry.enquiryId}. Open the sheet to fill it in.`,
      data: { kind: "costing_sheet_assigned", enquiryId: enquiry.enquiryId, productName, part },
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] notifyAssignee", err.message);
  }
}
const ROLE_LABEL = { merchandiser: "merchandiser", industrialEngineer: "industrial engineer" };

/** `{employeeId, name}` or null — anything without an employeeId is nothing. */
/**
 * The costing pair used most recently, anywhere.
 *
 * "Remember who the merchandiser and the IE are" without inventing a settings
 * model or a migration: the answer is already in the data — the last enquiry
 * that had a pair chosen. A fresh enquiry pre-fills from it, so the pair is
 * picked once for the company rather than once per enquiry, and the per-enquiry
 * assign route still overrides it whenever this order needs different people.
 *
 * Deliberately not scoped to the caller: the merchandiser and the IE are the
 * same two people whoever is raising the costing, and scoping it per salesperson
 * would mean the second salesperson picks from scratch for no reason.
 */
async function lastUsedCostingTeam(req, excludeEnquiryId) {
  const q = {
    isActive: true,
    "costingTeam.merchandiser.employeeId": { $exists: true, $ne: "" },
  };
  if (excludeEnquiryId) q._id = { $ne: excludeEnquiryId };
  /* Scoped like everything else: "who did this last" must mean "who did this
     last HERE". Reading another company's costing team would suggest their
     staff as a default on this company's screen. */
  const prev = await Enquiry.findOne(await scoped(req, q))
    .sort({ updatedAt: -1 }).select("costingTeam").lean();
  return prev?.costingTeam || null;
}

function normaliseAssignee(input) {
  const employeeId = String(input?.employeeId || "").trim();
  if (!employeeId) return null;
  return { employeeId, name: String(input?.name || "").trim() };
}

/**
 * The caller's CoWork identity, or null. Every write to a sheet needs one:
 * without it there is no way to say WHO edited, and no way to check whether
 * they were allowed to.
 */
async function coworkIdentity(req) {
  if (!req.user?.id) return null;
  const me = await Employee.findById(req.user.id).select("coworkEmployeeId name email").lean();
  return me?.coworkEmployeeId ? me : null;
}

const NO_COWORK_ACCOUNT = {
  success: false,
  code: "NO_COWORK_ACCOUNT",
  message: "Your account isn't linked to a CoWork identity yet. Ask an administrator to link it on the Access Control page.",
};

const canWrite = (role) => role === "owner" || role === "editor";

// Whose saves apply immediately versus get staged for review (19 Aug 2026).
// Sales raised the enquiry and IS the approver; admin/CEO have standing
// authority above any department. Everyone else who can reach this route —
// concretely, "merchandiser" and "project_manager" — gets staged instead.

/** Clean a client-supplied materials array to the shape the schema accepts. */
function sanitizeMaterialRows(input) {
  return (Array.isArray(input) ? input : []).map((m) => ({
    category: String(m?.category || "").trim(),
    item: String(m?.item || "").trim(),
    // Only present when `item` was picked from the Store raw-item master
    // rather than typed free-text — lets the row's "info" button resolve the
    // full record. Validated rather than trusted blindly since it rides in
    // on client input.
    rawItemId: isObjectId(m?.rawItemId) ? m.rawItemId : null,
    vendor: String(m?.vendor || "").trim(),
    unitCost: m?.unitCost === "" || m?.unitCost == null ? "" : String(m.unitCost),
    unit: String(m?.unit || "").trim(),
    consumption: m?.consumption === "" || m?.consumption == null ? "" : String(m.consumption),
    // Only ever set by the R&D-sample seed below — carried through so a
    // Sales/Merchandiser edit of an already-seeded row doesn't silently drop
    // the provenance figure (empty string means "not from a sample").
    allowancePercent: m?.allowancePercent === "" || m?.allowancePercent == null ? "" : String(m.allowancePercent),
  }));
}

// Same shelf-mapping costingMasters.js uses client-side to open a picker on
// the right category — duplicated here (no shared lib between the two repos'
// route/lib files) so a seeded row lands in a real costing category instead
// of an empty one the grouped table can't place.
const RAW_MATERIAL_CATEGORY_MAP = {
  Fabric: ["Fabric"],
  Thread: ["Thread"],
  Button: ["Buttons", "Fasteners"],
  Fusing: ["Interlining"],
  "Trims & Accessory": [
    "Trims", "Accessories", "Elastic", "Zippers", "Laces",
    "Ribbons", "Cords", "Tapes", "Piping", "Webbing", "Labels",
  ],
  "Packing Materials": ["Packaging"],
};
function costingCategoryFor(rawItemCategory) {
  const want = String(rawItemCategory || "").trim();
  if (!want) return "Trims & Accessory";
  for (const [costingCategory, masterCategories] of Object.entries(RAW_MATERIAL_CATEGORY_MAP)) {
    if (masterCategories.includes(want)) return costingCategory;
  }
  return "Trims & Accessory";
}

/**
 * The raw-materials starting point for a brand-new costing sheet: whatever
 * R&D actually consumed making the approved sample, not a blank table.
 * Merchandising still has to pick a vendor (and so a price) per row — this
 * only carries over WHAT was used and HOW MUCH, straight from the sample
 * that Sales already signed off (20 Aug 2026, explicit request).
 *
 * Returns [] when there's no approved sample for this product, or it left
 * nothing consumed — the sheet then starts exactly as blank as it always did.
 */
async function seedMaterialsFromApprovedSample(enquiryId, productName) {
  const style = await SampleStyle.findOne({
    enquiryId, productName, "sample.status": "approved",
  }).select("sample.consumptionRawItems").lean();
  const rows = style?.sample?.consumptionRawItems || [];
  if (!rows.length) return [];

  const ids = rows.map((r) => r.rawItemId).filter(Boolean);
  const items = ids.length
    ? await RawItem.find({ _id: { $in: ids } }).select("category customCategory").lean()
    : [];
  const categoryById = new Map(items.map((it) => [String(it._id), it.customCategory || it.category || ""]));

  return rows
    .filter((r) => r.rawItemName && Number(r.quantity) > 0)
    .map((r) => {
      const allowance = Number(r.allowancePercent) || 0;
      const consumption = Number(r.quantity) * (1 + allowance / 100);
      return {
        category: costingCategoryFor(categoryById.get(String(r.rawItemId)) || ""),
        item: r.rawItemName,
        vendor: (r.variantCombination || []).filter(Boolean).join(" / "),
        unitCost: "",
        unit: r.unit || "",
        consumption: String(Math.round(consumption * 10000) / 10000),
        allowancePercent: String(allowance),
      };
    });
}
/**
 * The product's linked StockItem's raw items and operations, read RIGHT NOW
 * and shaped as costing-sheet rows — the "directly connected" half of the
 * costing rebuild (24 Aug 2026, explicit request: "wherever the raw items,
 * operations are defined, so basically as the product is also created in the
 * stock item and linked to here so if anyone change the raw items or like
 * operations and all then it will also change over here also... as it is
 * directly connected"). Deliberately NOT a live join at read-time — a
 * costing sheet keeps storing its own snapshot rows exactly as it always
 * has, the same "auto suggest, then fill/adjust, then overwrite" shape
 * already used for Materials → R&D consumption (sampleStyles.js's
 * `syncMaterialsRawItems`) — the caller pulls this explicitly (see the
 * stock-item-sync route below) and merges it into the sheet before saving,
 * so a sheet raised before a StockItem existed, or for a product with no
 * link at all, keeps working completely unchanged.
 *
 * A StockItem's rawItems are per-VARIANT; a costing sheet is per-PRODUCT, so
 * rows are deduped across variants by raw item + variant combination — a
 * lining fabric common to every size contributes one row, not one per size.
 */
async function stockItemCostingRows(stockItemId) {
  const stockItem = await StockItem.findById(stockItemId).select("variants operations").lean();
  if (!stockItem) return { materials: [], operations: [] };

  const rawIds = new Set();
  for (const v of stockItem.variants || []) {
    for (const r of v.rawItems || []) if (r.rawItemId) rawIds.add(String(r.rawItemId));
  }
  const catalog = rawIds.size
    ? await RawItem.find({ _id: { $in: [...rawIds] } }).select("category customCategory").lean()
    : [];
  const categoryById = new Map(catalog.map((it) => [String(it._id), it.customCategory || it.category || ""]));

  const seen = new Map();
  for (const v of stockItem.variants || []) {
    for (const r of v.rawItems || []) {
      if (!r.rawItemName) continue;
      const key = `${r.rawItemId || r.rawItemName}::${(r.variantCombination || []).join("/")}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        category: costingCategoryFor(categoryById.get(String(r.rawItemId)) || ""),
        item: r.rawItemName,
        rawItemId: r.rawItemId || null,
        vendor: (r.variantCombination || []).filter(Boolean).join(" / "),
        unitCost: "",
        unit: r.unit || "",
        consumption: r.quantity != null ? String(r.quantity) : "",
        allowancePercent: r.allowancePercent != null ? String(r.allowancePercent) : "",
      });
    }
  }

  // sam (minutes) × rate (cost/min) is how the costing model recomputes an
  // operation's per-piece cost (costingModel.js's `opOf`) — deriving rate as
  // operatorCost ÷ sam here means that multiplication reproduces the exact
  // operatorCost the stock item's own operation register already settled on.
  const operations = (stockItem.operations || [])
    .filter((o) => o.type)
    .map((o) => {
      const sam = Math.round(((Number(o.minutes) || 0) + (Number(o.seconds) || 0) / 60) * 10000) / 10000;
      const rate = sam > 0 && Number(o.operatorCost) > 0 ? Math.round((Number(o.operatorCost) / sam) * 10000) / 10000 : "";
      return {
        detail: [o.operationCode, o.type].filter(Boolean).join(" — "),
        sam: sam ? String(sam) : "",
        rate: rate === "" ? "" : String(rate),
      };
    });

  return { materials: [...seen.values()], operations };
}

/** Clean a client-supplied operations array to the shape the schema accepts. */
function sanitizeOperationRows(input) {
  return (Array.isArray(input) ? input : []).map((o) => ({
    detail: String(o?.detail || "").trim(),
    sam: o?.sam === "" || o?.sam == null ? "" : String(o.sam),
    rate: o?.rate === "" || o?.rate == null ? "" : String(o.rate),
  }));
}
/** Clean a client-supplied miscellaneous array to the shape the schema accepts. */
function sanitizeMiscRows(input) {
  return (Array.isArray(input) ? input : []).map((x) => ({
    name: String(x?.name || "").trim(),
    price: x?.price === "" || x?.price == null ? "" : String(x.price),
  }));
}

// POST /api/cms/crm/enquiries/:id/costing-sheet
// Raise the costing for one product: creates BOTH row-sets (empty, ready to
// fill in) and hands each to the person responsible for it. Creating again for
// the same product REPLACES the costingSheets entries rather than editing the
// old ones in place.
/* ── THE LEGACY SHEET IS READ-ONLY NOW ──────────────────────────────────────
 *
 * `POST /:id/costing-sheet`, `PATCH .../assign`, `PATCH .../members`,
 * `PATCH .../:productName/data` and `POST .../change/:changeId/decide` created
 * and edited costing calculations on the enquiry, and membership on them
 * decided cost visibility: `crmCostVisibility.costingTier` gives a sheet
 * owner or editor the FULL build-up — materials, operations, unit costs — and
 * the assign door let a Sales user grant themselves that role.
 *
 * Two problems, and they compound. Sales must not see cost, and no new
 * calculation should be recorded anywhere but Central Costing, whose floor the
 * Board controls.
 *
 * So the write doors refuse. Records already recorded stay loadable for a
 * reader who is authorised for cost — losing the company's own history is not
 * an improvement — and nothing new joins them.
 */
const legacySheetRetired = (what) => (req, res) => res.status(410).json({
  success: false,
  error: {
    code: "COSTING_SHEET_RETIRED",
    message: `${what} is no longer recorded on the enquiry. Costing is prepared by Central Costing, `
      + "and the price to quote from is the floor it calculates.",
    details: { reason: "MOVED_TO_CENTRAL_COSTING" },
  },
  message: `${what} is no longer recorded on the enquiry.`,
});

router.post("/:id/costing-sheet", salesAuth, legacySheetRetired("A costing sheet"));

/* Retired — kept for reference; the refusal above answers first. */
router.post("/:id/costing-sheet", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = String(req.body?.productName || "").trim();
    if (!productName) return res.status(400).json({ success: false, message: "productName is required." });
    const product = (enquiry.products || []).find((p) => p.product === productName);
    if (!product) return res.status(404).json({ success: false, message: "No product with that name on this enquiry." });

    // The creator must be a real employee with a stable identity to record as
    // the sheet's owner — the same link Access Control's "CoWork account"
    // control establishes (Employee.coworkEmployeeId), kept as the identity
    // scheme for costing membership even though the sheet itself is native.
    const me = await coworkIdentity(req);
    if (!me) return res.status(409).json(NO_COWORK_ACCOUNT);

    // Who fills which sheet. Explicit on the request wins; otherwise the team
    // already chosen for this enquiry, so raising the costing for the second
    // and third product does not mean picking the same two people again.
    // Explicit on the request wins; then the pair already on this enquiry; then
    // the pair used most recently on any enquiry. The last step is what makes
    // this "chosen once" instead of "chosen every time" — before it, every new
    // enquiry started blank even though the answer had not changed in months.
    const remembered = await lastUsedCostingTeam(req, enquiry._id);
    const team = {
      merchandiser:
        normaliseAssignee(req.body?.merchandiser)
        || normaliseAssignee(enquiry.costingTeam?.merchandiser)
        || normaliseAssignee(remembered?.merchandiser),
      industrialEngineer:
        normaliseAssignee(req.body?.industrialEngineer)
        || normaliseAssignee(enquiry.costingTeam?.industrialEngineer)
        || normaliseAssignee(remembered?.industrialEngineer),
    };
    if (team.merchandiser && team.merchandiser.employeeId === team.industrialEngineer?.employeeId) {
      return res.status(400).json({
        success: false,
        message: "The merchandiser and the industrial engineer have to be two different people — one person cannot hold both sheets.",
      });
    }

    const plan = [
      { part: "raw", assignee: team.merchandiser, other: team.industrialEngineer },
      { part: "operations", assignee: team.industrialEngineer, other: team.merchandiser },
    ];

    const created = [];
    for (const step of plan) {
      // The person responsible edits; the other contributor reads. Sharing the
      // counterpart as a viewer is deliberate — costing decisions reference each
      // other constantly, and making people ask for access to LOOK is how a
      // costing ends up copy-pasted into a chat message.
      const members = [{ employeeId: me.coworkEmployeeId, name: me.name || "", role: "owner" }];
      if (step.assignee && step.assignee.employeeId !== me.coworkEmployeeId) {
        members.push({ employeeId: step.assignee.employeeId, name: step.assignee.name, role: "editor" });
      }
      if (step.other && step.other.employeeId !== me.coworkEmployeeId
          && step.other.employeeId !== step.assignee?.employeeId) {
        members.push({ employeeId: step.other.employeeId, name: step.other.name, role: "viewer" });
      }

      created.push({
        productName,
        part: step.part,
        assignee: step.assignee || undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: actor(req),
        members,
        // The merchandiser's sheet starts from what R&D actually consumed on
        // the approved sample, not blank — see the function's own comment.
        materials: step.part === "raw" ? await seedMaterialsFromApprovedSample(enquiry._id, productName) : [],
        operations: [],
        miscellaneous: [],
      });
    }

    enquiry.costingSheets = [
      ...(enquiry.costingSheets || []).filter((s) => s.productName !== productName),
      ...created,
    ];
    if (team.merchandiser || team.industrialEngineer) {
      enquiry.costingTeam = {
        merchandiser: team.merchandiser || enquiry.costingTeam?.merchandiser,
        industrialEngineer: team.industrialEngineer || enquiry.costingTeam?.industrialEngineer,
      };
    }
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    // Best-effort, after the write has landed: whoever now holds a sheet gets
    // told. Not awaited into the response path beyond this point.
    for (const step of plan) {
      await notifyAssignee(step.assignee, { enquiry, productName: product?.product || "", part: step.part });
    }

    return res.status(201).json({ success: true, costingSheets: created, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /:id/costing-sheet", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/:id/costing-sheet/:productName/stock-item-sync
// Preview of what the product's linked StockItem's raw items and operations
// look like RIGHT NOW, shaped as costing rows. The client merges these into
// its materials/operations state (letting the person filling the sheet
// adjust vendor/unitCost/rate, and add more) and saves through the normal
// PATCH — this route only reads, it never writes the sheet itself.
router.get("/:id/costing-sheet/:productName/stock-item-sync", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true })).select("products").lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });
    const product = (enquiry.products || []).find((p) => p.product === req.params.productName);
    if (!product) return res.status(404).json({ success: false, message: "No product with that name on this enquiry." });
    if (!product.stockItemId) {
      return res.status(404).json({ success: false, message: "This product isn't linked to a stock item yet." });
    }

    const rows = await stockItemCostingRows(product.stockItemId);
    return res.json({ success: true, ...rows });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /:id/costing-sheet/:productName/stock-item-sync", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/enquiries/:id/costing-sheet/assign
// Change who holds a sheet — the "who is the merchandiser, who is the IE"
// control, after the fact. Makes the new person that sheet's editor, records
// them as its assignee, and remembers the pair on the enquiry.
//
// The previous holder is NOT removed. Demoting someone who has been working in
// a sheet, silently, from a screen they cannot see is worse than one extra
// person retaining access; if they should be off it, that is a deliberate act
// through the members route.
router.patch("/:id/costing-sheet/assign", salesAuth, legacySheetRetired("Costing-sheet assignment"));

/* Retired — kept for reference; the refusal above answers first. */
router.patch("/:id/costing-sheet/assign", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = String(req.body?.productName || "").trim();
    if (!productName) return res.status(400).json({ success: false, message: "productName is required." });

    const wanted = {
      merchandiser: normaliseAssignee(req.body?.merchandiser),
      industrialEngineer: normaliseAssignee(req.body?.industrialEngineer),
    };
    if (!wanted.merchandiser && !wanted.industrialEngineer) {
      return res.status(400).json({ success: false, message: "Name a merchandiser, an industrial engineer, or both." });
    }
    if (wanted.merchandiser && wanted.industrialEngineer
        && wanted.merchandiser.employeeId === wanted.industrialEngineer.employeeId) {
      return res.status(400).json({
        success: false,
        message: "The merchandiser and the industrial engineer have to be two different people — one person cannot hold both sheets.",
      });
    }

    const sheets = (enquiry.costingSheets || []).filter((s) => s.productName === productName);
    if (!sheets.length) return res.status(404).json({ success: false, message: "No costing sheet exists yet for that product." });

    const changed = [];
    for (const sheet of sheets) {
      const part = sheet.part || "combined";
      const role = PART_ROLE[part];
      const person = role ? wanted[role] : null;
      if (!person) continue;

      const others = (sheet.members || []).filter((m) => m.employeeId !== person.employeeId);
      sheet.members = [...others, { employeeId: person.employeeId, name: person.name, role: "editor" }];
      sheet.assignee = person;
      changed.push({ part, assignee: person });
    }
    if (!changed.length) {
      return res.status(400).json({
        success: false,
        message: "This product's costing is a single pre-split sheet, so there is no separate merchandiser and IE sheet to reassign. Raise the costing again to split it.",
      });
    }

    enquiry.costingTeam = {
      merchandiser: wanted.merchandiser || enquiry.costingTeam?.merchandiser,
      industrialEngineer: wanted.industrialEngineer || enquiry.costingTeam?.industrialEngineer,
    };
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    // Reassignment is the other moment a sheet changes hands. Same best-effort
    // notice, so the new holder is not left to be told by hand.
    for (const c of changed) {
      await notifyAssignee(c.assignee, { enquiry, productName, part: c.part });
    }

    return res.json({ success: true, changed, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] PATCH /:id/costing-sheet/assign", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/enquiries/:id/costing-sheet/members
// Add (or change the role of) one OR MORE people on an ALREADY-CREATED
// costing sheet, in one request — the multi-person case: a sales person
// assigning a whole team to a sheet at once, not just at creation time.
// Accepts either `{members:[{employeeId,name,role}, ...]}` or a single
// `{employeeId,name,role}` for convenience. Writes the sheet's own `members`
// array directly — there is no second copy of it to keep in step anymore.
//
// `part` picks one of the product's sheets; omitting it applies the change to
// every sheet of that product, which is what "give my manager access to this
// costing" actually means.
router.patch("/:id/costing-sheet/members", salesAuth, legacySheetRetired("Costing-sheet membership"));

/* Retired — kept for reference; the refusal above answers first. */
router.patch("/:id/costing-sheet/members", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = String(req.body?.productName || "").trim();
    if (!productName) return res.status(400).json({ success: false, message: "productName is required." });
    const part = String(req.body?.part || "").trim();

    const raw = Array.isArray(req.body?.members)
      ? req.body.members
      : req.body?.employeeId
        ? [{ employeeId: req.body.employeeId, name: req.body.name, role: req.body.role }]
        : [];
    if (!raw.length) return res.status(400).json({ success: false, message: "At least one member is required." });

    const additions = raw.map((m) => ({
      employeeId: String(m?.employeeId || "").trim(),
      name: m?.name || "",
      role: m?.role,
    }));
    for (const m of additions) {
      if (!m.employeeId) return res.status(400).json({ success: false, message: "Every member needs an employeeId." });
      if (!SHARE_ROLES.has(m.role)) return res.status(400).json({ success: false, message: `Unknown share role: ${m.role}` });
    }

    const targets = (enquiry.costingSheets || []).filter(
      (s) => s.productName === productName && (!part || (s.part || "combined") === part),
    );
    if (!targets.length) {
      return res.status(404).json({
        success: false,
        message: part
          ? `No ${PART_LABEL[part] || part} sheet exists yet for that product.`
          : "No costing sheet exists yet for that product.",
      });
    }

    const addedIds = new Set(additions.map((m) => m.employeeId));
    for (const sheet of targets) {
      sheet.members = [...(sheet.members || []).filter((m) => !addedIds.has(m.employeeId)), ...additions];
    }
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    return res.json({ success: true, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] PATCH /:id/costing-sheet/members", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/:id/costing-sheet/:productName/data
// The actual rows of a product's costing — every part of it — natively, so the
// CMS renders it as a real table on the journey page. Reading doesn't require
// the viewer's own linked identity, so anyone who can see this enquiry can READ
// its costing.
//
// WHO MAY EDIT (19 Aug 2026, explicit request). Merchandiser and Project
// Manager/IE are open to fill ANY part of the costing — `canEdit` is simply
// `true` for them, no per-document role check. What used to be that check is
// now what decides whether their save applies immediately or is staged for
// Sales to approve — see the PATCH below and `pendingChanges` here, which
// carries whatever of THEIR OWN submissions on this sheet are still
// awaiting a decision, so they aren't left wondering if it was lost.
router.get("/:id/costing-sheet/:productName/data", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }))
      .select("costingSheets costingChangeLog ownerId").lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = decodeURIComponent(req.params.productName);
    const sheets = (enquiry.costingSheets || []).filter((s) => s.productName === productName);
    if (!sheets.length) return res.status(404).json({ success: false, message: "No costing sheet exists yet for that product." });

    const me = await coworkIdentity(req);
    const open = !bypassesApproval(req.user);

    const parts = sheets.map((sheet) => {
      const mine = me ? (sheet.members || []).find((m) => m.employeeId === me.coworkEmployeeId) : null;
      return {
        part: sheet.part || "combined",
        title: PART_LABEL[sheet.part || "combined"] || "",
        assignee: sheet.assignee || null,
        members: sheet.members || [],
        materials: sheet.materials || [],
        operations: sheet.operations || [],
        miscellaneous: sheet.miscellaneous || [],
        updatedAt: sheet.updatedAt || null,
        missing: false,
        myRole: mine?.role || null,
        canEdit: open || canWrite(mine?.role),
      };
    });

    // Pending review queue for this sheet — everyone sees it (Sales reviews
    // it here; a Merchandiser/IE sees their own submission is still pending
    // rather than silently gone). Approved/rejected entries aren't returned —
    // once decided they're history, not a working queue.
    const pendingChanges = (enquiry.costingChangeLog || [])
      .filter((c) => c.productName === productName && c.status === "pending")
      .map((c) => ({
        id: String(c._id),
        part: c.part || "combined",
        materials: c.materials?.length ? c.materials : undefined,
        operations: c.operations?.length ? c.operations : undefined,
        miscellaneous: c.miscellaneous?.length ? c.miscellaneous : undefined,
        submittedBy: c.submittedBy || null,
        submittedAt: c.submittedAt || null,
      }));

    // ── Reduce to what this caller is allowed (see costingTier) ────────────
    // Merchandiser/IE are never wall-gated — "anyone can fill anything" means
    // full sheet access for them regardless of whether they hold a role on
    // any specific document. `costingTier`'s owner/manager gate is what
    // still protects the SALES side from an unassigned colleague browsing in.
    const bestRole = parts.reduce(
      (best, p) => (p.myRole === "owner" ? "owner" : p.myRole === "editor" && best !== "owner" ? "editor" : best),
      null,
    );
    // `open` (merchandiser / IE — anyone who does not bypass approval) no
    // longer means "see the whole workbook". They get the sheet tier, but only
    // for the parts they hold; someone with no part on this product gets the
    // floor like everyone else. That is the change from "anyone can fill
    // anything" to "each discipline sees its own part".
    const rawTier = open ? "sheet" : costingTier(req.user, bestRole);
    const mine = visibleParts(parts, me, rawTier === "cost");
    const tier = rawTier === "sheet" && mine.length === 0 ? "floor" : rawTier;

    // TOTALS ARE ALWAYS COMPUTED FROM EVERY PART, never from the visible ones:
    // the floor price is a fact about the whole garment, and an industrial
    // engineer who could see it derived from operations alone would be reading
    // a number that is wrong AND that leaks the shape of their own half.
    const totals = costingTotals(parts, await markupPercent());

    if (tier !== "sheet") {
      // Rows never leave the server for these callers. What they get is the
      // answer, not the working: a floor price, plus cost per piece only for
      // admin/CEO. Nobody in Sales reaches the cost tier any more.
      //
      // `pendingChanges` still goes out here (19 Aug 2026, bug fix). This
      // branch is only ever reached by a caller `bypassesApproval` already
      // let through (`open` was false to land here at all — see above), and
      // the decide route below authorises exactly that same check with no
      // tier or ownership condition. Leaving pendingChanges out of THIS
      // response meant any Sales viewer who wasn't the deal owner or a
      // manager could approve/reject via the API but never see there was
      // anything to decide — the review UI had nothing to show.
      return res.json({
        success: true,
        tier,
        linked: Boolean(me),
        /* ── NO SECOND FLOOR IS PUBLISHED ANY MORE ─────────────────────
           This used to answer `{ costed, floorPrice, markupPercent }` for
           every caller below the cost tier, computed by `costingTotals` from
           `CRMSettings.commercial.markupPct` — a Sales setting defaulting to
           22% that no Board approved. Two floor authorities for one garment
           is one too many, and the one somebody quotes from has to be the one
           management decided.

           The COST tier still gets its own build-up: this route remains the
           reader for sheets recorded before Central Costing, and a
           historical record has to stay readable. What it no longer does is
           hand anybody a price to quote from. */
        summary: tier === "cost"
          ? totals
          : { costed: totals.costed, floorSource: "CENTRAL_COSTING" },
        parts: parts.map((p) => ({
          part: p.part,
          title: p.title,
          assignee: p.assignee,
          updatedAt: p.updatedAt,
          missing: p.missing,
          myRole: p.myRole,
          canEdit: false,
        })),
        pendingChanges,
      });
    }

    // `mine`, not `parts`: the sheet tier now means "the parts you hold", so
    // the rows for a part this caller has no role on never leave the server.
    // `summary` stays whole-garment (see the note above the totals call).
    return res.json({
      success: true,
      tier,
      summary: totals,
      parts: mine,
      linked: Boolean(me),
      pendingChanges,
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /:id/costing-sheet/:productName/data", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/enquiries/:id/costing-sheet/:productName/data
// Save an edit made on the CMS's own costing form — natively, onto this
// sheet's `materials`/`operations`/`miscellaneous` rows.
//
// TWO PATHS (19 Aug 2026, explicit request — replaces the old per-document
// owner/editor gate entirely):
//
//   Sales / admin / CEO   → applies immediately, straight onto `costingSheets`.
//                           `expectedUpdatedAt` still guards two people saving
//                           the same sheet minutes apart — a real 409, not a
//                           silent overwrite.
//   Merchandiser / IE     → NEVER writes `costingSheets` directly. The
//                           submission is appended to `costingChangeLog` as a
//                           `status: "pending"` entry instead — no permission
//                           check beyond "is this a real, identifiable
//                           person" (anyone in either role can propose a
//                           change to any part of any product's costing).
//                           Sales approves or rejects it below.
router.patch("/:id/costing-sheet/:productName/data", salesAuth, legacySheetRetired("Editing a costing sheet"));

/* Retired — kept for reference; the refusal above answers first. */
router.patch("/:id/costing-sheet/:productName/data", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = decodeURIComponent(req.params.productName);
    const part = String(req.body?.part || "combined").trim();
    const sheet = (enquiry.costingSheets || []).find(
      (s) => s.productName === productName && (s.part || "combined") === part,
    );
    if (!sheet) {
      return res.status(404).json({
        success: false,
        message: `No ${PART_LABEL[part] || part} sheet exists yet for that product.`,
      });
    }

    const me = await coworkIdentity(req);
    if (!me) return res.status(409).json(NO_COWORK_ACCOUNT);

    // ── Merchandiser / IE: stage it, never write live ──────────────────────
    if (!bypassesApproval(req.user)) {
      const materials = Array.isArray(req.body?.materials) ? sanitizeMaterialRows(req.body.materials) : undefined;
      const operations = Array.isArray(req.body?.operations) ? sanitizeOperationRows(req.body.operations) : undefined;
      const miscellaneous = Array.isArray(req.body?.miscellaneous) ? sanitizeMiscRows(req.body.miscellaneous) : undefined;
      if (!materials && !operations && !miscellaneous) {
        return res.status(400).json({ success: false, message: "Nothing to submit." });
      }

      enquiry.costingChangeLog = [
        ...(enquiry.costingChangeLog || []),
        {
          productName,
          part,
          materials,
          operations,
          miscellaneous,
          status: "pending",
          submittedBy: actor(req),
          submittedAt: new Date(),
        },
      ];
      await enquiry.save();

      const proposedChangeBits = summarizeCostingSheetChange(
        { materials: sheet.materials, operations: sheet.operations, miscellaneous: sheet.miscellaneous },
        { materials, operations, miscellaneous },
      );
      recordChange(req, {
        departmentSlug: req.user?.role === "project_manager" ? "project-manager" : "merchandiser",
        entity: "crm-enquiry",
        entityId: enquiry._id,
        entityLabel: enquiry.enquiryId,
        action: "costing-proposed",
        summary: `${actor(req).name || "Someone"} proposed ${PART_LABEL[part] || part} costing changes for "${productName}"${proposedChangeBits ? ` — ${proposedChangeBits}` : ""} — awaiting Sales review`,
        after: { productName, part, materials, operations, miscellaneous },
      }).catch(() => {});

      return res.status(202).json({
        success: true,
        pending: true,
        message: "Submitted for approval — your sales contact will review it.",
      });
    }

    // ── Sales / admin / CEO: applies immediately ───────────────────────────
    const expected = req.body?.expectedUpdatedAt ? new Date(req.body.expectedUpdatedAt).getTime() : null;
    const current = sheet.updatedAt ? new Date(sheet.updatedAt).getTime() : null;
    if (expected != null && current != null && expected !== current) {
      return res.status(409).json({
        success: false,
        code: "CONFLICT",
        message: "Someone changed this sheet since it was loaded. Reload to pick up their edits before saving yours.",
      });
    }

    const before = { materials: sheet.materials, operations: sheet.operations, miscellaneous: sheet.miscellaneous };
    if (Array.isArray(req.body?.materials)) sheet.materials = sanitizeMaterialRows(req.body.materials);
    if (Array.isArray(req.body?.operations)) sheet.operations = sanitizeOperationRows(req.body.operations);
    if (Array.isArray(req.body?.miscellaneous)) sheet.miscellaneous = sanitizeMiscRows(req.body.miscellaneous);
    sheet.updatedAt = new Date();
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    const costingAfter = { materials: sheet.materials, operations: sheet.operations, miscellaneous: sheet.miscellaneous };
    const costingChangeBits = summarizeCostingSheetChange(before, costingAfter);
    recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-enquiry",
      entityId: enquiry._id,
      entityLabel: enquiry.enquiryId,
      action: "costing-updated",
      summary: `${actor(req).name || "Sales"} updated the ${PART_LABEL[part] || part} costing for "${productName}"${costingChangeBits ? ` — ${costingChangeBits}` : ""}`,
      before,
      after: costingAfter,
    }).catch(() => {});

    return res.json({ success: true, updatedAt: sheet.updatedAt });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] PATCH /:id/costing-sheet/:productName/data", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/enquiries/:id/costing-sheet/:productName/change/:changeId/decide
// Sales/admin/CEO approves or rejects one pending change-log entry. Approve
// copies whichever field(s) the entry carries onto the real costingSheets
// row-set; reject just marks it decided and changes nothing live.
router.post("/:id/costing-sheet/:productName/change/:changeId/decide", salesAuth, legacySheetRetired("Deciding a costing-sheet change"));

/* Retired — kept for reference; the refusal above answers first. */
router.post("/:id/costing-sheet/:productName/change/:changeId/decide", salesAuth, async (req, res) => {
  try {
    if (!bypassesApproval(req.user)) {
      return res.status(403).json({ success: false, message: "Only Sales, an admin or the CEO can decide a submitted change." });
    }
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = decodeURIComponent(req.params.productName);
    const decision = String(req.body?.decision || "").trim();
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ success: false, message: 'decision must be "approve" or "reject".' });
    }

    const entry = (enquiry.costingChangeLog || []).id(req.params.changeId);
    if (!entry || entry.productName !== productName) {
      return res.status(404).json({ success: false, message: "That submitted change could not be found." });
    }
    if (entry.status !== "pending") {
      return res.status(400).json({ success: false, message: `This change was already ${entry.status}.` });
    }

    if (decision === "approve") {
      const part = entry.part || "combined";
      const sheet = (enquiry.costingSheets || []).find(
        (s) => s.productName === productName && (s.part || "combined") === part,
      );
      if (!sheet) {
        return res.status(404).json({ success: false, message: "The sheet this change targets no longer exists." });
      }
      if (entry.materials?.length) sheet.materials = entry.materials;
      if (entry.operations?.length) sheet.operations = entry.operations;
      if (entry.miscellaneous?.length) sheet.miscellaneous = entry.miscellaneous;
      sheet.updatedAt = new Date();
    }

    entry.status = decision === "approve" ? "approved" : "rejected";
    entry.decidedBy = actor(req);
    entry.decidedAt = new Date();
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-enquiry",
      entityId: enquiry._id,
      entityLabel: enquiry.enquiryId,
      action: decision === "approve" ? "costing-approved" : "costing-rejected",
      summary: `${actor(req).name || "Sales"} ${decision === "approve" ? "approved" : "rejected"} ${entry.submittedBy?.name || "a"}'s proposed ${PART_LABEL[entry.part || "combined"] || entry.part} costing changes for "${productName}"`,
    }).catch(() => {});

    return res.json({ success: true, status: entry.status, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /:id/costing-sheet/:productName/change/:changeId/decide", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Costing lifecycle — sent to customer, customer approval, stock-item
// request (20 Aug 2026) — see the model's own comment on costingLifecycle
// for why this is a separate array keyed by product name. Three small
// actions, no state machine to enforce between them (any can be re-fired —
// e.g. sending again after a spec change) beyond what the route itself needs.

function findOrCreateLifecycle(enquiry, productName) {
  enquiry.costingLifecycle = enquiry.costingLifecycle || [];
  let entry = enquiry.costingLifecycle.find((c) => c.productName === productName);
  if (!entry) {
    entry = { productName };
    enquiry.costingLifecycle.push(entry);
    entry = enquiry.costingLifecycle[enquiry.costingLifecycle.length - 1];
  }
  return entry;
}

// POST /api/cms/crm/enquiries/:id/products/:productName/send-to-customer
// PATCH /api/cms/crm/enquiries/:id/products/:productName/cost-ledger
//
// The one figure Sales reads off the costing workbook's Master tab, and the
// price they decided to quote. Replaces the localStorage the Cost & Invoicing
/**
 * MAY A SELLING PRICE BE SET FOR THIS PRODUCT YET?
 *
 * Three things have to be true, and each is read from the record that owns it
 * rather than decided here: Sales has confirmed a commercial quantity, the
 * costing underneath it is running for THAT quantity, and an approved version
 * has produced a floor for it.
 *
 * The refusal names which one is missing, because "not yet" is not something
 * anybody can act on and "confirm the quantity first" is.
 */
/* The commercial line is resolved by `lineReadiness.lineOn` — one place,
   because two versions of "which line is this" drifted apart before. */

async function sellingPriceGateFor(enquiry, productName, key = {}) {
  /* ── ASKED, NOT RESTATED ──────────────────────────────────────────────
     This used to resolve the line itself and then accept ANY floor on the
     approved version — so a floor calculated for 500 satisfied a line
     confirmed at 750. The same question is asked by the proforma command,
     and two versions of it drifted apart exactly that way. One authority
     now; this maps its reasons onto the codes this door already published. */
  const ready = await lineReadiness.readinessFor(
    { companyId: enquiry.companyId }, enquiry, { ...key, productName },
  );
  if (ready.ok) return { ok: true };
  return {
    ok: false,
    reason: ready.reason === lineReadiness.REASON.LINE_NOT_FOUND
      ? "QUANTITY_NOT_CONFIRMED"
      : ready.reason,
    message: ready.reason === lineReadiness.REASON.LINE_NOT_FOUND
      ? "Confirm the commercial quantity before setting the selling price."
      : ready.message,
  };
}

// stage used to keep this in — see the model's `costLedger` comment.
//
// Upsert by product name. Sending only one of the two leaves the other alone:
// keying a cost and deciding a price are separate acts, minutes or days apart,
// and a partial save must not blank the half that is already right.
/**
 * PATCH /api/cms/crm/enquiries/:id/cost-ledger/line
 *
 * THE SELLING PRICE FOR ONE COMMERCIAL LINE.
 *
 * ── WHY THIS EXISTS BESIDE THE NAMED ROUTE ──────────────────────────────────
 * The route below addresses a ledger row by PRODUCT NAME, and the stored row is
 * keyed by that name. Two colourways of one garment therefore shared a single
 * row: pricing the second overwrote the first, and the floor each was judged
 * against came from whichever commercial line happened to match first.
 *
 * This addresses the row by the pair the commercial line itself is keyed by —
 * the permanent `productLineRef` and the `sampleStyleId`. Additive: the named
 * route is untouched and historical rows keep working, so nothing stored before
 * this becomes unreadable. A row written here carries the pair, and is found by
 * it next time.
 */
router.patch("/:id/cost-ledger/line", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productLineRef = String(req.body?.productLineRef || "").trim();
    const sampleStyleId = String(req.body?.sampleStyleId || "").trim();
    if (!productLineRef || !sampleStyleId) {
      return res.status(400).json({
        success: false,
        message: "Name the product line and the style this price is for.",
        code: "LINE_KEY_REQUIRED",
      });
    }

    /* ── THE LINE MUST BE ONE THIS ENQUIRY HAS ──────────────────────────
       A reference this enquiry does not carry is NOT FOUND rather than
       created: a ledger row for a line nobody is quoting is a number that
       can never be reconciled. */
    const product = (enquiry.products || [])
      .find((p) => String(p.productLineRef || "") === productLineRef) || null;
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "That product line is not on this enquiry.",
        code: "LINE_NOT_FOUND",
      });
    }

    const parse = (v) => {
      if (v === null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const cost = "cost" in req.body ? parse(req.body.cost) : undefined;
    const price = "price" in req.body ? parse(req.body.price) : undefined;
    if (cost === undefined && price === undefined) {
      return res.status(400).json({ success: false, message: "Send a cost, a price, or both." });
    }
    /* Sales sets the PRICE and never the cost — a writable field they cannot
       read is a field they can only corrupt, and it would let the floor be
       moved by the person the floor constrains. */
    if (cost !== undefined && !canSeeCost(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Cost is set from the costing sheet, not here. You can set the quoted price.",
      });
    }

    /* The same gate the named route applies, asked with the exact pair — so
       a price is judged against THIS line's floor and never a namesake's. */
    if (price !== undefined && price !== null) {
      const gate = await sellingPriceGateFor(enquiry, String(product.product || ""), {
        productLineRef, sampleStyleId,
      });
      if (!gate.ok) {
        return res.status(409).json({
          success: false,
          error: { code: "SELLING_PRICE_NOT_READY", message: gate.message, details: { reason: gate.reason } },
          message: gate.message,
        });
      }
    }

    enquiry.costLedger = enquiry.costLedger || [];
    let row = enquiry.costLedger.find((l) => String(l.productLineRef || "") === productLineRef
      && String(l.sampleStyleId || "") === sampleStyleId);
    if (!row) {
      /* ── ADOPTING A HISTORICAL ROW, ONCE, AND ONLY WHEN IT IS SAFE ───
         A row written before the pair existed has only a name. Where the
         enquiry has exactly ONE line for that name, that row is
         unambiguously this line's and is stamped with the pair rather than
         left behind as a second price for the same garment. Where there are
         two, it is ambiguous by construction and a fresh row is started —
         the historical figure stays where it is and is not reassigned to a
         colourway nobody said it belonged to. */
      const name = String(product.product || "");
      const sameName = (enquiry.products || []).filter((p) => String(p.product || "") === name);
      const legacy = sameName.length === 1
        ? enquiry.costLedger.find((l) => l.productName === name && !l.productLineRef)
        : null;
      if (legacy) {
        legacy.productLineRef = productLineRef;
        legacy.sampleStyleId = sampleStyleId;
        row = legacy;
      } else {
        enquiry.costLedger.push({ productName: name, productLineRef, sampleStyleId });
        row = enquiry.costLedger[enquiry.costLedger.length - 1];
      }
    }
    if (cost !== undefined) row.cost = cost === null ? undefined : cost;
    if (price !== undefined) row.price = price === null ? undefined : price;
    row.updatedBy = actor(req);
    row.updatedAt = new Date();

    enquiry.updatedBy = actor(req);
    await enquiry.save();

    /* ── AND THE COSTING IS RE-DRIVEN WITH THE NEW PRICE ────────────────
       The commercial review decides on the figures a version FROZE. A price
       typed after a version was frozen is not on it, so approving that
       version would approve a number the approver never saw — and the
       proforma, which binds to the approval, would stamp a price nobody
       decided. Re-briefing makes the new price part of the record that gets
       reviewed.

       Reported rather than thrown: the price IS saved by this point, and
       failing the request would tell somebody their price did not stick. */
    let repriced = null;
    if (price !== undefined && price !== null) {
      repriced = await commercialLine.repriceLine(
        { companyId: enquiry.companyId },
        {
          enquiryId: String(enquiry._id),
          productLineRef, sampleStyleId,
          actor: actor(req),
        },
      );
    }

    res.json({
      success: true,
      costLedger: reduceCostLedger(enquiry.costLedger, canSeeCost(req.user), await markupPercent()),
      ...(repriced ? { costing: repriced } : {}),
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] PATCH cost-ledger/line", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/:id/products/:productName/cost-ledger", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = String(req.params.productName || "").trim();
    if (!productName) return res.status(400).json({ success: false, message: "A product name is required." });
    // Only against a product this enquiry actually has: a ledger row for a
    // product nobody is quoting is a number that can never be reconciled.
    if (!(enquiry.products || []).some((p) => p.product === productName)) {
      return res.status(404).json({ success: false, message: `"${productName}" is not a product on this enquiry.` });
    }

    // `null` clears a figure; absent leaves it untouched. They are different
    // intentions and the client can express both.
    const parse = (v) => {
      if (v === null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const cost = "cost" in req.body ? parse(req.body.cost) : undefined;
    const price = "price" in req.body ? parse(req.body.price) : undefined;
    if (cost === undefined && price === undefined) {
      return res.status(400).json({ success: false, message: "Send a cost, a price, or both." });
    }
    // Sales sets the PRICE. They do not see cost and they do not write it — a
    // writable field they cannot read is a field they can only corrupt, and it
    // would let the floor price be moved by the person the floor constrains.
    if (cost !== undefined && !canSeeCost(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Cost is set from the costing sheet, not here. You can set the quoted price.",
      });
    }

    /* ── A PRICE BEFORE A FLOOR IS A PRICE AGAINST NOTHING ──────────────
       The floor is the company's minimum for this garment AT THIS QUANTITY.
       Setting a selling price before the costing for the confirmed quantity
       has completed means quoting a number nobody can say is above or below
       anything — and the below-floor exception, which exists so that going
       under is a decision somebody takes deliberately, has nothing to
       measure against.

       The screen hides the editor until the floor is ready. This is the same
       rule on the write path, because a UI gate is not a rule: a stale tab, a
       replayed request or a direct call would otherwise walk straight past
       it.

       Clearing a price (`null`) is always allowed — withdrawing a number is
       not quoting one — and a cost write is Store's own path, already gated
       above. */
    if (price !== undefined && price !== null) {
      const gate = await sellingPriceGateFor(enquiry, productName);
      if (!gate.ok) {
        return res.status(409).json({
          success: false,
          error: { code: "SELLING_PRICE_NOT_READY", message: gate.message, details: { reason: gate.reason } },
          message: gate.message,
        });
      }
    }

    enquiry.costLedger = enquiry.costLedger || [];
    let row = enquiry.costLedger.find((l) => l.productName === productName);
    if (!row) {
      row = { productName };
      enquiry.costLedger.push(row);
      row = enquiry.costLedger[enquiry.costLedger.length - 1];
    }
    if (cost !== undefined) row.cost = cost === null ? undefined : cost;
    if (price !== undefined) row.price = price === null ? undefined : price;
    row.updatedBy = actor(req);
    row.updatedAt = new Date();

    enquiry.updatedBy = actor(req);
    await enquiry.save();

    // Reduced like every other read — this endpoint must not be the one hole
    // that hands the cost back to the caller who just set a price.
    res.json({
      success: true,
      costLedger: reduceCostLedger(enquiry.costLedger, canSeeCost(req.user), await markupPercent()),
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] PATCH cost-ledger", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Now actually reaches the customer's inbox (24 Aug 2026, explicit request —
// this used to only flip an internal flag and notify Sales/Access Control
// staff, with NO email and nothing for the customer to click). Mints a
// single-use, 7-day review link and emails it directly; the internal
// notification below is unchanged, so Sales still hears about their own action.
router.post("/:id/products/:productName/send-to-customer", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });
    const productName = decodeURIComponent(req.params.productName);
    const product = (enquiry.products || []).find((p) => p.product === productName);
    if (!product) {
      return res.status(404).json({ success: false, message: "No product with that name on this enquiry." });
    }

    const price = (enquiry.costLedger || []).find((l) => l.productName === productName)?.price;
    if (!(price > 0)) {
      return res.status(400).json({ success: false, message: "This product has no price yet — set one before sending it to the customer." });
    }
    const customerEmail = await customerEmailFor(enquiry, req);
    if (!customerEmail) {
      return res.status(400).json({ success: false, message: "This customer's account has no email on file — add one before sending." });
    }
    const customerName = await customerNameFor(enquiry, req);

    const plainToken = crypto.randomBytes(32).toString("base64url");
    const entry = findOrCreateLifecycle(enquiry, productName);
    entry.sentToCustomerAt = new Date();
    entry.sentToCustomerBy = actor(req);
    entry.customerApprovalTokenHash = hashApprovalToken(plainToken);
    entry.customerApprovalTokenExpiresAt = new Date(Date.now() + COSTING_APPROVAL_TOKEN_LIFETIME_MS);
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    const reviewUrl = `${DEPT_NOTIFY_APP_URL}/costing-approval/${encodeURIComponent(plainToken)}`;
    const emailResult = await CustomerEmailService.sendCostingApprovalEmail({
      toEmail: customerEmail,
      toName: customerName !== "—" ? customerName : undefined,
      productName,
      price,
      currency: "INR",
      quantity: product.quantity,
      enquiryRef: enquiry.enquiryId,
      reviewUrl,
    });
    if (!emailResult.success) {
      return res.status(502).json({ success: false, message: emailResult.error || "Could not send the email — try again." });
    }

    recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-enquiry",
      entityId: enquiry._id,
      entityLabel: enquiry.enquiryId,
      action: "sent-to-customer",
      summary: `${actor(req).name || "Sales"} emailed pricing for "${productName}" to ${customerEmail}`,
    }).catch(() => {});

    (async () => {
      await notifyEvent("costing_sent_to_customer", {
        heading: `Quote sent to customer: ${productName}`,
        bodyHtml: `<p><strong>${escapeHtml(actor(req).name || "Sales")}</strong> emailed pricing for this product to the customer.</p>`,
        details: [
          ["Customer", customerName],
          ["Enquiry ref", enquiry.enquiryId],
          ["Product", productName],
          ["Quantity", product?.quantity],
        ],
        image: product?.images?.[0],
        bodyText: `${actor(req).name || "Sales"} emailed pricing for "${productName}" to ${customerName} — ${enquiry.enquiryId || ""}.`,
        ctaLabel: "Open Cost & Invoicing",
        ctaUrl: `${DEPT_NOTIFY_APP_URL}/sales/dashboard/journeys/${enquiry.journeyId}/cost-quote`,
      });
    })().catch(() => {});

    return res.json({ success: true, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /:id/products/:productName/send-to-customer", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — the customer's own review link, no login (24 Aug 2026). Deliberately
// exposes ONLY the total price, never the raw-item/operation cost build-up
// ("just the direct total price need to showcase to the customer").
// ─────────────────────────────────────────────────────────────────────────────
router.get("/costing-approval/:token", async (req, res) => {
  try {
    const found = await resolveCostingApprovalToken(req.params.token);
    if (!found) return res.status(404).json({ success: false, message: "This link is invalid, already used, or has expired." });
    const { enquiry, entry } = found;
    const product = (enquiry.products || []).find((p) => p.product === entry.productName);
    const price = (enquiry.costLedger || []).find((l) => l.productName === entry.productName)?.price;
    const customerName = await customerNameFor(enquiry, req);
    const decided = entry.customerApproved != null;
    return res.json({
      success: true,
      review: {
        productName: entry.productName,
        quantity: product?.quantity ?? null,
        price: price ?? null,
        currency: "INR",
        enquiryRef: enquiry.enquiryId,
        customerName: customerName !== "—" ? customerName : null,
        decided,
        approved: decided ? entry.customerApproved : null,
        decidedAt: decided ? entry.customerApprovedAt : null,
      },
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /costing-approval/:token", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PUBLIC — the customer's decision. Body: { approved: boolean, note?: string }.
// Single-use: the token hash is cleared here regardless of outcome, so this
// exact link can never record a second, different answer. Approval writes
// the confirmed price straight onto the linked stock item's variants.
router.post("/costing-approval/:token/decide", async (req, res) => {
  try {
    const found = await resolveCostingApprovalToken(req.params.token);
    if (!found) return res.status(404).json({ success: false, message: "This link is invalid, already used, or has expired." });
    if (typeof req.body?.approved !== "boolean") {
      return res.status(400).json({ success: false, message: "approved (true/false) is required." });
    }
    const { enquiry, entry } = found;
    const note = String(req.body?.note || "").trim();
    const customerName = await customerNameFor(enquiry, req);

    const now = new Date();
    entry.customerApprovalLog = entry.customerApprovalLog || [];
    entry.customerApprovalLog.push({ approved: req.body.approved, decidedAt: now, decidedBy: { id: null, name: customerName !== "—" ? customerName : "Customer" }, note });
    entry.customerApproved = req.body.approved;
    entry.customerApprovedAt = now;
    entry.customerApprovedBy = { id: null, name: customerName !== "—" ? customerName : "Customer" };
    entry.customerDecisionNote = note;
    // Single-use — this link cannot be replayed to record a second answer.
    entry.customerApprovalTokenHash = undefined;
    entry.customerApprovalTokenExpiresAt = undefined;
    await enquiry.save();

    /* ── THE APPROVAL IS RECORDED, AND NOTHING ELSE MOVES ──────────────
       It used to read a ledger price by NAME and write it across the linked
       stock item's variants. Two colourways share a name, so the wrong price
       could be chosen and then fanned over the others — and the PI read it
       back as its unit price.

       A customer's decision is a fact about THIS enquiry line. It is already
       stored above, on the line's own `costingLifecycle` entry. The catalogue
       is not a record of what one customer agreed, and the PI resolves its
       price from the approved costing version instead. */

    recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-enquiry",
      entityId: enquiry._id,
      entityLabel: enquiry.enquiryId,
      action: req.body.approved ? "customer-approved" : "customer-rejected",
      summary: `The customer ${req.body.approved ? "approved" : "rejected"} "${entry.productName}" directly, by email${note ? ` — ${note}` : ""}`,
    }).catch(() => {});

    (async () => {
      const product = (enquiry.products || []).find((p) => p.product === entry.productName);
      await notifyEvent("customer_decision_recorded", {
        heading: `Customer ${req.body.approved ? "approved" : "rejected"}: ${entry.productName}`,
        bodyHtml: `<p>The customer <strong>${req.body.approved ? "approved" : "rejected"}</strong> this quote directly, by email.</p>${note ? `<p style="margin:10px 0 0;color:#475569">${escapeHtml(note)}</p>` : ""}`,
        details: [
          ["Customer", customerName],
          ["Enquiry ref", enquiry.enquiryId],
          ["Product", entry.productName],
          ["Quantity", product?.quantity],
        ],
        image: product?.images?.[0],
        bodyText: `The customer ${req.body.approved ? "approved" : "rejected"} "${entry.productName}" directly, by email — ${enquiry.enquiryId || ""}.${note ? ` Note: ${note}` : ""}`,
        ctaLabel: "Open Cost & Invoicing",
        ctaUrl: `${DEPT_NOTIFY_APP_URL}/sales/dashboard/journeys/${enquiry.journeyId}/cost-quote`,
      });
    })().catch(() => {});

    return res.json({ success: true });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /costing-approval/:token/decide", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/enquiries/:id/products/:productName/customer-approval
// Body: { approved: boolean, note?: string }. Sales records what the
// customer decided — there is no customer login here to do it themselves.
//
// APPENDS to customerApprovalLog, never overwrites (20 Aug 2026, explicit
// request — see the model's own comment on customerApprovalLog for why). A
// REVERSAL — this entry disagreeing with the current cached decision —
// requires a note; a first-time decision doesn't, there's nothing to explain
// yet.
router.post("/:id/products/:productName/customer-approval", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });
    const productName = decodeURIComponent(req.params.productName);
    if (!(enquiry.products || []).some((p) => p.product === productName)) {
      return res.status(404).json({ success: false, message: "No product with that name on this enquiry." });
    }
    if (typeof req.body?.approved !== "boolean") {
      return res.status(400).json({ success: false, message: "approved (true/false) is required." });
    }
    const note = String(req.body?.note || "").trim();
    const entry = findOrCreateLifecycle(enquiry, productName);
    const isReversal = entry.customerApproved != null && entry.customerApproved !== req.body.approved;
    if (isReversal && !note) {
      return res.status(400).json({ success: false, message: "Changing a customer decision needs a reason." });
    }
    const now = new Date();
    const who = actor(req);
    entry.customerApprovalLog = entry.customerApprovalLog || [];
    entry.customerApprovalLog.push({ approved: req.body.approved, decidedAt: now, decidedBy: who, note });
    // Cache of the log's last entry — see the model's own comment.
    entry.customerApproved = req.body.approved;
    entry.customerApprovedAt = now;
    entry.customerApprovedBy = who;
    entry.customerDecisionNote = note;
    enquiry.updatedBy = who;
    await enquiry.save();

    recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-enquiry",
      entityId: enquiry._id,
      entityLabel: enquiry.enquiryId,
      action: req.body.approved ? "customer-approved" : "customer-rejected",
      summary: `${who.name || "Sales"} recorded that the customer ${req.body.approved ? "approved" : "rejected"} "${productName}"${note ? ` — ${note}` : ""}`,
    }).catch(() => {});

    // Denormalize onto every matching SampleStyle (26 Aug 2026, explicit
    // request: "everywhere in both sales, r&d and all other where the tag
    // need to showcase ki customer rejected this product") so R&D's already
    // existing history/status rendering shows this with zero new R&D-side
    // code. A product can have more than one SampleStyle — one per
    // variantKey — so every match is updated, not just the first.
    (async () => {
      const styles = await SampleStyle.find({ journeyId: enquiry.journeyId, productName });
      for (const style of styles) {
        style.customerRejected = !req.body.approved;
        if (!req.body.approved) {
          style.history = style.history || [];
          style.history.push({ kind: "customer_rejected_at_costing", note, by: who, at: now });
        }
        style.updatedBy = who;
        await style.save();
      }
    })().catch((err) => console.error("[enquiries] customer-approval → SampleStyle sync failed:", err.message));

    (async () => {
      const product = (enquiry.products || []).find((p) => p.product === productName);
      const customerName = await customerNameFor(enquiry, req);
      await notifyEvent("customer_decision_recorded", {
        heading: `Customer ${req.body.approved ? "approved" : "rejected"}: ${productName}`,
        bodyHtml: `<p><strong>${escapeHtml(who.name || "Sales")}</strong> recorded that the customer <strong>${req.body.approved ? "approved" : "rejected"}</strong> this quote.</p>${note ? `<p style="margin:10px 0 0;color:#475569">${escapeHtml(note)}</p>` : ""}`,
        details: [
          ["Customer", customerName],
          ["Enquiry ref", enquiry.enquiryId],
          ["Product", productName],
          ["Quantity", product?.quantity],
        ],
        image: product?.images?.[0],
        bodyText: `${who.name || "Sales"} recorded that ${customerName} ${req.body.approved ? "approved" : "rejected"} "${productName}" — ${enquiry.enquiryId || ""}.${note ? ` Note: ${note}` : ""}`,
        ctaLabel: "Open Cost & Invoicing",
        ctaUrl: `${DEPT_NOTIFY_APP_URL}/sales/dashboard/journeys/${enquiry.journeyId}/cost-quote`,
      });
    })().catch(() => {});

    return res.json({ success: true, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /:id/products/:productName/customer-approval", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/enquiries/:id/products/:productName/remove
// "Change Product Design" → "Remove & Create New Version of this product"
// (26 Aug 2026, explicit request). Removes ONLY this product's row from the
// enquiry — never the underlying StockItem catalog document, per "unlink
// that product from the customer" — and keeps the full removed row (spec,
// photos, everything) recoverable via the shared ChangeLog, same mechanism
// already used throughout this file (recordChange/historyFor), so a later
// "why isn't this product here anymore" always has an answer: what it was,
// who removed it, and why (the customer's own rejection reason, carried
// over from costingLifecycle).
router.post("/:id/products/:productName/remove", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });
    const productName = decodeURIComponent(req.params.productName);
    const row = (enquiry.products || []).find((p) => p.product === productName);
    if (!row) return res.status(404).json({ success: false, message: "No product with that name on this enquiry." });

    const snapshot = row.toObject();
    enquiry.products = (enquiry.products || []).filter((p) => p.product !== productName);
    const who = actor(req);
    enquiry.updatedBy = who;
    await enquiry.save();

    // The comment above this route has claimed "unlink that product from the
    // customer" since it was written — this call is what actually makes that
    // true (26 Aug 2026, bug fix: it was never implemented).
    if (snapshot.stockItemId && enquiry.accountId) {
      unlinkRemovedEnquiryProducts({ accountId: enquiry.accountId, removedStockItemIds: [snapshot.stockItemId], excludeEnquiryId: enquiry._id })
        .catch((e) => console.error("[enquiries] product unlink (remove route) failed:", e.message));
    }

    const lifecycleEntry = (enquiry.costingLifecycle || []).find((c) => c.productName === productName);
    const rejectionNote = lifecycleEntry?.customerDecisionNote || "";

    recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-enquiry-product",
      entityId: enquiry._id,
      entityLabel: productName,
      action: "delete",
      summary: `${who.name || "Sales"} removed "${productName}"${rejectionNote ? ` — customer rejected: ${rejectionNote}` : ""}`,
      before: snapshot,
      after: {},
    }).catch(() => {});

    return res.json({ success: true, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /:id/products/:productName/remove", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/:id/products/:productName/removed-snapshot
// The read side of "Remove & Create New Version" — the last snapshot of a
// removed product row (name/description/category/photos/specs), read back
// out of the same ChangeLog entry the remove route above writes, so the new
// product registration form can be pre-filled from it (26 Aug 2026).
router.get("/:id/products/:productName/removed-snapshot", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const productName = decodeURIComponent(req.params.productName);
    const entries = await historyFor("crm-enquiry-product", req.params.id, 50);
    const match = entries.find((e) => e.action === "delete" && e.before?.product === productName);
    return res.json({ success: true, snapshot: match?.before || null });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /:id/products/:productName/removed-snapshot", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/enquiries/:id/products/:productName/request-stock-item
// A REQUEST, not a StockItem creation — Merchandising still makes the SKU/
// category/BOM decisions themselves, from app/merchandiser/products'
// "Requests" view (see stock-item-request routes below). This just puts it
// in front of them and records that Sales asked, when, and by whom.
router.post("/:id/products/:productName/request-stock-item", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });
    const productName = decodeURIComponent(req.params.productName);
    if (!(enquiry.products || []).some((p) => p.product === productName)) {
      return res.status(404).json({ success: false, message: "No product with that name on this enquiry." });
    }
    const entry = findOrCreateLifecycle(enquiry, productName);
    entry.stockItemRequestedAt = new Date();
    entry.stockItemRequestedBy = actor(req);
    // Re-requesting after a rejection reopens it — Merchandising sees it
    // again rather than it staying silently rejected forever.
    entry.stockItemRequestStatus = "pending";
    entry.stockItemRequestDecidedAt = undefined;
    entry.stockItemRequestDecidedBy = undefined;
    entry.stockItemRequestDecisionNote = undefined;
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-enquiry",
      entityId: enquiry._id,
      entityLabel: enquiry.enquiryId,
      action: "stock-item-requested",
      summary: `${actor(req).name || "Sales"} requested "${productName}" be added to inventory`,
    }).catch(() => {});

    (async () => {
      const product = (enquiry.products || []).find((p) => p.product === productName);
      const customerName = await customerNameFor(enquiry, req);
      await notifyEvent("stock_item_requested", {
        heading: `Stock item requested: ${productName}`,
        bodyHtml: `<p><strong>${escapeHtml(actor(req).name || "Sales")}</strong> asked for this product to be added to inventory.</p>`,
        details: [
          ["Customer", customerName],
          ["Enquiry ref", enquiry.enquiryId],
          ["Product", productName],
          ["Quantity", product?.quantity],
        ],
        image: product?.images?.[0],
        bodyText: `${actor(req).name || "Sales"} asked for "${productName}" (${customerName}) to be added to inventory — ${enquiry.enquiryId || ""}.`,
        ctaLabel: "Review request",
        ctaUrl: `${DEPT_NOTIFY_APP_URL}/merchandiser/products`,
      });
    })().catch(() => {});

    return res.json({ success: true, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /:id/products/:productName/request-stock-item", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Stock-item requests — Merchandising's side (app/merchandiser/products'
// "Requests" view) ───────────────────────────────────────────────────────
//
// Reuses `salesAuth`, same as every other route in this file — the whole
// costing/lifecycle surface here is deliberately open to Merchandiser/PM as
// well as Sales (19–20 Aug 2026, "anyone can fill anything" for costing; the
// same reasoning applies to acting on their own stock-item requests).

// GET /api/cms/crm/enquiries/stock-item-requests?status=pending|approved|rejected|all
// Scans every active Enquiry's costingLifecycle for a request in the given
// status (default "pending" — the work queue) and returns it flattened, one
// row per requested product, newest first.
router.get("/stock-item-requests", salesAuth, async (req, res) => {
  try {
    const status = String(req.query?.status || "pending").trim();
    const statusFilter = status === "all" ? { $ne: "none" } : status;
    const enquiries = await Enquiry.find(await scoped(req, {
      isActive: true,
      costingLifecycle: { $elemMatch: { stockItemRequestStatus: statusFilter } },
    }))
      .select("enquiryId accountId products costingLifecycle")
      .populate("accountId", "companyName displayName")
      .lean();

    const rows = [];
    for (const enq of enquiries) {
      for (const entry of enq.costingLifecycle || []) {
        const matches = status === "all" ? entry.stockItemRequestStatus !== "none" : entry.stockItemRequestStatus === status;
        if (!matches) continue;
        const product = (enq.products || []).find((p) => p.product === entry.productName) || null;
        rows.push({
          enquiryId: enq._id,
          enquiryRef: enq.enquiryId,
          customerName: enq.accountId?.displayName || enq.accountId?.companyName || "",
          productName: entry.productName,
          product,
          sentToCustomerAt: entry.sentToCustomerAt || null,
          customerApproved: entry.customerApproved,
          customerApprovedAt: entry.customerApprovedAt || null,
          stockItemRequestedAt: entry.stockItemRequestedAt || null,
          stockItemRequestedBy: entry.stockItemRequestedBy || null,
          stockItemRequestStatus: entry.stockItemRequestStatus || "none",
          stockItemRequestDecidedAt: entry.stockItemRequestDecidedAt || null,
          stockItemRequestDecidedBy: entry.stockItemRequestDecidedBy || null,
          stockItemRequestDecisionNote: entry.stockItemRequestDecisionNote || "",
        });
      }
    }
    rows.sort((a, b) => new Date(b.stockItemRequestedAt || 0) - new Date(a.stockItemRequestedAt || 0));
    return res.json({ success: true, requests: rows });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /stock-item-requests", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/enquiries/:id/products/:productName/stock-item-request/decide
// Body: { decision: "approve"|"reject", note?: string }. Merchandising's own
// call — "approve" says they'll create the Stock Item themselves; "reject"
// needs a reason (why it isn't going into Inventory as asked).
router.post("/:id/products/:productName/stock-item-request/decide", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });
    const productName = decodeURIComponent(req.params.productName);
    const decision = String(req.body?.decision || "").trim();
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ success: false, message: 'decision must be "approve" or "reject".' });
    }
    const note = String(req.body?.note || "").trim();
    if (decision === "reject" && !note) {
      return res.status(400).json({ success: false, message: "A reason is required to reject a stock-item request." });
    }
    const entry = (enquiry.costingLifecycle || []).find((c) => c.productName === productName);
    if (!entry || entry.stockItemRequestStatus === "none") {
      return res.status(404).json({ success: false, message: "No stock-item request for that product." });
    }
    if (entry.stockItemRequestStatus !== "pending") {
      return res.status(400).json({ success: false, message: `This request was already ${entry.stockItemRequestStatus}.` });
    }
    entry.stockItemRequestStatus = decision === "approve" ? "approved" : "rejected";
    entry.stockItemRequestDecidedAt = new Date();
    entry.stockItemRequestDecidedBy = actor(req);
    entry.stockItemRequestDecisionNote = note;
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    recordChange(req, {
      departmentSlug: "merchandiser",
      entity: "crm-enquiry",
      entityId: enquiry._id,
      entityLabel: enquiry.enquiryId,
      action: decision === "approve" ? "stock-item-approved" : "stock-item-rejected",
      summary: `${actor(req).name || "Merchandising"} ${decision === "approve" ? "approved" : "rejected"} the stock-item request for "${productName}"${note ? ` — ${note}` : ""}`,
    }).catch(() => {});

    (async () => {
      const product = (enquiry.products || []).find((p) => p.product === productName);
      const customerName = await customerNameFor(enquiry, req);
      await notifyEvent("stock_item_request_decided", {
        heading: `Stock item request ${decision === "approve" ? "approved" : "rejected"}: ${productName}`,
        bodyHtml: `<p><strong>${escapeHtml(actor(req).name || "Merchandising")}</strong> <strong>${decision === "approve" ? "approved" : "rejected"}</strong> the request to add this product to inventory.</p>${note ? `<p style="margin:10px 0 0;color:#475569">${escapeHtml(note)}</p>` : ""}`,
        details: [
          ["Customer", customerName],
          ["Enquiry ref", enquiry.enquiryId],
          ["Product", productName],
          ["Quantity", product?.quantity],
        ],
        image: product?.images?.[0],
        bodyText: `${actor(req).name || "Merchandising"} ${decision === "approve" ? "approved" : "rejected"} the stock-item request for "${productName}" (${customerName}) — ${enquiry.enquiryId || ""}.${note ? ` Note: ${note}` : ""}`,
        ctaLabel: "Open Cost & Invoicing",
        ctaUrl: `${DEPT_NOTIFY_APP_URL}/sales/dashboard/journeys/${enquiry.journeyId}/cost-quote`,
      });
    })().catch(() => {});

    return res.json({ success: true, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /:id/products/:productName/stock-item-request/decide", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ─── Product sheets ────────────────────────────────────────────────────────────
//
// The free-form "communicate in a sheet" surface, per product — NOT costing.
// This is the CoWork-sheet mechanism costing used to use (see the model's own
// comment on `productSheets`), repointed here now that costing is native. The
// salesperson creates a sheet, is its owner, and decides who else can view or
// edit it; the sheet itself renders natively via CostingSheetView.js (it is
// already a generic CoWork-sheet grid, nothing costing-specific in its body).
const {
  createSheet: createProductSheetDoc,
  setMembers: setProductSheetMembers,
  getSheet: getProductSheetDoc,
  getSheetBody: getProductSheetBody,
  updateSheetBody: updateProductSheetBody,
} = require("../../../services/coworkSheets.service");

const productSheetCanWrite = (role) => role === "owner" || role === "editor";

// POST /api/cms/crm/enquiries/:id/product-sheet
// Create a blank sheet for one product, owned by the caller. Optionally
// shares it with people right away (`shareWith: [{employeeId, name, role}]`);
// more people can be added later via the members route below.
router.post("/:id/product-sheet", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = String(req.body?.productName || "").trim();
    if (!productName) return res.status(400).json({ success: false, message: "productName is required." });
    const product = (enquiry.products || []).find((p) => p.product === productName);
    if (!product) return res.status(404).json({ success: false, message: "No product with that name on this enquiry." });

    const me = await coworkIdentity(req);
    if (!me) return res.status(409).json(NO_COWORK_ACCOUNT);

    const shareWith = (Array.isArray(req.body?.shareWith) ? req.body.shareWith : [])
      .map((m) => ({ employeeId: String(m?.employeeId || "").trim(), name: m?.name || "", role: m?.role }))
      .filter((m) => m.employeeId && m.employeeId !== me.coworkEmployeeId && SHARE_ROLES.has(m.role));

    const title = `Sheet — ${productName}`;
    const { documentId, members } = await createProductSheetDoc({
      title,
      creatorEmployeeId: me.coworkEmployeeId,
      shareWith,
    });

    const created = {
      productName,
      documentId,
      title,
      createdAt: new Date(),
      createdBy: actor(req),
      members: members.map((m) => ({ employeeId: m.employeeId, name: m.employeeId === me.coworkEmployeeId ? (me.name || "") : (shareWith.find((s) => s.employeeId === m.employeeId)?.name || ""), role: m.role })),
    };

    enquiry.productSheets = [
      ...(enquiry.productSheets || []).filter((s) => s.productName !== productName),
      created,
    ];
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    return res.status(201).json({ success: true, productSheet: created, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /:id/product-sheet", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/enquiries/:id/product-sheet/members
// Add (or re-role) one or more people on a product's sheet — the "sales
// person picks who can see or edit it" control.
router.patch("/:id/product-sheet/members", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = String(req.body?.productName || "").trim();
    if (!productName) return res.status(400).json({ success: false, message: "productName is required." });

    const raw = Array.isArray(req.body?.members)
      ? req.body.members
      : req.body?.employeeId
        ? [{ employeeId: req.body.employeeId, name: req.body.name, role: req.body.role }]
        : [];
    if (!raw.length) return res.status(400).json({ success: false, message: "At least one member is required." });

    const additions = raw.map((m) => ({
      employeeId: String(m?.employeeId || "").trim(),
      name: m?.name || "",
      role: m?.role,
    }));
    for (const m of additions) {
      if (!m.employeeId) return res.status(400).json({ success: false, message: "Every member needs an employeeId." });
      if (!SHARE_ROLES.has(m.role)) return res.status(400).json({ success: false, message: `Unknown share role: ${m.role}` });
    }

    const sheet = (enquiry.productSheets || []).find((s) => s.productName === productName);
    if (!sheet) return res.status(404).json({ success: false, message: "No sheet exists yet for that product." });

    await setProductSheetMembers(sheet.documentId, additions);

    const addedIds = new Set(additions.map((m) => m.employeeId));
    sheet.members = [...(sheet.members || []).filter((m) => !addedIds.has(m.employeeId)), ...additions];
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    return res.json({ success: true, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] PATCH /:id/product-sheet/members", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/:id/product-sheet/:productName/data
// The sheet's actual content, read straight from CoWork — same "render
// natively instead of an iframe" approach costing used, no tier-gating (this
// isn't commercial data): anyone who can see this enquiry can read it,
// `canEdit` says whether the caller may save to it.
router.get("/:id/product-sheet/:productName/data", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true })).select("productSheets").lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = decodeURIComponent(req.params.productName);
    const sheet = (enquiry.productSheets || []).find((s) => s.productName === productName);
    if (!sheet) return res.status(404).json({ success: false, message: "No sheet exists yet for that product." });

    const me = await coworkIdentity(req);
    const [body, doc] = await Promise.all([
      getProductSheetBody(sheet.documentId),
      getProductSheetDoc(sheet.documentId),
    ]);
    const mine = me ? (doc?.members || []).find((m) => m.employeeId === me.coworkEmployeeId) : null;

    return res.json({
      success: true,
      linked: Boolean(me),
      parts: [],
      workbook: body?.workbook || null,
      updatedAt: body?.updatedAt || null,
      createdById: doc?.createdById || null,
      lastEditedById: doc?.lastEditedById || null,
      members: sheet.members || [],
      canEdit: productSheetCanWrite(mine?.role),
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /:id/product-sheet/:productName/data", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/enquiries/:id/product-sheet/:productName/data
// Save an edit made on the CMS's own view back to the CoWork sheet. The
// sheet's own permissions decide — same rule costing used: the caller's role
// is read from CoWork's member list and must be owner or editor.
router.patch("/:id/product-sheet/:productName/data", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true })).select("productSheets").lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = decodeURIComponent(req.params.productName);
    const sheet = (enquiry.productSheets || []).find((s) => s.productName === productName);
    if (!sheet) return res.status(404).json({ success: false, message: "No sheet exists yet for that product." });

    const workbook = req.body?.workbook;
    if (!workbook || !Array.isArray(workbook.sheets)) {
      return res.status(400).json({ success: false, message: "A valid workbook (with a sheets array) is required." });
    }

    const me = await coworkIdentity(req);
    if (!me) return res.status(409).json(NO_COWORK_ACCOUNT);

    const doc = await getProductSheetDoc(sheet.documentId);
    if (!doc) return res.status(404).json({ success: false, message: "The sheet could not be found in CoWork." });
    const mine = (doc.members || []).find((m) => m.employeeId === me.coworkEmployeeId);
    if (!productSheetCanWrite(mine?.role)) {
      return res.status(403).json({
        success: false,
        code: "NOT_AN_EDITOR",
        message: "You can read this sheet, but you are not an editor on it, so you cannot change it.",
      });
    }

    try {
      const { updatedAt } = await updateProductSheetBody(sheet.documentId, workbook, me.coworkEmployeeId, req.body?.expectedUpdatedAt);
      return res.json({ success: true, updatedAt });
    } catch (err) {
      if (err.code === "CONFLICT") return res.status(409).json({ success: false, code: "CONFLICT", message: err.message });
      throw err;
    }
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] PATCH /:id/product-sheet/:productName/data", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ─── Product chat ───────────────────────────────────────────────────────────
//
// A real conversation per product, shown natively on this page. Backed by an
// ordinary CoWork group underneath — see the model's own comment on
// `productThreads` — created and messaged here via services/cowork.service.js,
// the same functions CoWork's own group-chat routes call, just invoked
// server-side instead of requiring the caller to hold a Firebase ID token.
const coworkService = require("../../../services/cowork.service");

// POST /api/cms/crm/enquiries/:id/product-thread
// Start the conversation for one product. The caller is always a member;
// `memberIds` (optional) adds others right away — more can be added later.
router.post("/:id/product-thread", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = String(req.body?.productName || "").trim();
    if (!productName) return res.status(400).json({ success: false, message: "productName is required." });
    const product = (enquiry.products || []).find((p) => p.product === productName);
    if (!product) return res.status(404).json({ success: false, message: "No product with that name on this enquiry." });

    const me = await coworkIdentity(req);
    if (!me) return res.status(409).json(NO_COWORK_ACCOUNT);

    const invited = (Array.isArray(req.body?.members) ? req.body.members : [])
      .map((m) => ({ employeeId: String(m?.employeeId || "").trim(), name: m?.name || "" }))
      .filter((m) => m.employeeId && m.employeeId !== me.coworkEmployeeId);

    const memberIds = [me.coworkEmployeeId, ...invited.map((m) => m.employeeId)];
    const group = await coworkService.createCoworkGroup({
      name: `${enquiry.enquiryId} · ${productName}`,
      description: `Chat for ${productName} on ${enquiry.enquiryId}`,
      memberIds,
      createdBy: me.coworkEmployeeId,
      createdByAuthUid: null,
    });

    const created = {
      productName,
      groupId: group.groupId,
      createdAt: new Date(),
      createdBy: actor(req),
      members: [{ employeeId: me.coworkEmployeeId, name: me.name || "" }, ...invited],
    };

    enquiry.productThreads = [
      ...(enquiry.productThreads || []).filter((t) => t.productName !== productName),
      created,
    ];
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    return res.status(201).json({ success: true, productThread: created, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /:id/product-thread", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/enquiries/:id/product-thread/members
// Add people to a product's conversation — the sales person picks who's in.
router.patch("/:id/product-thread/members", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = String(req.body?.productName || "").trim();
    if (!productName) return res.status(400).json({ success: false, message: "productName is required." });

    const raw = Array.isArray(req.body?.members)
      ? req.body.members
      : req.body?.employeeId
        ? [{ employeeId: req.body.employeeId, name: req.body.name }]
        : [];
    const additions = raw
      .map((m) => ({ employeeId: String(m?.employeeId || "").trim(), name: m?.name || "" }))
      .filter((m) => m.employeeId);
    if (!additions.length) return res.status(400).json({ success: false, message: "At least one member is required." });

    const thread = (enquiry.productThreads || []).find((t) => t.productName === productName);
    if (!thread) return res.status(404).json({ success: false, message: "No conversation exists yet for that product." });

    const me = await coworkIdentity(req);
    if (!me) return res.status(409).json(NO_COWORK_ACCOUNT);

    const existingIds = new Set((thread.members || []).map((m) => m.employeeId));
    for (const m of additions) {
      if (existingIds.has(m.employeeId)) continue; // already a member — addGroupMember would refuse it
      await coworkService.addGroupMember(thread.groupId, me.coworkEmployeeId, req.user.role, m.employeeId);
    }

    const addedIds = new Set(additions.map((m) => m.employeeId));
    thread.members = [...(thread.members || []).filter((m) => !addedIds.has(m.employeeId)), ...additions];
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    return res.json({ success: true, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] PATCH /:id/product-thread/members", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/:id/product-thread/:productName/messages
router.get("/:id/product-thread/:productName/messages", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true })).select("productThreads").lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = decodeURIComponent(req.params.productName);
    const thread = (enquiry.productThreads || []).find((t) => t.productName === productName);
    if (!thread) return res.status(404).json({ success: false, message: "No conversation exists yet for that product." });

    const messages = await coworkService.getGroupMessages(thread.groupId, req.query.limit || 60);
    return res.json({ success: true, groupId: thread.groupId, members: thread.members || [], messages });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /:id/product-thread/:productName/messages", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/enquiries/:id/product-thread/:productName/messages
router.post("/:id/product-thread/:productName/messages", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true })).select("productThreads").lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const productName = decodeURIComponent(req.params.productName);
    const thread = (enquiry.productThreads || []).find((t) => t.productName === productName);
    if (!thread) return res.status(404).json({ success: false, message: "No conversation exists yet for that product." });

    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ success: false, message: "A message needs text." });

    const me = await coworkIdentity(req);
    if (!me) return res.status(409).json(NO_COWORK_ACCOUNT);

    const message = await coworkService.sendGroupMessage({
      groupId: thread.groupId,
      senderId: me.coworkEmployeeId,
      senderName: me.name || req.user.name || "",
      text,
      clientMessageId: req.body?.clientMessageId || null,
    });

    return res.status(201).json({ success: true, message });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /:id/product-thread/:productName/messages", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ─── Production ──────────────────────────────────────────────────────────────
//
// The journey's own production picture, counted from the work orders rather
// than reported by anybody. See services/productionView.js for what each number
// is made of and, importantly, for the one thing it refuses to draw.
const { buildProductionView } = require("../../../services/productionView");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

/* ── WHICH ORDER THIS ENQUIRY IS — PROVED, OR NOT AT ALL (G02) ──────────────
 *
 * This used to be `resolveRequestId`: the stored link if any, otherwise the
 * portal customer matched by NAME, then that customer's NEWEST order — and the
 * guess was WRITTEN onto the enquiry, so every later read treated it as fact.
 * Production, Shipment, early-dispatch asks and the commercial ladder all read
 * through it, and none of them could tell a guess from the deal's own order.
 *
 * They now read the order only when services/orderBookLink.js proves it is
 * this deal's exact order, and otherwise say why not in the resolver's words
 * (`orderLink.message`). Nothing here writes a link. The salesperson settles
 * an unproved one through /sales-journeys/:journeyId/order-link.
 */
async function orderLinkCtxFor(req) {
  const { createServiceContext } = require("../../../services/companyContext/serviceScope.service");
  const scope = await salesScopeFor(req);
  return createServiceContext({ companyId: scope.companyId, reason: "sales order link", legacyAware: true });
}

/** @returns {Promise<{customerRequestId:string|null, orderLink:object}>} */
async function provedOrderForEnquiry(req, enquiry) {
  const { provedOrderFor } = require("../../../services/orderBookLink");
  return provedOrderFor(await orderLinkCtxFor(req), enquiry);
}

// PATCH /api/cms/crm/enquiries/:id/link-request
// Called (fire-and-forget) when the quotation engine opens a request.
//
// ── IT NO LONGER WRITES THE BROWSER'S CHOICE (G02) ──────────────────────────
// This used to write ANY existing CustomerRequest id the browser sent onto the
// enquiry — no company proof, no customer proof — and the screen sends the
// first row of a search by customer NAME. That made it a second "newest order
// for this customer" guess, and a way to point one company's enquiry at
// another's order.
//
// Now the id sent is only a hint that a proforma was opened. The link is
// resolved exactly as the PO path resolves it (services/orderBookLink.js): an
// empty link is filled only with the single order raised from THIS enquiry;
// anything else is reported back as `orderLink` and settled by a salesperson
// through POST /sales-journeys/:journeyId/order-link.
router.patch("/:id/link-request", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const requestId = String(req.body?.requestId || "").trim();
    if (!isObjectId(requestId)) return res.status(400).json({ success: false, message: "A valid requestId is required." });

    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const { resolveOrderLink, STATUS: ORDER_LINK } = require("../../../services/orderBookLink");
    const orderLink = await resolveOrderLink(await orderLinkCtxFor(req), enquiry, { write: true });

    /* ── AND THE JOURNEY HEARS ABOUT IT HERE TOO ──────────────────────
       Opening the proforma is the other moment at which the fact "this deal
       has an invoice" reaches the server — for a document raised before the
       command started recording it, the only moment. Only for the order this
       enquiry is PROVED to be: the link is already set by then, so this
       cannot write one. Never fatal. */
    if (orderLink.status === ORDER_LINK.LINKED && orderLink.customerRequestId === requestId) {
      try {
        const linked = await Enquiry.findOne(await scoped(req, { _id: enquiry._id }));
        if (linked?.customerRequestId) {
          await proformaRequest.recordProforma(await costingCtxFor(req), linked, { _id: requestId });
        }
      } catch (e) {
        /* A stage state is not worth failing the response over. */
      }
    }
    const fresh = await Enquiry.findOne(await scoped(req, { _id: enquiry._id }));
    return res.json({ success: true, enquiry: await decorate(fresh || enquiry, req), orderLink });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] PATCH /:id/link-request", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/enquiries/:id/production
// Every work order for this enquiry, reduced to the production view model.
// `linked:false` with a `reason` is a real answer — it means this journey has
// no production to show yet, which is different from production going badly.
router.get("/:id/production", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    /* Only the order this deal is PROVED to be. An unproved link shows no
       production at all rather than another order's. */
    const { customerRequestId: requestId, orderLink } = await provedOrderForEnquiry(req, enquiry);
    if (!requestId) {
      return res.json({ success: true, linked: false, reason: orderLink.message, orderLink });
    }

    const workOrders = await WorkOrder.find({ customerRequestId: requestId })
      .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity status "
            + "assignedDeadline productionCompletion customerName")
      .lean();

    if (!workOrders.length) {
      return res.json({
        success: true, linked: true, requestId: String(requestId), workOrders: 0,
        reason: "The order exists but no work order has been raised against it yet.",
      });
    }

    return res.json({
      success: true,
      linked: true,
      requestId: String(requestId),
      view: buildProductionView(workOrders),
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /:id/production", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ─── Shipment ────────────────────────────────────────────────────────────────
//
// Production's last column, continued: a piece through the final operation is
// packed, and a packed piece that has not been dispatched is ready to ship. See
// services/shipmentView.js for what each figure is made of and for the two
// things it refuses to show (a "received" state and anything about freight).
const { buildShipmentView } = require("../../../services/shipmentView");
const DispatchChallan = require("../../../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");

// GET /api/cms/crm/enquiries/:id/shipment
router.get("/:id/shipment", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const { customerRequestId: requestId, orderLink } = await provedOrderForEnquiry(req, enquiry);
    if (!requestId) {
      return res.json({ success: true, linked: false, reason: orderLink.message, orderLink });
    }

    const [workOrders, challans] = await Promise.all([
      WorkOrder.find({ customerRequestId: requestId })
        .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity status "
              + "assignedDeadline dispatchedQuantity productionCompletion.operationCompletion")
        .lean(),
      DispatchChallan.find({ manufacturingOrderId: requestId })
        .select("challanNumber dispatchType totalUnits totalPersons persons.employeeName persons.employeeUIN "
              + "persons.department persons.designation persons.totalUnits dispatchedBy notes createdAt")
        .lean(),
    ]);

    if (!workOrders.length) {
      return res.json({
        success: true, linked: true, requestId: String(requestId), workOrders: 0,
        reason: "No work order has been raised against this order yet, so nothing has been packed.",
      });
    }

    return res.json({
      success: true,
      linked: true,
      requestId: String(requestId),
      view: buildShipmentView(workOrders, challans, enquiry.earlyDispatchRequests || []),
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /:id/shipment", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/enquiries/:id/early-dispatch
// Ask dispatch to send some of the order ahead of the schedule.
//
// This is the ONE write Sales has on the shipment stage, and it is deliberately
// a request rather than a dispatch: the dispatch team owns the schedule and the
// challan. What Sales owns is the customer's reason for breaking it.
router.post("/:id/early-dispatch", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const pieces = Number(req.body?.pieces);
    const reason = String(req.body?.reason || "").trim();
    if (!Number.isFinite(pieces) || pieces < 1) {
      return res.status(400).json({ success: false, message: "How many pieces are needed early?" });
    }
    // Never pre-coded: dispatch has to read why the schedule is being broken.
    if (reason.length < 8) {
      return res.status(400).json({ success: false, message: "Give dispatch the reason in your own words — one line is enough." });
    }

    /* An early-dispatch ask is about THIS deal's pieces, so it needs this
       deal's order proved. It used to go through without one — and with a
       guessed order, it was checked against another order's packed stock. */
    const { customerRequestId: requestId, orderLink } = await provedOrderForEnquiry(req, enquiry);
    if (!requestId) {
      return res.status(409).json({
        success: false,
        code: "order_not_linked",
        message: `Early dispatch can only be asked for against this deal's confirmed order. ${orderLink.message}`,
        orderLink,
      });
    }

    // Cannot ask for more than is actually packed and still here.
    const workOrders = await WorkOrder.find({ customerRequestId: requestId })
      .select("quantity dispatchedQuantity productionCompletion.operationCompletion").lean();
    const view = buildShipmentView(workOrders, [], []);
    if (pieces > view.totals.ready) {
      return res.status(400).json({
        success: false,
        message: `Only ${view.totals.ready} piece${view.totals.ready === 1 ? " is" : "s are"} packed and still here. `
               + `Ask for that many or fewer.`,
      });
    }

    const neededBy = req.body?.neededBy ? new Date(req.body.neededBy) : null;
    enquiry.earlyDispatchRequests = [
      ...(enquiry.earlyDispatchRequests || []),
      {
        pieces,
        reason,
        neededBy: neededBy && !Number.isNaN(neededBy.valueOf()) ? neededBy : null,
        status: "requested",
        requestedAt: new Date(),
        requestedBy: actor(req),
      },
    ];
    enquiry.updatedBy = actor(req);
    await enquiry.save();

    return res.status(201).json({ success: true, enquiry: await decorate(enquiry, req) });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] POST /:id/early-dispatch", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ─── The commercial ladder ───────────────────────────────────────────────────
//
// GET /api/cms/crm/enquiries/:id/commercial-ladder
//
// The same deal value as it was claimed at each stage — researched at the Lead,
// indicative here, costed at the quote, actual on the order — so the drift
// between them is readable. See services/commercialLadder.js for why a rung is
// never rewritten by a later one.
const { buildCommercialLadder } = require("../../../services/commercialLadder");

router.get("/:id/commercial-ladder", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true })).lean();
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    // The quoted total, when a quotation exists on the linked order. Read from
    // the order rather than recomputed from the costing sheet: the quotation is
    // the number that was actually put in front of the customer.
    /* The "actual" rung is this deal's PROVED order or nothing — a guessed
       order's total would be another deal's number on this deal's ladder. */
    const { customerRequestId: requestId, orderLink } = await provedOrderForEnquiry(req, enquiry);
    const order = requestId
      ? await CustomerRequestModel.findById(requestId)
          .select("requestId grandTotal totalPaidAmount updatedAt quotations.grandTotal").lean()
      : null;
    const quotedTotal = order?.quotations?.length
      ? order.quotations[order.quotations.length - 1]?.grandTotal ?? null
      : null;

    return res.json({
      success: true,
      ...buildCommercialLadder({ enquiry, quotedTotal, order }),
      orderLink,
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /:id/commercial-ladder", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Order Closing Report ─────────────────────────────────────────────────────
//
// The journey's last act: what was ordered against what was delivered, what it
// was meant to cost against what it did, and whether the money is in. See
// services/closingReport.js for what each figure is made of — and for the one
// half (the costing-sheet estimate) the client joins, because the reader for a
// CoWork workbook already lives there.
const { buildClosingReport } = require("../../../services/closingReport");
const { proveOrderLink, closingFactsFor } = require("../../../services/closingVerdict");
const CustomerRequestModel = require("../../../models/Customer_Models/CustomerRequest");

// GET /api/cms/crm/enquiries/:id/closing-report
router.get("/:id/closing-report", salesAuth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid enquiry reference." });
    const enquiry = await Enquiry.findOne(await scoped(req, { _id: req.params.id, isActive: true }));
    if (!enquiry) return res.status(404).json({ success: false, message: "Enquiry not found." });

    const decorated = await decorate(enquiry, req);

    /* ── THE SAME ORDER THE GATE WILL JUDGE (G03) ─────────────────────────
       This used to resolve the order through `resolveRequestId`, which falls
       back to matching the customer's NAME and writing the match onto the
       enquiry, then read that order's work orders, challans and money with no
       proof they belonged to this company. A mis-matched or forged link showed
       one customer another customer's closing facts.

       It now reads the STORED link only and proves it exactly as the close
       gate does (services/closingVerdict.js): the request was raised from
       this enquiry, or — with no origin recorded — its customer is linked by
       this company's account and by no other company's. Unproved means
       nothing about that order is disclosed — and the screen and the gate can
       never disagree about which order is being closed. */
    const proof = await proveOrderLink({ enquiry, scope: (selector) => scoped(req, selector) });
    if (!proof.ok) {
      return res.json({ success: true, linked: false, blockedBy: proof.code, reason: proof.message });
    }
    const requestId = enquiry.customerRequestId;
    const request = proof.request;
    const { workOrders, challans } = await closingFactsFor(requestId);

    if (!workOrders.length) {
      return res.json({
        success: true, linked: true, requestId: String(requestId), workOrders: 0,
        reason: "No work order was ever raised against this order, so there is nothing to report on.",
      });
    }

    const report = buildClosingReport({ workOrders, challans, request, enquiry: enquiry.toObject() });

    // ── The same rule as the costing sheet, applied to the closing report ────
    //
    // Aggregate cost goes to the deal owner and sales managers; nobody else in
    // Sales gets it. And MARGIN COUNTS AS COST: profit = revenue − cost, so
    // showing a margin percentage to someone who can see the invoice total
    // hands them the cost by subtraction. Gating one and not the other would be
    // arithmetic theatre, so they move together.
    //
    // What every viewer keeps is what they can act on: what was delivered, when,
    // whether it is paid, what the customer now owns, and the closing checks.
    const tier = await costingTier(req, enquiry, null);
    if (tier === "floor") {
      const { costing, ...rest } = report;
      return res.json({
        success: true,
        linked: true,
        tier,
        requestId: String(requestId),
        customerName: decorated.customerName,
        report: {
          ...rest,
          costing: null,
          // Per-line cost comes off the lines too — it is the same figure one
          // level down, and leaving it would undo the paragraph above.
          lines: rest.lines.map(({ cost, ...line }) => line),
        },
      });
    }

    return res.json({
      success: true,
      linked: true,
      tier,
      requestId: String(requestId),
      customerName: decorated.customerName,
      report,
    });
  } catch (err) {
    if (answeredTenantRefusal(res, err)) return;
    console.error("[enquiries] GET /:id/closing-report", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
