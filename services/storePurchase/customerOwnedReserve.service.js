"use strict";
// services/storePurchase/customerOwnedReserve.service.js
//
// HOW MUCH OF WHAT IS ON THE SHELF IS NOT OURS.
//
// `RawItem.quantity` is the PHYSICAL total — what a stock-take should find — and
// that is correct: a customer's fabric is on our rack and a count will find it.
// The consequence is the hole this file closes. An ordinary issue reads that
// total, sees enough, and takes it. Nothing in the generic path knows that some
// of it belongs to a job-work customer and is spoken for by one order line.
//
// ── WHY A GUARD AND NOT A SEPARATE BALANCE ──────────────────────────────────
// The alternative is to keep customer stock out of `RawItem.quantity` entirely.
// That breaks the thing the physical total is for: a stock-take would find more
// than the system says, every time, and the discrepancy would be permanent and
// meaningless. So the total stays honest and the AVAILABILITY question gets a
// second term — what is held for somebody else — which is what this computes.
//
// ── IT ONLY EVER SUBTRACTS ──────────────────────────────────────────────────
// A company with no job-work orders has no lots, so every figure here is zero and
// every existing behaviour is unchanged. That is deliberate: a guard that
// altered ordinary issuing would be a worse defect than the one it fixes.

const mongoose = require("mongoose");

const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const str = (v) => String(v ?? "").trim();

/**
 * Customer-owned quantity still HELD for one material, in base units.
 *
 * `variantId` narrows to a variant; omit it for the item's whole total. A
 * location narrows further, because an ordinary issue takes from one place and
 * only the customer stock AT that place is in its way.
 *
 * Only `availableQuantity` counts. Quantity already issued to production has
 * left the shelf, and quantity returned to the customer has left the building —
 * neither is still occupying the physical total, so subtracting either would
 * double-count and refuse ordinary issues that are perfectly fine.
 */
async function heldFor({
  companyId, rawItemId, variantId = null, locationId = null, session = null,
} = {}) {
  if (!companyId || !rawItemId) return 0;
  if (!mongoose.Types.ObjectId.isValid(str(rawItemId))) return 0;

  const where = {
    companyId,
    rawItemId,
    availableQuantity: { $gt: 0 },
  };
  /* A null variantId on a lot means the material has no variants, which is a
     different fact from "any variant" — so the filter is explicit either way. */
  if (variantId) where.variantId = variantId;
  if (locationId) where.locationId = locationId;

  const rows = await CustomerMaterialLot.aggregate([
    { $match: where },
    { $group: { _id: null, held: { $sum: "$availableQuantity" } } },
  ]).session(session);
  return r4(rows[0]?.held || 0);
}

/**
 * What an ORDINARY issue may take: the physical balance less what is held for a
 * customer.
 *
 * @returns {Promise<{physical:number, customerHeld:number, companyAvailable:number}>}
 */
async function companyAvailable({
  companyId, rawItemId, variantId = null, locationId = null, physical = 0, session = null,
} = {}) {
  const customerHeld = await heldFor({ companyId, rawItemId, variantId, locationId, session });
  return {
    physical: r4(physical),
    customerHeld,
    companyAvailable: r4(Math.max(0, r4(physical) - customerHeld)),
  };
}

/**
 * THE ONE GUARD, CALLED FROM THE SHARED STOCK-OUT LAYER.
 *
 * ── WHY IT LIVES HERE AND IS CALLED FROM ONE PLACE ──────────────────────────
 * It began as a check inside the manual stock-adjustment route, which meant the
 * canonical MRF issue path could still hand a customer's fabric to somebody
 * else's order — and, worse, that every route added later would have to remember
 * to repeat it. A rule that must be remembered is a rule that will be forgotten.
 *
 * So it sits in the shared helper every ordinary stock-out already funnels
 * through. A new issuing route inherits the protection by using the same
 * plumbing, which is the only version of this that stays true.
 *
 * ── LOCATION-SCOPED WHERE THE STOCK IS ─────────────────────────────────────
 * A customer's roll in bin B must not block an ordinary issue out of bin A. When
 * the caller names a location, only the customer quantity AT that location is in
 * its way. Without a location the company-wide reserve applies, because then the
 * issue could be satisfied from anywhere — including from the customer's shelf.
 *
 * ── AND ONLY WHAT IS STILL HELD ────────────────────────────────────────────
 * `availableQuantity` alone. Quantity already issued to production has left the
 * shelf and quantity returned to the customer has left the building; subtracting
 * either would double-count and refuse ordinary issues that are perfectly fine.
 */
async function assertOrdinaryIssueAllowed({
  companyId, rawItem, variantId = null, warehouseId = null, locationId = null,
  requested, unit = "", session = null,
}) {
  if (!companyId || !rawItem) return;
  const q = r4(requested);
  if (!(q > 0)) return;

  /* ── THE TWO TERMS MUST DESCRIBE THE SAME SHELF ───────────────────────────
     This is the part that was wrong, and wrong in the direction that lets
     material out: the held quantity was scoped to the LOCATION while the physical
     figure was the whole company's. With 100 in the company, 20 in the rack and 18
     of the rack's being a customer's, the arithmetic read 100 − 18 = 82 available
     and cheerfully approved a draw that had only 2 honest units behind it.

     So when a location is named, the physical basis is that LOCATION's on-hand.
     Both terms then describe the same place, and the subtraction means something. */
  const scopedToLocation = Boolean(warehouseId && locationId);
  let physical;
  if (scopedToLocation) {
    const locStock = require("./locationStock.service");
    /* The session is the FIRST argument, and passing it matters: inside a
       transaction the uncommitted decrements of this very operation must be
       visible, or the check reads a stale balance. */
    physical = r4(await locStock.locationOnHand(
      session || null, companyId, rawItem._id, variantId || null, warehouseId, locationId,
    ));
  } else if (variantId && Array.isArray(rawItem.variants)) {
    physical = r4(rawItem.variants.find((v) => str(v._id) === str(variantId))?.quantity || 0);
  } else {
    physical = r4(rawItem.quantity || 0);
  }

  const held = await heldFor({
    companyId, rawItemId: rawItem._id, variantId,
    /* Scoped to the same location the physical figure came from — see above. */
    locationId: scopedToLocation ? locationId : null,
    session,
  });
  if (held <= 0) return;   // no customer stock in the way; nothing changes

  const ordinary = r4(Math.max(0, physical - held));
  if (r4(ordinary - q) >= 0) return;

  const { fail } = require("./errors");
  const where = locationId ? " at that location" : "";
  throw fail("VALIDATION",
    `${str(rawItem.name)} holds ${physical} ${unit}${where}, but ${held} ${unit} of it is `
    + "customer-supplied material held for a specific order and is not available to issue here. "
    + `Only ${ordinary} ${unit} is the factory's own. Issue customer material through its own `
    + "customer-material document.",
    {
      reason: "CUSTOMER_OWNED_STOCK_NOT_AVAILABLE",
      physical, customerHeld: held, available: ordinary, requested: q, unit,
      ...(locationId ? { locationId: str(locationId), warehouseId: str(warehouseId) } : {}),
    });
}

module.exports = { heldFor, companyAvailable, assertOrdinaryIssueAllowed };
