"use strict";
// services/storePurchase/autoReservation.service.js
//
// AUTOMATIC RESERVATION — the one place that decides, for an approved material
// request, which usable stock is held against it.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Reserving was a manual act: the store opened a drawer, read a list of
// locations, typed quantities and pressed Reserve. Every approved request
// therefore sat in a "Ready to reserve" queue waiting for a person to do
// arithmetic the server can do exactly, and a request nobody got to was
// indistinguishable from one with no stock behind it.
//
// So approval now attempts the hold. Picking and issuing stay manual, because
// those are claims about the physical world — somebody walked to the rack and
// somebody handed the material over — and the server cannot witness either.
//
// ── IT IS NOT A SECOND RESERVATION ENGINE ───────────────────────────────────
// Every write goes through the existing authority:
//   · `reservation.service.reserveAtLocation`  — the atomic guard, the single
//     document two concurrent reservers contend on
//   · `reservation.service.rollUp` / `deriveStatus` — the record's own arithmetic
//   · `StockReservation`                        — the one hold record, with its
//     partial-unique index on (companyId, mrfLineId) where active
//   · `customerOwnedReserve.heldFor`            — whose stock it is
//   · `unitOfWork.run`                          — transaction + action history
// This file chooses WHICH locations and HOW MUCH. It invents no storage, no
// second availability formula and no second guard.
//
// ── IT NEVER MOVES STOCK ────────────────────────────────────────────────────
// A reservation is a live hold. on-hand is untouched, no LocationMovement is
// written, no StockLedger entry is posted. That remains true of every path
// here — see `autoReservation.movement.test.js`, which asserts it by counting.
//
// ── AND IT NEVER REVERSES AN APPROVAL ───────────────────────────────────────
// `attemptForRequest` resolves rather than throws. An approval that succeeded
// is a decision a person made; a failure to hold stock for it is a store
// problem to be shown and retried, not a reason to un-approve. Callers on the
// approval paths therefore cannot be broken by this file, which is why they
// invoke it after their own commit.

const mongoose = require("mongoose");

const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const StockReservation = require("../../models/CMS_Models/Inventory/Operations/StockReservation");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");

const reservationSvc = require("./reservation.service");
const customerOwnedReserve = require("./customerOwnedReserve.service");
const locStock = require("./locationStock.service");
const unitOfWork = require("./unitOfWork.service");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");

/* The same strict resolver the receipt path uses: it THROWS when no conversion
   path is configured rather than passing the number through unchanged. That
   refusal is the signal this service wants — see the conversion block below. */
const { resolveConversion } = require("./goodsReceipt.service");

const r4 = reservationSvc.r4;
const TOL = reservationSvc.TOL;
const MRF_ENTITY = "MRF";

const str = (v) => String(v ?? "").trim();
const sameId = (a, b) => String(a ?? "") === String(b ?? "");

/* ── THE TRIGGERS ───────────────────────────────────────────────────────────
   Every approval path that can make a line eligible names itself here, so the
   audit answer to "what caused this hold" is a value and not a guess. The list
   is closed: a new approval path that forgets to call this service is a bug
   `autoReservation.coverage.test.js` is written to catch. */
const TRIGGERS = Object.freeze({
  TL_APPROVED: "TL_APPROVED",             // cowork PATCH /:id/tl-approve
  AUTO_FORWARDED: "AUTO_FORWARDED",       // creation on the AUTO_STORE route
  STORE_ON_BEHALF: "STORE_ON_BEHALF",     // mrfRoutes POST /bypass
  INTAKE_CLASSIFIED: "INTAKE_CLASSIFIED", // intakeRequests spawnMrf
  LINE_MATCHED: "LINE_MATCHED",           // a line matched/registered after approval
  MANUAL_RETRY: "MANUAL_RETRY",           // the store asked for another attempt
});

/* ── THE OUTCOMES ───────────────────────────────────────────────────────────
   Five, and they are not interchangeable. The distinction that matters most is
   SHORT vs ATTENTION: "we looked and the shelf is empty" is a purchasing fact
   the requester can act on, and "we could not safely tell" is a data problem
   that must never be dressed as one. */
const OUTCOMES = Object.freeze({
  RESERVED: "RESERVED",   // the whole requested quantity is held
  PARTIAL: "PARTIAL",     // some held, a known remainder short
  SHORT: "SHORT",         // nothing eligible; the full quantity is a purchase question
  SKIPPED: "SKIPPED",     // not a line automatic reservation is for
  ATTENTION: "ATTENTION", // unsafe or ambiguous — a person must look
});

/* Machine-readable causes. The UI words the recovery from these; the message is
   for a human reading the row, not for a branch. */
const REASONS = Object.freeze({
  // SKIPPED
  LINE_CLOSED: "LINE_CLOSED",
  SERVICE_OR_BUY: "SERVICE_OR_BUY",
  NOT_MATCHED: "NOT_MATCHED",
  ALREADY_RESERVED: "ALREADY_RESERVED",
  ALREADY_SATISFIED: "ALREADY_SATISFIED",
  NOT_APPROVED: "NOT_APPROVED",
  // ATTENTION
  ITEM_MISSING: "ITEM_MISSING",
  VARIANT_MISMATCH: "VARIANT_MISMATCH",
  CONVERSION_UNPROVEN: "CONVERSION_UNPROVEN",
  INVALID_QUANTITY: "INVALID_QUANTITY",
  OWNERSHIP_UNPROVEN: "OWNERSHIP_UNPROVEN",
  PREFERRED_WAREHOUSE_UNAVAILABLE: "PREFERRED_WAREHOUSE_UNAVAILABLE",
  SUBSTITUTION_REQUIRES_RELEASE: "SUBSTITUTION_REQUIRES_RELEASE",
  ATTEMPT_FAILED: "ATTEMPT_FAILED",
  // SHORT / PARTIAL
  NO_ELIGIBLE_STOCK: "NO_ELIGIBLE_STOCK",
  PARTIAL_AVAILABILITY: "PARTIAL_AVAILABILITY",
  FULLY_RESERVED: "FULLY_RESERVED",
});

/* The line states that are closed to reservation. `ISSUED`/`RETURNED` lines are
   finished; `REJECTED`/`UNFULFILLED` were decided against. */
const CLOSED_LINE_STATUSES = new Set(["REJECTED", "UNFULFILLED", "ISSUED", "RETURNED"]);

/* A request is with the Store — and therefore its approved lines are eligible —
   on exactly the condition the rest of mrfRoutes already uses. Duplicating the
   predicate would let the two drift; it is re-expressed here because this
   service is also called from cowork and intake, which do not import that
   route. Kept identical deliberately. */
const isStoreActionable = (mrf) =>
  Boolean(mrf && (mrf.tlApproved || mrf.autoForwarded || mrf.creationMode === "BYPASS" || mrf.pmApproved));

const isApprovedRequest = (mrf) =>
  Boolean(mrf && ["APPROVED", "PARTIALLY_ISSUED"].includes(mrf.status) && isStoreActionable(mrf));

// ═══════════════════════════════════════════════════════════════════════════
// ELIGIBILITY — decided before anything is read from the shelf
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Why this line is not a candidate for an automatic hold, or null.
 *
 * SKIPPED, never ATTENTION: none of these is a data problem. A service line
 * follows the Service Order workflow, a closed line is finished, and an
 * unmatched line is waiting for the store's own matching step — which, when it
 * happens, triggers this service again for that line alone.
 */
function skipReason(mrf, line) {
  if (!line) return { reason: REASONS.LINE_CLOSED, message: "That line is not part of this request." };
  if (CLOSED_LINE_STATUSES.has(line.itemStatus)) {
    return { reason: REASONS.LINE_CLOSED, message: "This line is closed — nothing is reserved against it." };
  }
  if (mrf.fulfilmentDecision === "buy_or_service") {
    return {
      reason: REASONS.SERVICE_OR_BUY,
      message: "This request follows the Service Order / purchase workflow, not inventory reservation.",
    };
  }
  if (!line.rawItem) {
    /* UNMATCHED is the ordinary state of a line the requester described rather
       than picked. It is not a failure and must not read as one. */
    return {
      reason: REASONS.NOT_MATCHED,
      message: "Match this line to a catalogue item — stock is reserved automatically once it is matched.",
    };
  }
  if (line.itemStatus === "UNMATCHED") {
    return {
      reason: REASONS.NOT_MATCHED,
      message: "Match this line to a catalogue item — stock is reserved automatically once it is matched.",
    };
  }
  /* A line already fully issued needs no hold. `requestedQty − issuedQty` is
     the quantity still owed, and a zero remainder is satisfied, not short. */
  const owed = r4((Number(line.requestedQty) || 0) - (Number(line.issuedQty) || 0));
  if (owed <= TOL) {
    return { reason: REASONS.ALREADY_SATISFIED, message: "This line has already been issued in full." };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE ALLOCATION PLAN — what would be held, before anything is written
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How much of a location's on-hand an ORDINARY company request may take.
 *
 * ── THE OWNERSHIP TERM, AND WHY IT IS HERE AND NOT ONLY AT ISSUE ───────────
 * `customerOwnedReserve` already guards the shared stock-out helper, so a
 * customer's fabric cannot be ISSUED to somebody else's order. That guard fires
 * when the material is already picked and somebody is standing at the counter.
 * Automatic reservation would otherwise hold that same fabric hours earlier,
 * send a picker for it, and be refused at the last step — so the same authority
 * is asked here, at the moment the hold is chosen.
 *
 * It only ever SUBTRACTS. A company with no job-work lots gets identical
 * numbers to the ones the manual drawer shows today.
 */
async function eligibleAtLocation({ session, companyId, itemId, variantId, warehouseId, locationId, onHandBase, reservedBase }) {
  const customerHeldBase = await customerOwnedReserve.heldFor({
    companyId, rawItemId: itemId, variantId: variantId || null, locationId, session,
  });
  /* Three terms, one shelf: what is physically there, what is already held for
     other requests, and what is not ours at all. */
  const free = r4(onHandBase - reservedBase - customerHeldBase);
  return { eligibleBase: r4(Math.max(0, free)), customerHeldBase };
}

/**
 * Whether ownership at a location can be stated at all.
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────
 * A customer lot carries `locationId`, and that is how `heldFor` attributes a
 * customer's stock to one shelf. A lot with stock still available and NO
 * location is unattributable: the material is somewhere in this warehouse and
 * nothing says where. Subtracting it from no location would let an automatic
 * hold take it, and subtracting it from every location would refuse holds that
 * are perfectly fine.
 *
 * Neither is honest, so the line stops and says so. This is the case the brief
 * calls "ownership cannot be safely separated using current data" — the one
 * place where guessing would hand a customer's material to somebody else.
 */
async function unplacedCustomerStock({ session, companyId, itemId, variantId }) {
  const where = {
    companyId,
    rawItemId: itemId,
    availableQuantity: { $gt: 0 },
    $or: [{ locationId: null }, { locationId: { $exists: false } }],
  };
  if (variantId) where.variantId = variantId;
  const rows = await CustomerMaterialLot.aggregate([
    { $match: where },
    { $group: { _id: null, held: { $sum: "$availableQuantity" } } },
  ]).session(session || null);
  return r4(rows[0]?.held || 0);
}

/**
 * The ordered list of (location, quantity) this line would be held at.
 *
 * ── THE ORDER IS THE EXISTING POLICY, NOT A NEW ONE ────────────────────────
 * `reservation.service.orderedCandidates` already ranks the requested warehouse
 * first, then every usable location by warehouse short name and location code.
 * That ordering is reused verbatim so the automatic choice is the same one the
 * manual drawer presents at the top of its list — a store user who checks the
 * server's work sees their own list, in their own order.
 *
 * ── AND THE PREFERENCE IS A REQUIREMENT WHERE ONE WAS GIVEN ────────────────
 * Ranking alone would let an alphabetically-earlier warehouse win once the
 * preferred one ran out, which silently overrides a requester who named where
 * the material must come from. So a line carrying `warehouseId` allocates ONLY
 * within that warehouse; a shortfall there is a shortfall, not a reason to
 * quietly source it elsewhere.
 */
async function planAllocations({
  session, companyId, line, factor, warehouses, neededBase,
}) {
  const preferredWarehouseId = line.warehouseId || null;
  const itemId = line.rawItem;
  const variantId = line.variantId || null;

  if (preferredWarehouseId) {
    const wanted = (warehouses || []).find((w) => sameId(w._id, preferredWarehouseId));
    /* Named and unusable is a data problem, not an empty shelf: the request says
       "from this warehouse" and this warehouse cannot answer. */
    if (!wanted || wanted.status !== "Active") {
      return {
        attention: {
          reason: REASONS.PREFERRED_WAREHOUSE_UNAVAILABLE,
          message: "This line asks for a specific warehouse, and that warehouse is missing or not active. Choose the stock by hand or correct the warehouse.",
        },
      };
    }
  }

  const unplaced = await unplacedCustomerStock({ session, companyId, itemId, variantId });
  if (unplaced > TOL) {
    return {
      attention: {
        reason: REASONS.OWNERSHIP_UNPROVEN,
        message: `${unplaced} of this material is customer-supplied and is not recorded at a location, so GRAV cannot tell which shelf is the factory's own. Place the customer lot, or choose the stock by hand.`,
      },
    };
  }

  const pool = preferredWarehouseId
    ? (warehouses || []).filter((w) => sameId(w._id, preferredWarehouseId))
    : warehouses;
  const candidates = reservationSvc.orderedCandidates(pool, { preferredWarehouseId });

  let remainingBase = r4(neededBase);
  const plan = [];
  for (const c of candidates) {
    if (remainingBase <= TOL) break;
    const onHandBase = r4(await locStock.locationOnHand(
      session, companyId, itemId, variantId, c.warehouse._id, c.location._id,
    ));
    if (onHandBase <= TOL) continue;
    const reservedBase = await reservationSvc.reservedBaseAt({
      session, companyId, itemId, variantId,
      warehouseId: c.warehouse._id, locationId: c.location._id,
    });
    const { eligibleBase } = await eligibleAtLocation({
      session, companyId, itemId, variantId,
      warehouseId: c.warehouse._id, locationId: c.location._id,
      onHandBase, reservedBase,
    });
    if (eligibleBase <= TOL) continue;

    /* Never more than the request needs — the remainder, not the shelf. */
    const takeBase = r4(Math.min(eligibleBase, remainingBase));
    if (takeBase <= TOL) continue;
    plan.push({
      warehouse: c.warehouse,
      location: c.location,
      baseQty: takeBase,
      /* The business-unit figure is derived from the base one, so the two can
         never disagree about the same hold. */
      qty: factor > 0 ? r4(takeBase / factor) : takeBase,
      onHandBase,
    });
    remainingBase = r4(remainingBase - takeBase);
  }
  return { plan, remainingBase: r4(Math.max(0, remainingBase)) };
}

// ═══════════════════════════════════════════════════════════════════════════
// ONE LINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Attempt the hold for one line and return what happened.
 *
 * Resolves for every outcome including failure. The caller records the result
 * on the line; nothing here throws into an approval.
 */
async function attemptForLine({ tenant, mrf, line, warehouses, trigger, actorName = "", actorId = null }) {
  const companyId = tenant.companyId;
  /* ── WHO THE AUDIT TRAIL SAYS DID THIS ──────────────────────────────────
     `SpActionHistory.actorId` is required, and it is read off the unit-of-work
     CONTEXT rather than the entry. An automatic hold often has no human behind
     it — an auto-forwarded request reserves with nobody watching — and the
     honest record of that is the `system` actor type the schema already
     defines, not a person's id borrowed to satisfy a validator. */
  const ctx = {
    ...tenant,
    actorId: String(actorId || tenant.actorId || "system"),
    actorType: actorId || tenant.actorId ? (tenant.actorType || "employee") : "system",
    actorName: actorName || tenant.actorName || "GRAV (automatic)",
  };

  const skip = skipReason(mrf, line);
  if (skip) return { outcome: OUTCOMES.SKIPPED, ...skip, reservedQty: 0, shortQty: 0 };

  const requested = r4(Number(line.requestedQty) || 0);
  const issued = r4(Number(line.issuedQty) || 0);
  const owed = r4(Math.max(0, requested - issued));
  /* `Number(null)` and `Number("")` are both 0 and both finite, so a blank
     quantity would otherwise read as a valid zero and be reported as satisfied
     rather than as the missing figure it is. */
  if (!Number.isFinite(Number(line.requestedQty)) || requested <= 0 || !str(line.unit)) {
    return {
      outcome: OUTCOMES.ATTENTION,
      reason: REASONS.INVALID_QUANTITY,
      message: "This line has no usable quantity or unit, so nothing can be held against it.",
      reservedQty: 0, shortQty: 0,
    };
  }

  /* An existing active hold is this line's answer already. Re-running must
     return it rather than adding a second one — the partial-unique index would
     refuse that anyway, and a refusal is not a result. */
  const existing = await StockReservation.findOne({ companyId, mrfLineId: line._id, active: true }).lean();
  if (existing) {
    if (!sameId(existing.rawItemId, line.rawItem)) {
      return {
        outcome: OUTCOMES.ATTENTION,
        reason: REASONS.SUBSTITUTION_REQUIRES_RELEASE,
        message: "This line is held against a different item. Release that reservation before reserving a substitute.",
        reservedQty: r4(existing.reservedQty || 0), shortQty: 0,
      };
    }
    const short = r4(Math.max(0, requested - r4(existing.reservedQty || 0)));
    return {
      outcome: short > TOL ? OUTCOMES.PARTIAL : OUTCOMES.RESERVED,
      reason: REASONS.ALREADY_RESERVED,
      message: short > TOL
        ? "Stock was already held for this line; the remainder is still short."
        : "Stock was already held for this line.",
      reservedQty: r4(existing.reservedQty || 0),
      shortQty: short,
      reservationId: String(existing._id),
      idempotent: true,
    };
  }

  const raw = await RawItem.findById(line.rawItem).select("unit customUnit variants name").lean();
  if (!raw) {
    return {
      outcome: OUTCOMES.ATTENTION,
      reason: REASONS.ITEM_MISSING,
      message: "The matched catalogue item no longer exists, so nothing can be held against this line.",
      reservedQty: 0, shortQty: 0,
    };
  }
  if (line.variantId && !(raw.variants || []).some((v) => sameId(v._id, line.variantId))) {
    return {
      outcome: OUTCOMES.ATTENTION,
      reason: REASONS.VARIANT_MISMATCH,
      message: "The line's variant no longer exists on the catalogue item.",
      reservedQty: 0, shortQty: 0,
    };
  }

  /* ── THE CONVERSION MUST BE PROVEN, NOT ASSUMED ─────────────────────────
     A missing conversion resolves to a factor of 1 for display, which is
     harmless on a screen and dangerous here: reserving 50 "box" as 50 "m"
     would hold a fiftieth of the material and report success. */
  const baseUnit = line.baseUnit || raw.customUnit || raw.unit || line.unit;
  let factor = 0;
  try {
    /* Throws when no path is configured — which is the point. Catching it and
       leaving `factor` at 0 turns a missing conversion into a visible
       Needs-attention line instead of a hold computed from a guess. */
    const conv = await resolveConversion({ quantity: 1, fromUnit: line.unit, toUnit: baseUnit });
    factor = Number(conv?.factor) || 0;
  } catch { factor = 0; }
  if (!(factor > 0)) {
    return {
      outcome: OUTCOMES.ATTENTION,
      reason: REASONS.CONVERSION_UNPROVEN,
      message: `GRAV cannot convert ${line.unit} to ${baseUnit} for this material, so it cannot tell how much stock to hold. Record the conversion, or choose the stock by hand.`,
      reservedQty: 0, shortQty: 0,
    };
  }

  const neededBase = r4(owed * factor);

  let result = null;
  try {
    await unitOfWork.run(ctx, {
      entityType: MRF_ENTITY,
      entityId: mrf._id,
      mutate: async (session) => {
        const planned = await planAllocations({
          session, companyId, line, factor, warehouses, neededBase,
        });
        if (planned.attention) {
          result = { outcome: OUTCOMES.ATTENTION, ...planned.attention, reservedQty: 0, shortQty: owed };
          return {
            entityType: MRF_ENTITY, entityId: mrf._id, result: null,
            entry: {
              entityType: MRF_ENTITY, entityId: mrf._id, documentNumber: mrf.mrfNumber,
              action: "AUTO_RESERVE_ATTENTION",
              metadata: { mrfLineId: String(line._id), reason: planned.attention.reason, trigger },
            },
          };
        }

        const placed = [];
        const doc = new StockReservation({
          companyId, siteId: tenant.siteId || null,
          mrfId: mrf._id, mrfNumber: mrf.mrfNumber, mrfLineId: line._id,
          requestedForName: mrf.requestedForName || "", requestedForDept: mrf.requestedForDept || "",
          neededBy: mrf.neededBy || null,
          rawItemId: line.rawItem, variantId: line.variantId || null,
          variantCombination: line.variantCombination || [],
          itemName: line.rawItemName, sku: line.rawItemSku,
          unit: line.unit, requestedQty: requested,
          baseUnit, conversionFactor: factor, requestedBaseQty: r4(requested * factor),
          allocations: [],
          reservedBy: actorId, reservedByName: actorName || "GRAV (automatic)",
          reservedAt: new Date(),
          reason: `Automatic reservation on ${trigger}.`,
        });

        for (const p of planned.plan) {
          /* The atomic guard is the serialization point — re-read on-hand inside
             the transaction and let the ONE guarded document write decide. A
             loser here has changed nothing and simply gets less. */
          const onHand = await locStock.locationOnHand(
            session, companyId, line.rawItem, line.variantId || null, p.warehouse._id, p.location._id,
          );
          const ok = await reservationSvc.reserveAtLocation({
            session, companyId, itemId: line.rawItem, variantId: line.variantId || null,
            warehouseId: p.warehouse._id, locationId: p.location._id,
            requestedBase: p.baseQty, onHand,
          });
          /* ── LOSING THE RACE IS NOT AN ERROR ───────────────────────────────
             Another reserver took this location's last stock between the plan
             and the write. The correct behaviour is to hold less, not to fail:
             a partial hold plus an honest shortfall is exactly what the request
             is owed. */
          if (!ok) continue;
          doc.allocations.push({
            warehouseId: p.warehouse._id, warehouseName: p.warehouse.name || "",
            warehouseShortName: p.warehouse.shortName || "",
            locationId: p.location._id, locationCode: p.location.code || "",
            locationName: p.location.name || "",
            reservedQty: p.qty, reservedBaseQty: p.baseQty,
          });
          placed.push({ locationCode: p.location.code || "", qty: p.qty, baseQty: p.baseQty });
        }

        const reservedQty = r4(placed.reduce((t, p) => t + p.qty, 0));
        if (reservedQty <= TOL) {
          /* Nothing held — no record is written at all. An empty reservation
             would occupy the one-active-per-line slot and make a later retry
             look like a duplicate. */
          result = {
            outcome: OUTCOMES.SHORT,
            reason: REASONS.NO_ELIGIBLE_STOCK,
            message: "No eligible stock is on the shelf for this line — the full quantity is a purchasing decision.",
            reservedQty: 0, shortQty: owed,
          };
          return {
            entityType: MRF_ENTITY, entityId: mrf._id, result: null,
            entry: {
              entityType: MRF_ENTITY, entityId: mrf._id, documentNumber: mrf.mrfNumber,
              action: "AUTO_RESERVE_SHORT",
              metadata: { mrfLineId: String(line._id), shortQty: owed, trigger },
            },
          };
        }

        Object.assign(doc, reservationSvc.rollUp(doc));
        doc.history.push({
          action: "RESERVE",
          qty: reservedQty,
          baseQty: r4(placed.reduce((t, p) => t + p.baseQty, 0)),
          byId: actorId, byName: actorName || "GRAV (automatic)",
          reason: `Automatic reservation on ${trigger}.`,
          allocations: placed,
        });
        await doc.save({ session });

        const short = r4(Math.max(0, requested - reservedQty));
        result = {
          outcome: short > TOL ? OUTCOMES.PARTIAL : OUTCOMES.RESERVED,
          reason: short > TOL ? REASONS.PARTIAL_AVAILABILITY : REASONS.FULLY_RESERVED,
          message: short > TOL
            ? `Held ${reservedQty} ${line.unit}; ${short} ${line.unit} is short and needs a purchase.`
            : "Held in full — ready to pick.",
          reservedQty, shortQty: short,
          reservationId: String(doc._id),
          allocations: placed,
        };
        return {
          entityType: MRF_ENTITY, entityId: mrf._id, result: doc,
          entry: {
            entityType: MRF_ENTITY, entityId: mrf._id, documentNumber: mrf.mrfNumber,
            action: "STOCK_RESERVED",
            metadata: {
              mrfLineId: String(line._id), reservedQty, shortQty: short,
              automatic: true, trigger,
              locations: placed.map((p) => p.locationCode),
            },
          },
        };
      },
    });
  } catch (e) {
    /* ── A FAILED ATTEMPT IS A VISIBLE STATE, NOT A THROWN ERROR ───────────
       The approval stands. The line goes to Needs attention carrying why, and
       the store can try again — which is a far better outcome than an approval
       that rolls back because a shelf read timed out. */
    return {
      outcome: OUTCOMES.ATTENTION,
      reason: REASONS.ATTEMPT_FAILED,
      message: `Automatic reservation could not be completed: ${e?.message || "unknown error"}. The approval stands — try again.`,
      reservedQty: 0, shortQty: owed,
    };
  }

  return result || {
    outcome: OUTCOMES.ATTENTION,
    reason: REASONS.ATTEMPT_FAILED,
    message: "Automatic reservation produced no result. The approval stands — try again.",
    reservedQty: 0, shortQty: owed,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ONE REQUEST — the entry point every approval path calls
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Attempt automatic reservation for every eligible line of one approved request.
 *
 * @param {object}  opts
 * @param {object}  opts.tenant    resolved tenant context (companyId, siteId)
 * @param {string}  opts.mrfId     the request
 * @param {string}  opts.trigger   one of TRIGGERS — which approval path
 * @param {string}  [opts.actorName]
 * @param {*}       [opts.actorId]
 * @param {string}  [opts.lineId]  a single line (the match/register trigger)
 * @returns {Promise<{attempted:boolean, lines:Array, reason?:string}>}
 *
 * RESOLVES on every path. Approval callers must not be able to fail because of
 * this, so the only thing a caller ever needs to do with the result is ignore
 * it — the durable record is written onto the request either way.
 */
async function attemptForRequest({ tenant, mrfId, trigger, actorName = "", actorId = null, lineId = null }) {
  const out = { attempted: false, trigger, lines: [] };
  try {
    if (!tenant?.companyId || !mrfId) return { ...out, reason: "NO_CONTEXT" };
    if (!Object.values(TRIGGERS).includes(trigger)) return { ...out, reason: "UNKNOWN_TRIGGER" };

    /* ── TENANT ISOLATION, INCLUDING FOR REQUESTS THAT CARRY NO COMPANY ────
       `MRF.companyId` is optional and genuinely absent on requests raised
       through the Requests desk, which spawns them without stamping tenancy
       (see `intakeRequests.spawnMrf`, and the audit note in the task doc).
       A plain `findOne({_id, companyId})` would therefore silently never find
       those requests, and automatic reservation would quietly do nothing for a
       whole origin.

       So the read is by id and the ownership test is explicit: a request that
       names a company must name THIS one, and a request that names none is
       fulfilled against the caller's resolved company — which is the only
       company its own route could have been acting for. Neither branch lets a
       request belonging to another company be reserved against. */
    const mrf = await MRF.findOne({ _id: mrfId });
    if (!mrf) return { ...out, reason: "NOT_FOUND" };
    if (mrf.companyId && !sameId(mrf.companyId, tenant.companyId)) {
      return { ...out, reason: "TENANT_MISMATCH" };
    }
    if (!isApprovedRequest(mrf)) return { ...out, reason: REASONS.NOT_APPROVED };

    /* Company-scoped and Active — the same set the manual reserve drawer reads.
       Scoped by companyId directly rather than through `tenantFilter`, whose
       legacy read-through returns an `$or` that a second condition would have
       to be folded into rather than assigned alongside. */
    const warehouses = await Warehouse.find({ companyId: tenant.companyId, status: "Active" }).lean();

    const lines = lineId
      ? (mrf.items || []).filter((l) => sameId(l._id, lineId))
      : (mrf.items || []);

    for (const line of lines) {
      const res = await attemptForLine({
        tenant, mrf, line, warehouses, trigger, actorName, actorId,
      });
      /* The attempt is recorded on the line whatever it concluded — including
         SKIPPED, because "this is a service line" is an answer and the queue
         must not keep offering to try again. */
      line.autoReserve = {
        attemptedAt: new Date(),
        outcome: res.outcome,
        reason: res.reason || "",
        message: res.message || "",
        reservedQty: r4(res.reservedQty || 0),
        shortQty: r4(res.shortQty || 0),
        trigger,
        actorName: actorName || "GRAV (automatic)",
        attempts: (Number(line.autoReserve?.attempts) || 0) + 1,
      };
      out.lines.push({
        mrfLineId: String(line._id),
        itemName: line.rawItemName || "",
        unit: line.unit || "",
        requestedQty: r4(Number(line.requestedQty) || 0),
        ...res,
      });
    }

    out.attempted = true;
    /* Saved once, after every line, so one shelf read cannot leave half the
       request describing an attempt that the other half never had. */
    await mrf.save();
    return out;
  } catch (e) {
    /* The last resort. An approval that has already been committed must survive
       anything this file does. */
    return { ...out, reason: "ATTEMPT_FAILED", error: e?.message || String(e) };
  }
}

/* ══ THE WORK STAGES ═══════════════════════════════════════════════════════
 *
 * ── WHY "READY TO RESERVE" IS GONE ─────────────────────────────────────────
 * It was the queue's largest group and it was a queue of arithmetic: approved
 * demand that the server could already see stock for, waiting for a person to
 * choose the same locations the server would have chosen. Automatic reservation
 * empties it by construction, so leaving it on screen would leave a daily stage
 * that is either always empty or means something it no longer means.
 *
 * What replaces it is the honest question the stage was standing in for: did
 * the hold succeed, partly succeed, find nothing, or fail to be attempted?
 */
const STAGES = Object.freeze({
  READY_TO_PICK: { label: "Ready to pick", order: 1 },
  PARTLY_RESERVED: { label: "Partly reserved", order: 2 },
  SHORT: { label: "Short", order: 3 },
  PARTLY_ISSUED: { label: "Partly issued", order: 4 },
  NEEDS_ATTENTION: { label: "Needs attention", order: 5 },
  COMPLETED: { label: "Completed", order: 6 },
});

/* The existing reservation groups, said in the new stage vocabulary.
 *
 * `reservation.service.queueGroup` stays the authority for what a HELD line is
 * doing — this only renames its answer so a queue of reservations and a queue
 * of unreserved lines can be read as one list. READY_TO_RESERVE maps to
 * NEEDS_ATTENTION rather than disappearing: on a reservation record it means a
 * hold that ended up holding nothing, which is exactly a thing to look at. */
const GROUP_TO_STAGE = Object.freeze({
  READY_TO_PICK: "READY_TO_PICK",
  PARTLY_RESERVED: "PARTLY_RESERVED",
  PARTLY_ISSUED: "PARTLY_ISSUED",
  BACKORDERED: "SHORT",
  ATTENTION: "NEEDS_ATTENTION",
  DONE: "COMPLETED",
  READY_TO_RESERVE: "NEEDS_ATTENTION",
});
const stageOfGroup = (g) => GROUP_TO_STAGE[g] || "NEEDS_ATTENTION";

/**
 * The stage an UNRESERVED approved line belongs to.
 *
 * Only ever called for a line with no active StockReservation — a line that has
 * one is described by the reservation, and `reservation.service.queueGroup` is
 * still the authority for that.
 *
 * ── THE DISTINCTION THIS EXISTS TO PROTECT ─────────────────────────────────
 * `attemptedAt === null` means nobody has looked. Every other answer means
 * somebody looked and this is what they found. Collapsing the two would file
 * every request approved before this feature existed under "Short", which is a
 * purchasing instruction nobody issued — the request might be sitting on a full
 * shelf. So an unattempted line is Needs attention with a retry, and says so.
 *
 * @returns {{stage:string, retryable:boolean, reason:string, message:string}|null}
 *          null when the line does not belong in the queue at all.
 */
function lineStage(line) {
  const a = line?.autoReserve || {};
  if (!a.attemptedAt) {
    return {
      stage: "NEEDS_ATTENTION",
      retryable: true,
      reason: "NEVER_ATTEMPTED",
      message: "Stock was never automatically reserved for this line — it was approved before GRAV did this, or an attempt did not finish.",
    };
  }
  switch (a.outcome) {
    case OUTCOMES.SKIPPED:
      /* Not queue work: a service line, a closed line, or one already issued.
         It is not hidden — it is simply not a reservation to act on. */
      return null;
    case OUTCOMES.SHORT:
      return {
        stage: "SHORT", retryable: true, reason: a.reason || REASONS.NO_ELIGIBLE_STOCK,
        message: a.message || "No eligible stock was found — this is a purchasing decision.",
      };
    case OUTCOMES.ATTENTION:
      return {
        stage: "NEEDS_ATTENTION", retryable: true, reason: a.reason || REASONS.ATTEMPT_FAILED,
        message: a.message || "Automatic reservation could not be completed safely.",
      };
    default:
      /* RESERVED or PARTIAL but nothing active: the hold was issued or released
         after the fact. The reservation record describes that, not this. */
      return null;
  }
}

/**
 * Fire-and-forget form for the approval routes.
 *
 * The approval has already been committed and responded to; this runs after it
 * and can only ever add a hold. Callers use it so a slow shelf read cannot
 * delay the approver's response.
 */
function attemptInBackground(opts) {
  return Promise.resolve()
    .then(() => attemptForRequest(opts))
    .catch((e) => { console.error("[autoReservation]", e?.message || e); return null; });
}

module.exports = {
  TRIGGERS, OUTCOMES, REASONS, STAGES, lineStage, stageOfGroup, GROUP_TO_STAGE,
  isStoreActionable, isApprovedRequest, skipReason,
  planAllocations, unplacedCustomerStock, eligibleAtLocation,
  attemptForLine, attemptForRequest, attemptInBackground,
};
