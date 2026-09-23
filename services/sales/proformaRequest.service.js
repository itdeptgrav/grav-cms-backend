// services/sales/proformaRequest.service.js
//
// RAISING THE CUSTOMER REQUEST A PROFORMA IS BUILT ON.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// The browser raised it through the generic `POST /customers/:id/create-request`
// endpoint, sending a stock item, a style and A QUANTITY IT HAD COMPOSED
// ITSELF. That endpoint has no enquiry identity, so it could not look up what
// Sales had confirmed — it stored whatever number arrived.
//
// So a stale tab, a replayed request or a direct call could create a draft at
// 500 against a commercial line confirmed at 750. The quotation-pricing command
// would later refuse to price that line, but by then a wrong document existed,
// had a reference, and was what somebody opened and read.
//
// ── SO THE COMMAND NAMES A LINE, NOT A QUANTITY ─────────────────────────────
// The caller says WHICH enquiry, and for each item which product line and which
// style. The quantity is not an input. It is read here from the confirmed
// commercial line, under the acting company's own scope, and stamped.
//
// ── AND EVERY UNREADY STATE IS A REFUSAL ────────────────────────────────────
// No confirmed line, an ambiguous one, a costing that has not caught up, or no
// floor for that exact quantity: the request is not created at all. A proforma
// raised on an unverified quantity is worse than one that could not be raised.
//
// ── THIS DOES NOT REPLACE THE LATER CHECK ───────────────────────────────────
// `quotationPricing` verifies the quantity again when a line is priced, and
// stamps the approved floor and its provenance. Two independent checks on two
// commands: this one decides what the document may say, that one decides what
// may be charged. Neither is the other's excuse to relax.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");
const lineReadiness = require("./lineReadiness.service");
const { nextRequestId } = require("../requestId");
const { planStageTransition } = require("../salesJourneyProgress");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const CODES = Object.freeze({
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  LINE_REFUSED: "PROFORMA_LINE_REFUSED",
  STYLE_UNVERIFIED: "PROFORMA_STYLE_UNVERIFIED",
  /* A proforma already exists for this enquiry and the commercial state has
     MOVED since. Not an error in the request — a decision the caller has to
     make deliberately, by naming the document being superseded. */
  ALREADY_RAISED: "PROFORMA_ALREADY_RAISED",
  /* `supersedes` named something that is not this enquiry's current request. */
  SUPERSESSION_MISMATCH: "PROFORMA_SUPERSESSION_MISMATCH",
});

function fail(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

const Enquiry = () => mongoose.model("Enquiry");
const SalesJourney = () => mongoose.model("SalesJourney");
const CustomerRequest = () => mongoose.model("CustomerRequest");
const StockItem = () => mongoose.model("StockItem");
const SampleStyle = () => mongoose.model("SampleStyle");
const Customer = () => mongoose.model("Customer");

/* ── THE COMMERCIAL STATE, AS ONE STRING ─────────────────────────────────────
 *
 * WHAT MADE TWO DOCUMENTS. `actionKey` answers "is this the same press again?".
 * Two presses of one button mint two keys, so the server saw two commands and
 * honoured both — and a live double-click left one enquiry carrying two
 * customer requests for one confirmed quantity at one approved price. A guard
 * in the browser closes that particular press and nothing else: two tabs, a
 * retried proxy and two people are still two processes, and they do not share
 * a ref.
 *
 * So the identity of the document is not the press. It is WHAT THE DOCUMENT
 * SAYS: this company, this enquiry, and for every invoiced line the confirmed
 * quantity, the approved selling price and the costing version that approved
 * it. Every one of those is read from the issuance authority — none of it can
 * be influenced by a request body — so two callers in the same commercial
 * state always compute the same string, and the unique index on it decides
 * which of them gets to insert.
 *
 * COMPANY-SCOPED BY CONSTRUCTION. A CustomerRequest carries no `companyId` of
 * its own (its company is proved through the enquiry), so the company goes
 * INTO the digest rather than beside it in the index — two companies can never
 * collide on one claim.
 */
function claimOf(companyId, enquiryId, lines) {
  const canonical = [...lines]
    .map((l) => [
      str(l.productLineRef),
      str(l.sampleStyleId),
      String(Number(l.quantity)),
      String(Number(l.unitPriceMinor)),
      str(l.costingVersionId),
    ].join("|"))
    /* Sorted, because "which line came first in the body" is not part of the
       commercial state — two callers listing the same lines in a different
       order are in the same state and must collide. */
    .sort()
    .join("\n");
  return crypto
    .createHash("sha256")
    .update(`proforma:${str(companyId)}:${str(enquiryId)}\n${canonical}`)
    .digest("hex");
}

/** The claim a STORED request stands for, from what its own lines were stamped
 *  with. Used to place a request raised before claims existed, and to tell
 *  "the same state again" from "the state has moved" without re-deriving
 *  anything the reader could get wrong. */
function claimOfStored(companyId, enquiryId, request) {
  const lines = (request?.items || []).map((it) => ({
    productLineRef: it.productLineRef,
    sampleStyleId: it.sampleStyleId,
    quantity: it.totalQuantity,
    unitPriceMinor: Math.round(Number(it.commercialDecision?.unitPriceMinor ?? NaN)),
    costingVersionId: it.commercialDecision?.costingVersionId,
  }));
  if (lines.some((l) => !Number.isFinite(l.unitPriceMinor))) return "";
  return claimOf(companyId, enquiryId, lines);
}

/**
 * This enquiry's CURRENT customer request — the one a proforma is read from
 * and the one a successor would supersede.
 *
 * Newest first, because a superseded predecessor is kept rather than deleted:
 * the latest is the current one, and the chain behind it stays readable.
 */
async function currentRequestFor(ctx, enquiry) {
  const found = await CustomerRequest()
    .find({ "salesOrigin.enquiryId": enquiry._id })
    .sort({ createdAt: -1 })
    .limit(1)
    .lean();
  const request = found[0] || null;
  if (!request) return null;

  /* ── A REQUEST RAISED BEFORE CLAIMS EXISTED STILL COUNTS ────────────────
     Its commercial state is already stamped on its lines, so the claim it
     stands for is computable rather than lost. Backfilled here, once, under a
     filter that writes only while the field is still absent — so two readers
     doing this at the same time cannot disagree, and nothing about what the
     document SAYS is touched. */
  if (!str(request.salesOrigin?.commercialClaimId)) {
    const claim = claimOfStored(ctx.companyId, enquiry._id, request);
    if (claim) {
      await CustomerRequest().updateOne(
        { _id: request._id, "salesOrigin.commercialClaimId": { $in: [null, ""] } },
        { $set: { "salesOrigin.commercialClaimId": claim } },
      ).catch(() => {});
      request.salesOrigin = { ...(request.salesOrigin || {}), commercialClaimId: claim };
    }
  }
  return request;
}

/**
 * WHAT THE SCREEN IS ALLOWED TO SAY ABOUT A RAISED PROFORMA.
 *
 * Read-only, and the only place the Cost & Invoicing page gets this from: the
 * page used to keep offering "Create proforma invoice" beside a document that
 * already existed, because nothing on the read side ever mentioned it. The
 * figures here are the ones the request was STAMPED with — not recomputed, not
 * re-derived from the costing, so what the screen shows is what the document
 * says.
 */
async function currentProformaFor(ctx, enquiryOrId) {
  const enquiry = enquiryOrId?._id
    ? enquiryOrId
    : await Enquiry().findOne({ _id: enquiryOrId, companyId: ctx.companyId, isActive: true })
      .select("_id").lean();
  if (!enquiry) return null;

  const request = await currentRequestFor(ctx, enquiry);
  if (!request) return null;

  const lines = (request.items || []).map((it) => {
    const unitPriceMinor = Math.round(Number(it.commercialDecision?.unitPriceMinor ?? NaN));
    const quantity = Number(it.totalQuantity) || 0;
    return {
      productLineRef: str(it.productLineRef),
      sampleStyleId: str(it.sampleStyleId),
      quantity,
      unitPriceMinor: Number.isFinite(unitPriceMinor) ? unitPriceMinor : null,
      totalMinor: Number.isFinite(unitPriceMinor) ? unitPriceMinor * quantity : null,
    };
  });

  return {
    requestId: str(request.requestId),
    requestRecordId: String(request._id),
    status: str(request.status),
    createdAt: request.createdAt || null,
    supersedesRequestId: request.salesOrigin?.supersedesRequestId
      ? String(request.salesOrigin.supersedesRequestId) : null,
    lines,
  };
}

/* ── RECORDING WHAT WAS RAISED, WHERE THE REST OF THE JOURNEY READS IT ───────
 *
 * Two facts, both already owned elsewhere, neither of which the browser may be
 * the one to decide:
 *
 *   • `enquiry.customerRequestId` — the link Production already walks and the
 *     PI workbench already reuses. It was written by the BROWSER, on opening
 *     the request, which is why an enquiry could carry a raised proforma and
 *     not know it until somebody opened one.
 *   • the journey's Cost & Invoicing stage state — through
 *     `salesJourneyProgress`, the single writer of stage states, using a verb
 *     that only ever lifts `notStarted` to `inProgress`. The lifecycle strip
 *     said "Not Started" beside an existing proforma; it now hears about it
 *     from the command that raised it rather than from a page working it out.
 *
 * Idempotent, and run on a REPLAY as well as a creation — a document raised
 * before this existed is reconciled the next time anybody asks for it. Never
 * fatal: the proforma is already durable by the time this runs, and failing
 * the command because a strip is behind would be the worse outcome.
 */
async function recordProforma(ctx, enquiry, request, { superseding = false } = {}) {
  /* ── THE LINK GOES THROUGH THE ORDER-LINK SERVICE (G02) ────────────────
     This used to write `customerRequestId` only when it was empty (or on a
     supersession). An enquiry already carrying a GUESSED link — the old
     newest-order-for-this-customer lookup, a name match — kept it, so a real
     proforma raised from this enquiry sat beside a guess that still looked
     authoritative. `recordOriginLink` re-reads the request, links it only if
     it is this enquiry's current order, replaces an unproved link with it,
     keeps a link a person confirmed, and claims the order so no second
     enquiry can hold it. Never throws. `superseding` needs no special case:
     a superseded predecessor is no longer current, so the successor replaces
     it by the same rule. */
  await require("../orderBookLink").recordOriginLink(ctx, enquiry._id, request);

  try {
    if (!enquiry.journeyId) return;
    const journey = await SalesJourney().findOne({
      _id: enquiry.journeyId, companyId: ctx.companyId,
    }).select("currentStage stageStates outcome");
    if (!journey) return;
    const plan = planStageTransition(journey, { action: "recordWork", stage: "costQuote" });
    if (plan.noop || !Object.keys(plan.set).length) return;
    await SalesJourney().updateOne({ _id: journey._id }, { $set: plan.set });
  } catch (err) {
    console.error("[proformaRequest] could not record journey progress:", err?.message || err);
  }
}

/** Was this insert refused because another caller already owns this claim? A
 *  duplicate on any OTHER index is an ordinary failure and must still be
 *  reported — renamed rather than swallowed, exactly as `costingCreation`
 *  distinguishes a lost creation-claim race from a broken write. */
function isClaimCollision(err) {
  if (err?.code !== 11000) return false;
  const keys = Object.keys(err.keyPattern || err.keyValue || {});
  return keys.some((k) => String(k).includes("commercialClaimId"));
}

/**
 * Create the customer request for one enquiry's governed lines.
 *
 * @param {object} ctx        `{companyId, actorId}`
 * @param {string} enquiryId
 * @param {object} opts
 * @param {string} opts.customerId   the portal customer to raise it against
 * @param {Array}  opts.items        `[{productLineRef, sampleStyleId, stockItemId, variantId?,
 *                                     specialInstructions?}]` — NO quantity
 * @param {string} [opts.actionKey]  idempotency anchor; an exact retry returns
 *                                   the request the first attempt created
 * @returns {Promise<{requestId, _id, replayed: boolean, lines: Array}>}
 */
async function createForEnquiry(ctx, enquiryId, {
  customerId, items = [], actionKey = "", customerInfo = {}, actor = null,
  /* The document being replaced, named deliberately. A successor is only ever
     raised through this — never by a command that finds the commercial state
     has moved and quietly starts a second one. */
  supersedes = "",
} = {}) {
  if (!ctx?.companyId) throw fail(CODES.VALIDATION, "Your company could not be resolved.");
  if (!isId(enquiryId)) throw fail(CODES.NOT_FOUND, "That enquiry was not found.");
  if (!isId(customerId)) {
    throw fail(CODES.VALIDATION, "Name the portal customer this proforma is for.",
      { field: "customerId", reason: "CUSTOMER_REQUIRED" });
  }
  if (!Array.isArray(items) || !items.length) {
    throw fail(CODES.VALIDATION, "Name at least one product line to invoice.",
      { field: "items", reason: "ITEMS_REQUIRED" });
  }

  /* ── COMPANY FIRST, THEN THE RECORD ──────────────────────────────────
     A foreign enquiry is NOT FOUND, never forbidden: a refusal that varies
     with the answer is a way to enumerate other companies' enquiries. */
  const enquiry = await Enquiry().findOne({
    _id: enquiryId, companyId: ctx.companyId, isActive: true,
  }).lean();
  if (!enquiry) throw fail(CODES.NOT_FOUND, "That enquiry was not found.");

  const customer = await Customer().findById(customerId)
    .select("name email phone profile customerId").lean();
  if (!customer) throw fail(CODES.NOT_FOUND, "That customer was not found.");

  /* ── AN EXACT RETRY REPLAYS ──────────────────────────────────────────
     A lost response must not become a second proforma. Anchored on the
     enquiry and the caller's key, both of which survive the round trip.

     THIS IS NO LONGER THE BOUNDARY, and was never sufficient to be one: it
     answers "is this the same press again?", and two presses of one button
     mint two keys. It stays because it is the cheapest possible answer to the
     commonest case — the same tab retrying — and because it can answer before
     any of the validation below runs. What actually decides whether a second
     document may exist is the commercial claim and the unique index on it,
     further down, which no key, actor or process can get around. */
  const key = str(actionKey);
  if (key) {
    const already = await CustomerRequest().findOne({
      "salesOrigin.enquiryId": enquiry._id,
      "salesOrigin.actionKey": key,
    }).select("_id requestId").lean();
    if (already) {
      await recordProforma(ctx, enquiry, already);
      return {
        _id: already._id, requestId: already.requestId,
        replayed: true, reason: "SAME_ACTION_KEY", lines: [],
      };
    }
  }

  const validated = [];
  const refusals = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const productLineRef = str(item.productLineRef);
    const sampleStyleId = str(item.sampleStyleId);
    const label = () => {
      const row = (enquiry.products || []).find((p) => str(p.productLineRef) === productLineRef);
      return str(row?.product) || `line ${i + 1}`;
    };

    /* ── BOTH HALVES OF THE KEY, OR NOTHING ───────────────────────────
       Half a key can match another colourway's line. Refused by name
       rather than resolved by taking the first. */
    if (!productLineRef || !sampleStyleId) {
      refusals.push({
        index: i, lineName: label(), reason: "LINE_KEY_REQUIRED",
        message: "Name both the product line and the approved style for this item.",
      });
      continue;
    }

    const row = (enquiry.products || [])
      .find((p) => str(p.productLineRef) === productLineRef) || null;
    if (!row) {
      refusals.push({
        index: i, lineName: label(), reason: "LINE_NOT_FOUND",
        message: "That product line is not on this enquiry.",
      });
      continue;
    }

    /* ── THE QUANTITY AND THE PRICE, READ AND NOT RECEIVED ────────────
       `issuanceFor`, not `readinessFor`: issuing a document is not the same
       question as showing an estimate. It requires the APPROVED costing
       version, its primary scenario to be the confirmed quantity, the
       selling price that version was approved WITH, the recorded decision
       that approved it, and — for a below-floor price — the executive
       exception's own reason.

       Every commercial value on the stamped line comes from what it returns.
       Nothing is taken from `item`, which carries only identity. */
    const ready = await lineReadiness.issuanceFor(ctx, enquiry, { productLineRef, sampleStyleId });
    if (!ready.ok) {
      refusals.push({
        index: i, lineName: str(row.product), reason: ready.reason, message: ready.message,
        ...(ready.retryable ? { retryable: true } : {}),
      });
      continue;
    }

    /* ── AND THE STYLE MUST BE LINKED TO THIS EXACT FINISHED ITEM ─────
       A request cannot invent a commercial link between a style and a
       stock item; the link is one SampleStyle already stores. */
    const stockItemId = str(item.stockItemId);
    if (!isId(stockItemId)) {
      refusals.push({
        index: i, lineName: str(row.product), reason: "STOCK_ITEM_REQUIRED",
        message: "Match this product line to a stock item before invoicing it.",
      });
      continue;
    }
    const stockItem = await StockItem().findById(stockItemId)
      .select("name reference baseSalesPrice variants").lean();
    if (!stockItem) {
      refusals.push({
        index: i, lineName: str(row.product), reason: "STOCK_ITEM_NOT_FOUND",
        message: "That stock item was not found.",
      });
      continue;
    }
    const style = await SampleStyle().findById(sampleStyleId)
      .select("production.stockItemId enquiryId").lean();
    if (!style || String(style.enquiryId || "") !== String(enquiry._id)) {
      refusals.push({
        index: i, lineName: str(row.product), reason: "STYLE_NOT_ON_ENQUIRY",
        message: "That style does not belong to this enquiry.",
      });
      continue;
    }
    if (String(style.production?.stockItemId || "") !== String(stockItem._id)) {
      refusals.push({
        index: i, lineName: str(row.product), reason: "STYLE_STOCK_MISMATCH",
        message: "That style is not linked to that stock item.",
      });
      continue;
    }

    const variant = (stockItem.variants || [])
      .find((v) => String(v._id) === str(item.variantId)) || (stockItem.variants || [])[0] || null;

    /* ── THE PRICE IS THE APPROVED COMMERCIAL DECISION ────────────────
       It was `variant.salesPrice || stockItem.baseSalesPrice`. That is the
       CATALOGUE's price: a figure maintained for the item master, written
       there by whoever last edited the product — and, until this change, by
       the customer-approval flow, which fanned one colourway's approved
       price across every variant. A line confirmed at 750 therefore
       invoiced at a price approved for 500, and nothing compared it to the
       floor.

       The catalogue may not price a customer document. What may is the
       figure Sales entered for THIS line, frozen on the costing version a
       reviewer approved — which is what `issuanceFor` returns, in minor
       units, having already refused every state where no such figure
       exists. */
    const unitPrice = ready.unitPriceMinor / 100;

    /* ── THE SERVER'S NUMBERS, NOT THE BODY'S ─────────────────────────
       Neither `item.quantity` nor `item.unitPrice` is ever read. There is
       nothing to compare either against here: the only quantity and price
       this line may carry are the confirmed and approved ones, so a
       submitted figure is not a second opinion, it is noise. */
    validated.push({
      stockItemId: stockItem._id,
      sampleStyleId: style._id,
      stockItemName: stockItem.name,
      stockItemReference: stockItem.reference,
      productLineRef,
      variants: [{
        variantId: variant?._id || null,
        attributes: variant?.attributes || [],
        quantity: ready.quantity,
        specialInstructions: (item.specialInstructions || []).filter(Boolean),
        estimatedPrice: unitPrice * ready.quantity,
      }],
      totalQuantity: ready.quantity,
      totalEstimatedPrice: unitPrice * ready.quantity,
      /* ── WHICH DECISION THIS LINE WAS INVOICED ON ───────────────────
         Stamped so the document can be accounted for later: which costing
         version, which scenario, what the floor was, where the price stood
         against it, who approved it and when. A PI whose price cannot be
         traced to a decision is a figure somebody has to defend from
         memory.

         The floor and the standing are internal commercial facts, so this
         block travels with the REQUEST record and is not part of what a
         customer-facing document renders. */
      commercialDecision: {
        costingId: ready.costingId || null,
        costingVersionId: ready.costingVersionId || null,
        costingVersionNumber: ready.costingVersionNumber ?? null,
        scenarioKey: ready.scenarioKey || null,
        quantity: ready.quantity,
        unitPriceMinor: ready.unitPriceMinor,
        floorPriceMinor: ready.floorPriceMinor,
        standing: ready.standing || null,
        wasBelowFloorException: Boolean(ready.wasException),
        approvedAt: ready.approvedAt || null,
        approvedByName: ready.approvedByName || null,
        decisionReason: ready.decisionReason || null,
      },
    });
  }

  /* ── ALL OR NOTHING ──────────────────────────────────────────────────
     A proforma missing the line somebody meant to invoice is a document
     that looks complete and is not. Every refusal is reported, so fixing
     them takes one pass rather than one per line. */
  if (refusals.length) {
    throw fail(CODES.LINE_REFUSED,
      "Some product lines cannot be invoiced yet.", { lines: refusals });
  }

  /* ── WHAT THIS DOCUMENT WOULD SAY, AS ONE STRING ─────────────────────
     Derived from the validated lines — every figure of which came from the
     issuance authority, not from `items` — so two callers in the same
     commercial state compute the same claim however they arrived. */
  const claim = claimOf(ctx.companyId, enquiry._id, validated.map((v) => ({
    productLineRef: v.productLineRef,
    sampleStyleId: v.sampleStyleId,
    quantity: v.totalQuantity,
    unitPriceMinor: v.commercialDecision.unitPriceMinor,
    costingVersionId: v.commercialDecision.costingVersionId,
  })));

  /* ── ONE CURRENT PROFORMA PER ENQUIRY, AND A SUCCESSOR ONLY ON PURPOSE ─
     Three distinct situations, and the difference between them matters:

       • the SAME commercial state — this is the document that already says
         it. Returned, so a reload-and-press opens what exists rather than
         raising a second one.
       • a MOVED commercial state, with nothing named — refused, typed, and
         carrying the reference of what is already there. The caller decides
         whether the new state should replace it; this command does not
         decide that for them.
       • a MOVED state with the current document named — a successor, marked
         as superseding it. The predecessor is not deleted, not rewritten and
         stays readable. */
  const wanted = str(supersedes);
  const existing = await currentRequestFor(ctx, enquiry);
  if (existing) {
    if (str(existing.salesOrigin?.commercialClaimId) === claim) {
      await recordProforma(ctx, enquiry, existing);
      return {
        _id: existing._id, requestId: existing.requestId,
        replayed: true, reason: "SAME_COMMERCIAL_STATE", lines: [],
      };
    }
    if (!wanted) {
      throw fail(CODES.ALREADY_RAISED,
        `${existing.requestId} was already raised for this enquiry, and the commercial `
        + "state has changed since. Supersede it deliberately, or open it as it stands.",
        {
          reason: "SUPERSESSION_REQUIRED",
          requestId: existing.requestId,
          requestRecordId: String(existing._id),
        });
    }
    if (wanted !== String(existing._id) && wanted !== str(existing.requestId)) {
      throw fail(CODES.SUPERSESSION_MISMATCH,
        `${wanted} is not this enquiry's current proforma. ${existing.requestId} is.`,
        { reason: "NOT_CURRENT", requestId: existing.requestId, requestRecordId: String(existing._id) });
    }
  } else if (wanted) {
    throw fail(CODES.SUPERSESSION_MISMATCH,
      "There is no proforma on this enquiry to supersede.",
      { reason: "NOTHING_TO_SUPERSEDE" });
  }

  /* ── THE UNIQUE INDEX IS THE GUARANTEE ───────────────────────────────
     Everything above is a read, and between a read and an insert sits every
     concurrent caller. On a fresh deployment mongoose builds the index in the
     background, and until it exists every "duplicate" insert succeeds — so
     the first create of the process waits for it rather than racing it.
     Cached no-op afterwards. The same thing `costingCreation` does with the
     creation claim, for the same reason. */
  await CustomerRequest().init();

  const requestId = await nextRequestId(CustomerRequest());
  let created;
  try {
    created = await CustomerRequest().create({
      requestId,
      customerId: customer._id,
      customerInfo: {
        name: customerInfo.name || customer.name,
        email: customerInfo.email || customer.email,
        phone: customerInfo.phone || customer.phone,
        address: customer.profile?.address?.street || "",
        city: customer.profile?.address?.city || "",
        postalCode: customer.profile?.address?.pincode || "",
        description: str(customerInfo.description),
        deliveryDeadline: customerInfo.deliveryDeadline || null,
        preferredContactMethod: "phone",
      },
      items: validated,
      status: "pending",
      priority: "medium",
      createdBySales: true,
      createdBySalesId: actor?.id || ctx.actorId || undefined,
      /* Where it came from, the key that makes a retry replay, the commercial
         state this document stands for — written IN THE SAME INSERT, so there
         is no instant at which the request exists without the claim that makes
         a second one impossible — and, on a successor, what it replaced. */
      salesOrigin: {
        enquiryId: enquiry._id,
        actionKey: key || undefined,
        commercialClaimId: claim,
        ...(existing ? { supersedesRequestId: existing._id } : {}),
      },
      createdAt: new Date(),
    });
  } catch (err) {
    /* ── THE LOST RACE, ANSWERED WITH THE WINNER'S DOCUMENT ────────────
       Another caller — another tab, another person, a retried proxy — was in
       the same commercial state and got there first. There is exactly one
       right answer to give: theirs. Anything else would be the second
       document this whole mechanism exists to prevent. */
    if (isClaimCollision(err)) {
      const winner = await CustomerRequest()
        .findOne({ "salesOrigin.commercialClaimId": claim })
        .select("_id requestId").lean();
      if (winner) {
        await recordProforma(ctx, enquiry, winner);
        return {
          _id: winner._id, requestId: winner.requestId,
          replayed: true, reason: "CONCURRENT_SAME_COMMERCIAL_STATE", lines: [],
        };
      }
    }
    throw err;
  }

  await recordProforma(ctx, enquiry, created, { superseding: Boolean(existing) });

  return {
    _id: created._id,
    requestId: created.requestId,
    replayed: false,
    ...(existing ? { supersededRequestId: String(existing._id), supersededRequestRef: str(existing.requestId) } : {}),
    lines: validated.map((v) => ({
      productLineRef: v.productLineRef,
      sampleStyleId: String(v.sampleStyleId),
      quantity: v.totalQuantity,
    })),
  };
}

module.exports = { CODES, createForEnquiry, currentProformaFor, recordProforma, claimOf };
