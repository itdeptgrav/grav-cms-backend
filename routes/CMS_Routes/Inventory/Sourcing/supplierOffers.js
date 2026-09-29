// routes/CMS_Routes/Inventory/Sourcing/supplierOffers.js
//
// Store & Purchase — THE SUPPLIER OFFER REGISTER.
//
// A dated, referenced record of what suppliers actually quoted.
//
// ── STORE'S CONVENTIONS, BECAUSE IT IS STORE'S MASTER ───────────────────────
// The first cut mounted this under Central Costing and gated it on
// `costing.cost.read` / `costing.draft.write` — which meant a storekeeper had
// to hold costing permissions to open their own supplier register. That is a
// permission nobody could explain and an ownership nobody agreed to.
//
// It now uses the Store tenant context, Store capabilities (`sp.read` to look,
// `sp.sourcing.manage` to change — the same grant that already governs
// supplier aliases and their pricing) and the Store idempotent-write helper.
//
// Central Costing consumes offers in Chunk 3.2 through
// `services/storePurchase/supplierOfferRead.service.js`, a narrow in-process
// read that returns plain facts. It does not own this register and cannot
// change it — and it does not call this router over HTTP.

"use strict";

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireTenant, requireCapability, withIdempotency, CAPABILITIES,
} = require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");

const SupplierOffer = require("../../../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const { beginOfferLifecycle } = SupplierOffer;
const offers = require("../../../../services/storePurchase/supplierOffer.service");
/* The company's own country list, so an origin recorded here joins a duty
   table and a CRM address on the same ISO-2 codes rather than on prose. */
const { COUNTRIES } = require("../../../../constants/crm");
const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.code));
const offerRead = require("../../../../services/storePurchase/supplierOfferRead.service");
const { fail, sendError, handle } = require("../../../../services/storePurchase/errors");
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service");

router.use(EmployeeAuthMiddleware);
router.use(requireTenant);

/* Looking is `sp.read`. Changing is `sp.sourcing.manage` — the grant that
   already governs supplier aliases and their prices, because a quotation is
   the same commercial fact written down properly. */
const canRead = requireCapability(CAPABILITIES.READ);
const canWrite = requireCapability(CAPABILITIES.SOURCING_MANAGE);

/* ── THE SERVICE CONTEXT THE FACT READER TAKES ──────────────────────────────
 * `storeFacts` is domain-neutral: it wants a company and a stated reason, not
 * a costing session. Built here from the Store tenant so the supplier, item
 * and unit lookups stay the single definition of "is this yours". */
const factsCtx = (req, reason) => ({
  companyId: req.tenant.companyId,
  actorId: req.user?.id ? String(req.user.id) : "",
  reason,
});

/** Company first, then id — in one query, so a foreign id is simply absent. */
async function load(req) {
  const id = offers.oid(req.params.id);
  /* A malformed id answers as missing: "not a valid id" and "not yours" must
     not be distinguishable, or the shape of an id becomes an oracle. */
  if (!id) throw offers.notFound();
  const found = await SupplierOffer.findOne({
    companyId: req.tenant.companyId,
    _id: new mongoose.Types.ObjectId(id),
  });
  if (!found) throw offers.notFound();
  return found;
}

/** Everything a body may set, validated. Shared by create and revise. */
async function parseOffer(req) {
  const b = req.body || {};

  const supplierId = offers.oid(b.supplierId);
  const itemId = offers.oid(b.itemId);
  if (!supplierId) throw offers.notFound("That supplier");
  if (!itemId) throw offers.notFound("That item");

  const purchaseUom = String(b.purchaseUom || "").trim();
  if (!purchaseUom) throw offers.invalid("A purchase unit is required — a price without its unit is a number.", { field: "purchaseUom" });

  const currency = String(b.currency || "").trim().toUpperCase();
  if (!offers.SUPPORTED_CURRENCIES.includes(currency)) {
    throw offers.invalid("That currency is not one this company records offers in.", { field: "currency" });
  }
  const priceBasis = String(b.priceBasis || "").trim();
  if (!offers.PRICE_BASES.includes(priceBasis)) {
    /* No default. A price whose basis nobody stated cannot be turned into a
       net or a gross figure, and guessing is an 18% error waiting to be
       quoted. */
    throw offers.invalid(
      "Say whether the quoted price excludes or includes tax.",
      { field: "priceBasis", allowed: offers.PRICE_BASES },
    );
  }

  const subject = await offers.resolveSubject(factsCtx(req, "supplier_offer"), {
    supplierId, itemId, variantId: offers.oid(b.variantId), purchaseUom,
  });

  /* ── DECLARED HERE, ABOVE ITS FIRST USE ───────────────────────────────
     It used to sit two hundred lines lower, below the sourcing block that
     calls it for `evidenceNote`. A `const` is in its temporal dead zone until
     its own line runs, so ANY quotation that recorded sourcing threw a
     ReferenceError and answered 500 — invisible for as long as no test sent
     the field, and a hard failure the first time Store did. */
  const text = (v, max = 200) => (offers.present(v) ? String(v).trim().slice(0, max) : undefined);

  /* ── MISSING GST IS NOT 0% ────────────────────────────────────────────── */
  /* ── SOURCING: A TYPE, AND AN ORIGIN WHERE ONE IS OWED ────────────────
     `DOMESTIC` needs no country — a domestic supply's origin is India by
     definition, and asking again would be a field with one correct answer.
     `IMPORTED` without an origin is refused rather than stored: a duty that
     depends on where goods come from cannot be worked out from "somewhere
     else", and a half-recorded fact reads on screen as a recorded one. */
  let sourcing;
  if (offers.present(b.sourcing?.type)) {
    const type = String(b.sourcing.type).trim().toUpperCase();
    if (!["DOMESTIC", "IMPORTED"].includes(type)) {
      throw offers.invalid("Goods are sourced domestically or imported.", { field: "sourcing.type" });
    }
    const origin = String(b.sourcing?.countryOfOrigin ?? "").trim().toUpperCase();
    if (type === "IMPORTED") {
      if (!origin) {
        throw offers.invalid(
          "Imported goods need a country of origin — duty depends on where they came from.",
          { field: "sourcing.countryOfOrigin" },
        );
      }
      if (!COUNTRY_CODES.has(origin)) {
        throw offers.invalid("Choose the country of origin from the list.", { field: "sourcing.countryOfOrigin" });
      }
    }
    /* ── AND WHETHER THE QUOTED RATE ALREADY CARRIES THE DUTY ──────────
       The third fact, and the one nothing recorded before: adding duty on top
       of a rate that already includes it charges it twice, and assuming it
       does not understates every metre. Costing blocks on the gap naming
       Store, so Store has to have somewhere to answer it — a blocker nobody
       can clear is worse than no blocker at all.

       `freightTerms` is NOT this answer. It says whether the rate delivers to
       our warehouse, which is a statement about freight. */
    let dutyInQuotedRate;
    if (offers.present(b.sourcing?.dutyInQuotedRate)) {
      const inc = String(b.sourcing.dutyInQuotedRate).trim().toUpperCase();
      if (!["INCLUDED", "EXCLUDED"].includes(inc)) {
        throw offers.invalid(
          "Say whether the quoted rate already includes customs duty.",
          { field: "sourcing.dutyInQuotedRate" },
        );
      }
      /* Refused rather than dropped on a domestic supply: a quotation for
         goods that never cross a border has no duty to be inside it, and
         storing an answer to a question that does not apply invites a later
         reader to conclude the goods were imported. */
      if (type !== "IMPORTED") {
        throw offers.invalid(
          "Domestic goods have no customs entry, so there is no duty for the rate to include.",
          { field: "sourcing.dutyInQuotedRate" },
        );
      }
      dutyInQuotedRate = inc;
    }
    sourcing = {
      type,
      /* Stored only where it means something. A country against a domestic
         supply would be a second, contradictable answer to a settled fact. */
      ...(type === "IMPORTED" ? { countryOfOrigin: origin } : {}),
      ...(dutyInQuotedRate ? { dutyInQuotedRate } : {}),
      evidenceNote: text(b.sourcing?.evidenceNote, 300),
    };
  }

  let gstRatePercent;
  if (offers.present(b.gstRatePercent)) {
    const n = Number(b.gstRatePercent);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw offers.invalid("A GST rate is a percentage between 0 and 100.", { field: "gstRatePercent" });
    }
    gstRatePercent = n;
  }

  const dateOrUndefined = (v, field) => {
    if (!offers.present(v)) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw offers.invalid(`${field} is not a date.`, { field });
    return d;
  };
  /* The date on the supplier's own paper — not when the price starts, and
     not when somebody typed it in. */
  const quotationDate = dateOrUndefined(b.quotationDate, "quotationDate");
  const effectiveFrom = dateOrUndefined(b.effectiveFrom, "effectiveFrom");
  const validUntil = dateOrUndefined(b.validUntil, "validUntil");
  if (effectiveFrom && validUntil && validUntil.getTime() < effectiveFrom.getTime()) {
    throw offers.invalid("A quotation cannot expire before it takes effect.", { field: "validUntil" });
  }

  return {
    supplierId, supplierName: subject.supplier.name,
    itemId, itemName: subject.item.name, itemSku: subject.item.sku,
    ...(subject.variant ? {
      variantId: subject.variant.variantId,
      /* `storeFacts` returns a variant's `name` and `sku`, not its raw
         `combination` array — reading a field that shape does not have fell
         through to the SKU and labelled every variant with a code. */
      variantLabel: subject.variant.name || subject.variant.sku || "",
    } : {}),
    supplierItemCode: text(b.supplierItemCode, 80),
    supplierItemName: text(b.supplierItemName),
    purchaseUom,
    ...(subject.unit ? { purchaseUomId: subject.unit.unitId } : {}),
    currency,
    unitPriceMinor: offers.requireMinor(b.unitPriceMinor, "unitPriceMinor"),
    priceBasis,
    /* ── DOES THIS RATE INCLUDE GETTING IT HERE? ──────────────────────
       `INCLUSIVE_LANDED` or `EXCLUSIVE`. Absent stays absent: an unanswered
       question is not a landed rate, and a costing says so rather than
       assuming the delivery was free. */
    ...(["INCLUSIVE_LANDED", "EXCLUSIVE"].includes(b.freightTerms)
      ? { freightTerms: b.freightTerms } : {}),
    ...(String(b.incoterm ?? "").trim() ? { incoterm: String(b.incoterm).trim().slice(0, 60) } : {}),
    /* ── WHERE THE GOODS COME FROM ────────────────────────────────────
       Validated above, because "imported from nowhere" is not a sourcing
       fact and storing it would leave a costing unable to say what is
       wrong. Absent stays absent. */
    ...(sourcing ? { sourcing } : {}),
    ...(gstRatePercent !== undefined ? { gstRatePercent } : {}),
    hsnCode: text(b.hsnCode, 20),
    moq: offers.optionalPositive(b.moq, "moq"),
    orderMultiple: offers.optionalPositive(b.orderMultiple, "orderMultiple"),
    /* Zero is same-day, not "not recorded" — see optionalDays. */
    leadTimeDays: offers.optionalDays(b.leadTimeDays, "leadTimeDays"),
    tiers: offers.normaliseTiers(b.tiers),
    quotationReference: text(b.quotationReference, 80),
    ...(quotationDate ? { quotationDate } : {}),
    ...(offers.present(b.document?.label) || offers.present(b.document?.url) ? {
      document: {
        label: text(b.document?.label) || "",
        url: text(b.document?.url, 500) || "",
        storedAt: text(b.document?.storedAt) || "",
      },
    } : {}),
    ...(effectiveFrom ? { effectiveFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    notes: text(b.notes, 2000),
    terms: text(b.terms, 2000),
    _subject: subject,
  };
}

/* ══ LIST ═══════════════════════════════════════════════════════════════════ */

router.get("/", canRead, handle(async (req, res) => {
  const q = { companyId: req.tenant.companyId };
  const { supplierId, itemId, currency, status, search } = req.query;

  /* ── EVERY FILTER IS APPLIED BEFORE THE CAP ─────────────────────────────
     The first cut fetched 200 rows and filtered `state` in JavaScript
     afterwards, then reported the result as the register. With more offers
     than the cap that is a filtered view of an arbitrary 200 — presented as
     complete. Supplier, item, currency and status now narrow the QUERY, and
     the derived state (which depends on the clock, not on a stored field)
     narrows a set that was already scoped by everything else. */
  if (offers.oid(supplierId)) q.supplierId = new mongoose.Types.ObjectId(offers.oid(supplierId));
  if (offers.oid(itemId)) q.itemId = new mongoose.Types.ObjectId(offers.oid(itemId));
  if (currency) q.currency = String(currency).trim().toUpperCase();
  if (status) q.status = String(status).trim().toUpperCase();

  if (search) {
    /* Escaped: a supplier item code legitimately contains "(", "+" and "*",
       and an unescaped one is a 500 or a runaway scan, not a search. */
    const safe = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(safe, "i");
    q.$and = [{ $or: [
      { supplierName: re }, { itemName: re }, { itemSku: re },
      { supplierItemCode: re }, { supplierItemName: re }, { quotationReference: re },
    ] }];
  }

  /* ── A DERIVED STATE THE DATABASE CANNOT INDEX ──────────────────────────
     `current`, `expired` and `future` come from `validUntil`/`effectiveFrom`
     against the clock, so they are narrowed in the query where they map onto
     a date comparison and confirmed in JavaScript afterwards. `withdrawn`,
     `superseded` and `incomplete` ARE stored statuses and map directly. */
  const now = new Date();
  const state = String(req.query.state || "").trim();
  const STORED = { withdrawn: "WITHDRAWN", superseded: "SUPERSEDED", incomplete: "DRAFT" };
  if (STORED[state]) q.status = STORED[state];
  else if (state === "current") {
    q.status = "ACTIVE";
    q.$and = [...(q.$and || []),
      { $or: [{ effectiveFrom: { $lte: now } }, { effectiveFrom: null }, { effectiveFrom: { $exists: false } }] },
      { $or: [{ validUntil: { $gte: now } }, { validUntil: null }, { validUntil: { $exists: false } }] }];
  } else if (state === "expired") {
    q.status = "ACTIVE";
    q.validUntil = { $lt: now };
  } else if (state === "future") {
    q.status = "ACTIVE";
    q.effectiveFrom = { $gt: now };
  }

  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  /* One more than the cap, so "there are more" is a fact rather than an
     inference from a round number. */
  const rows = await SupplierOffer.find(q).sort({ updatedAt: -1 }).limit(limit + 1).lean();
  const capped = rows.length > limit;
  const page = capped ? rows.slice(0, limit) : rows;

  /* ONE clock for the whole page, so two rows cannot disagree about today. */
  let list = page.map((r) => offers.serialize(r, { now }));
  /* The query narrowed it; this only confirms, and cannot now remove a row
     the query would have kept. */
  if (state) list = list.filter((r) => r.state === state);

  return res.json({
    success: true,
    offers: list,
    /* Said, not inferred. A capped register is not a complete one. */
    capped,
    limit,
    asOf: now,
  });
}));

/* ══ WHICH QUOTATIONS COULD SUPPLY THIS QUANTITY ════════════════════════════
 *
 * GET /applicable?itemId&variantId&quantity&uom&asOf
 *
 * Registered BEFORE `/:id`, or Express would read "applicable" as an offer id
 * and answer a non-disclosing 404 for a route that exists.
 *
 * ── EXCLUSIONS ARE RETURNED, NOT FILTERED ───────────────────────────────────
 * Every quotation for the item comes back — the usable ones with the rate that
 * applies at this quantity, the rest with a named reason. A buyer who cannot
 * see why their supplier is missing re-enters the quotation, and now there are
 * two.
 *
 * The lowest applicable rate is reported as INFORMATION. Nothing here selects
 * a supplier: that is a commercial decision with a person's name on it. */
router.get("/applicable", canRead, handle(async (req, res) => {
  const itemId = String(req.query.itemId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(itemId)) {
    throw offers.invalid("Name the item to price.", { field: "itemId" });
  }
  const quantity = offers.present(req.query.quantity) ? String(req.query.quantity).trim() : null;
  const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
  if (Number.isNaN(asOf.getTime())) throw offers.invalid("asOf is not a date.", { field: "asOf" });

  const result = await offerRead.applicableOffersForItem(
    factsCtx(req, "supplier_offer_applicability"),
    {
      itemId,
      variantId: String(req.query.variantId || "").trim() || null,
      quantity,
      requestedUom: String(req.query.uom || req.query.requestedUom || "").trim(),
      asOf,
    },
  );

  return res.json({ success: true, ...result, asOf });
}));

/* ══ ONE OFFER, WITH ITS CHAIN ══════════════════════════════════════════════ */

router.get("/:id", canRead, handle(async (req, res) => {
  const offer = await load(req);
  const now = new Date();

  /* The revision chain, walked in both directions — a reader who opens a
     superseded record must be able to reach the one that replaced it, and a
     reader on the current record must be able to see what it replaced. */
  const chain = await SupplierOffer.find({
    companyId: req.tenant.companyId,
    $or: [
      { _id: offer._id },
      { supersedesOfferId: offer._id },
      ...(offer.supersedesOfferId ? [{ _id: offer.supersedesOfferId }] : []),
      ...(offer.quotationReference ? [{
        quotationReference: offer.quotationReference,
        supplierId: offer.supplierId,
        itemId: offer.itemId,
      }] : []),
    ],
  }).sort({ revision: 1, createdAt: 1 }).lean();

  /* Worked out here rather than on the register, which does not load units. */
  const subject = await offers.resolveSubject(factsCtx(req, "supplier_offer"), {
    supplierId: offer.supplierId, itemId: offer.itemId,
    variantId: offer.variantId, purchaseUom: offer.purchaseUom,
  }).catch(() => null);
  const uom = subject
    ? offers.reconcileUom({ item: subject.item, unit: subject.unit, purchaseUom: offer.purchaseUom })
    : { configured: false, reason: "SUBJECT_UNAVAILABLE", baseUom: null, purchaseUom: offer.purchaseUom };

  return res.json({
    success: true,
    offer: offers.serialize(offer, { now, uom }),
    revisions: chain.map((c) => offers.serialize(c, { now })),
    asOf: now,
  });
}));

/* ══ CREATE ═════════════════════════════════════════════════════════════════ */

router.post("/", canWrite,
  withIdempotency("SUPPLIER_OFFER_CREATE", { target: () => "supplier-offer" }),
  handle(async (req, res) => {
    /* A retry finds its own earlier record before writing — the claim is on
       the offer itself, so the answer does not depend on bookkeeping that
       may have expired. */
    if (req.idempotent?.claimId) {
      const existing = await SupplierOffer.findOne({
        companyId: req.tenant.companyId, creationClaimId: req.idempotent.claimId,
      });
      if (existing) {
        if ((existing.creationRequestHash || "") !== (req.idempotent.requestHash || "")) {
          throw fail("IDEMPOTENCY_KEY_REUSED", "That key was already used for a different offer.");
        }
        return res.json({ success: true, replayed: true, offer: offers.serialize(existing) });
      }
    }

    const parsed = await parseOffer(req);
    delete parsed._subject;

    const created = await SupplierOffer.create({
      ...parsed,
      companyId: req.tenant.companyId,
      status: "DRAFT",
      revision: 1,
      createdByActorId: String(req.user?.id || ""),
      createdByActorName: req.user?.name || "",
      creationClaimId: req.idempotent?.claimId || undefined,
      creationRequestHash: req.idempotent?.requestHash || undefined,
    });

    const body = { success: true, offer: offers.serialize(created) };
    return req.idempotent ? req.idempotent.succeed(201, body) : res.status(201).json(body);
  }));

/* ══ ACTIVATE ═══════════════════════════════════════════════════════════════ */

router.post("/:id/activate", canWrite,
  withIdempotency("SUPPLIER_OFFER_ACTIVATE", { target: (req) => `offer:${req.params.id}` }),
  handle(async (req, res) => {
    const offer = await load(req);
    if (offer.status === "ACTIVE") {
      return res.json({ success: true, replayed: true, offer: offers.serialize(offer) });
    }
    if (offer.status !== "DRAFT") {
      throw fail(offers.CODES.OFFER_NOT_ACTIVE,
        `A ${offer.status.toLowerCase()} offer cannot be published.`, { status: offer.status });
    }
    /* The subject is re-checked at publication: a supplier deactivated
       between drafting and publishing must not be published against. */
    await offers.resolveSubject(factsCtx(req, "supplier_offer"), {
      supplierId: offer.supplierId, itemId: offer.itemId,
      variantId: offer.variantId, purchaseUom: offer.purchaseUom,
    });

    offer.status = "ACTIVE";
    offer.activatedAt = new Date();
    offer.activatedByName = req.user?.name || "";
    /* A price is in force from when it was quoted unless somebody said
       otherwise — but validity is never defaulted. */
    if (!offer.effectiveFrom) offer.effectiveFrom = offer.activatedAt;
    /* Server-owned, like the creator — who last moved this record, taken
       from the session and never from the body. */
    offer.updatedByActorId = String(req.user?.id || "");
    offer.updatedByActorName = req.user?.name || "";
    /* The model refuses every write to a published quotation. Publication is
       one of three named transitions that may touch anything at all, and it
       may touch only these fields — see beginOfferLifecycle. */
    await beginOfferLifecycle(offer, "ACTIVATE").save();

    const body = { success: true, offer: offers.serialize(offer) };
    return req.idempotent ? req.idempotent.succeed(200, body) : res.json(body);
  }));

/* ══ REVISE ═════════════════════════════════════════════════════════════════
 *
 * A correction is a NEW record. The old one keeps saying what was quoted,
 * because somebody was quoted it — rewriting it would destroy the only
 * evidence of the price a costing may already have used.
 */
router.post("/:id/revise", canWrite,
  withIdempotency("SUPPLIER_OFFER_REVISE", { target: (req) => `offer:${req.params.id}` }),
  handle(async (req, res) => {
    /* ── ATOMIC, OR REFUSED BEFORE THE FIRST WRITE ────────────────────────
       The first cut created the new ACTIVE record and saved the predecessor
       as SUPERSEDED afterwards. A failure between them left TWO active
       records for one quotation — and an idempotent retry then found the new
       one and returned success over a chain that was still broken. There is
       no ordering of those two writes that is safe without atomicity, so the
       deployment must supply a transaction. */
    if (!(await unitOfWork.transactionsAvailable())) {
      throw fail("SUPPLIER_OFFER_TRANSACTION_REQUIRED",
        "Revising an offer needs a database that supports transactions, so the new revision and the one it replaces are written together.");
    }

    const previous = await load(req);
    if (previous.supersededByOfferId) {
      throw fail(offers.CODES.OFFER_ALREADY_SUPERSEDED,
        "That offer has already been revised. Revise the current one instead.",
        { supersededByOfferId: String(previous.supersededByOfferId) });
    }
    if (!["ACTIVE", "DRAFT"].includes(previous.status)) {
      throw fail(offers.CODES.OFFER_NOT_ACTIVE,
        `A ${previous.status.toLowerCase()} offer cannot be revised.`, { status: previous.status });
    }

    /* A retry finds its own earlier revision before writing anything. */
    if (req.idempotent?.claimId) {
      const already = await SupplierOffer.findOne({
        companyId: req.tenant.companyId, creationClaimId: req.idempotent.claimId,
      });
      if (already) {
        if ((already.creationRequestHash || "") !== (req.idempotent.requestHash || "")) {
          throw fail("IDEMPOTENCY_KEY_REUSED", "That key was already used for a different revision.");
        }
        return res.json({ success: true, replayed: true, offer: offers.serialize(already) });
      }
    }

    const parsed = await parseOffer(req);
    delete parsed._subject;

    /* ── THE SUBJECT IS THE CHAIN'S IDENTITY, AND THE SERVER OWNS IT ──────
       The Add page locks supplier, item and variant when revising. That is a
       convenience, not a control: a request that changed any of them would
       otherwise splice a different product into an existing quotation's
       history, and every reader after that would see one chain describing two
       things. Refused here, so a disabled input is not the only thing
       standing between a chain and its corruption. */
    const same = (a, b) => String(a || "") === String(b || "");
    if (!same(parsed.supplierId, previous.supplierId)
      || !same(parsed.itemId, previous.itemId)
      || !same(parsed.variantId, previous.variantId)) {
      throw fail(offers.CODES.SUBJECT_MISMATCH,
        "A revision keeps the same supplier, item and variant. Record a separate offer for a different one.",
        {
          expected: {
            supplierId: String(previous.supplierId),
            itemId: String(previous.itemId),
            variantId: previous.variantId ? String(previous.variantId) : null,
          },
        });
    }

    const at = new Date();
    const { result } = await unitOfWork.run(
      { companyId: req.tenant.companyId, actorId: String(req.user?.id || ""), actorName: req.user?.name || "" },
      {
        idempotencyRecord: req.idempotent?.record || null,
        mutate: async (session) => {
          /* ── THE PREDECESSOR IS RE-READ INSIDE THE TRANSACTION ──────────
             The guards above run on a copy loaded before it opened, so two
             concurrent revisions both saw `supersededByOfferId: null` and
             both proceeded — each transaction was individually atomic and
             the pair produced two successors for one quotation.
             Re-reading in the session is what makes them contend: the second
             either sees the first's supersession or loses the write and
             aborts. */
          const live = await SupplierOffer.findOne({
            companyId: req.tenant.companyId, _id: previous._id,
          }).session(session);
          if (!live) throw offers.notFound();
          if (live.supersededByOfferId || live.status === "SUPERSEDED") {
            throw fail(offers.CODES.OFFER_ALREADY_SUPERSEDED,
              "That offer has already been revised. Revise the current one instead.",
              { supersededByOfferId: live.supersededByOfferId ? String(live.supersededByOfferId) : null });
          }

          const [next] = await SupplierOffer.create([{
            ...parsed,
            companyId: req.tenant.companyId,
            status: "ACTIVE",
            activatedAt: at,
            activatedByName: req.user?.name || "",
            effectiveFrom: parsed.effectiveFrom || at,
            revision: (live.revision || 1) + 1,
            supersedesOfferId: live._id,
            createdByActorId: String(req.user?.id || ""),
            createdByActorName: req.user?.name || "",
            updatedByActorId: String(req.user?.id || ""),
            updatedByActorName: req.user?.name || "",
            creationClaimId: req.idempotent?.claimId || undefined,
            creationRequestHash: req.idempotent?.requestHash || undefined,
          }], { session });

          /* The old record steps down in the SAME commit. Its price is
             untouched — somebody was quoted it. */
          live.status = "SUPERSEDED";
          live.supersededByOfferId = next._id;
          live.supersededAt = at;
          live.updatedByActorId = String(req.user?.id || "");
          live.updatedByActorName = req.user?.name || "";
          /* Its price is untouched, and the model now enforces that rather
             than trusting this code to keep meaning it. */
          await beginOfferLifecycle(live, "SUPERSEDE").save({ session });

          return {
            entityType: "SUPPLIER_OFFER",
            entityId: next._id,
            entry: {
              entityType: "SUPPLIER_OFFER",
              entityId: next._id,
              action: "REVISE",
              documentNumber: next.quotationReference || "",
              reason: `Revision ${next.revision} of ${live.quotationReference || "the quotation"}.`,
              at,
            },
            result: { next, previous: live },
          };
        },
      },
    );

    const body = {
      success: true,
      offer: offers.serialize(result.next),
      supersededOffer: offers.serialize(result.previous),
    };
    return req.idempotent ? req.idempotent.succeed(201, body) : res.status(201).json(body);
  }));

/* ══ WITHDRAW ═══════════════════════════════════════════════════════════════ */

router.post("/:id/withdraw", canWrite,
  withIdempotency("SUPPLIER_OFFER_WITHDRAW", { target: (req) => `offer:${req.params.id}` }),
  handle(async (req, res) => {
    const reason = String(req.body?.reason || "").trim();
    /* A withdrawal with no stated reason is a price that vanished. */
    if (reason.length < 4) {
      throw fail(offers.CODES.WITHDRAWAL_REASON_REQUIRED,
        "Say why this offer is being withdrawn — it stays on the record.");
    }
    const offer = await load(req);
    if (offer.status === "WITHDRAWN") {
      return res.json({ success: true, replayed: true, offer: offers.serialize(offer) });
    }
    if (offer.status !== "ACTIVE") {
      throw fail(offers.CODES.OFFER_NOT_ACTIVE,
        `A ${offer.status.toLowerCase()} offer cannot be withdrawn.`, { status: offer.status });
    }

    offer.status = "WITHDRAWN";
    offer.withdrawnAt = new Date();
    offer.withdrawnByName = req.user?.name || "";
    offer.withdrawalReason = reason.slice(0, 500);
    /* Server-owned, like the creator — who last moved this record, taken
       from the session and never from the body. */
    offer.updatedByActorId = String(req.user?.id || "");
    offer.updatedByActorName = req.user?.name || "";
    await beginOfferLifecycle(offer, "WITHDRAW").save();

    const body = { success: true, offer: offers.serialize(offer) };
    return req.idempotent ? req.idempotent.succeed(200, body) : res.json(body);
  }));

router.use((err, _req, res, _next) => sendError(res, err));

module.exports = router;
