"use strict";
/**
 * services/centralCosting/freightSource.service.js
 *
 * THE FACTS AN OUTBOUND FREIGHT LINE IS BUILT FROM, READ COMPANY-SCOPED.
 *
 * ── EVERY IDENTITY IS RE-READ HERE ──────────────────────────────────────────
 * The enquiry names an address and a warehouse by id. Both are read back
 * within the company the costing is already authorised for, and every snapshot
 * — the city a rate is quoted against, the warehouse a lane starts from — is
 * taken from what came back. A record that belongs to another company and one
 * that does not exist produce the same empty answer, because saying which
 * would confirm a record the caller cannot see.
 *
 * ── AND THE BILLING ADDRESS IS NEVER THE SHIPPING ADDRESS ───────────────────
 * `CRMAddress` has separate types precisely because they differ. Nothing here
 * falls back from one to the other: an enquiry with no shipping destination is
 * a gap owned by Sales, and quietly delivering to the accounts department is
 * worse than saying so.
 */

const mongoose = require("mongoose");

const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const {
  resolveShippingDestination, REASON: SHIPPING_REASON,
} = require("./shippingDestination.service");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");

const { resolveArrangement, TREATMENT, PREPAID_TREATMENT, OWNER, CODES } = require("./freight.service");

const str = (v) => String(v ?? "").trim();
const oid = (v) => (mongoose.Types.ObjectId.isValid(String(v || "")) ? String(v) : "");

/**
 * Everything the freight family needs about one enquiry, or an honest account
 * of what is missing and whose it is.
 *
 * Returns `{ arrangement, treatment, origin, destination, mode, deliveryCount,
 * shipment, missing[] }`. Nothing is defaulted into a claim: an unanswered
 * mode is null, not "road", and an unanswered delivery count is null, not one.
 */
async function readFreightSource(ctx, { enquiryId, style = null, asOf = new Date() } = {}) {
  const missing = [];
  const gap = (code, owner, message, extra = {}) => {
    missing.push({ code, owner, message, ...extra });
    return null;
  };

  /* The company clause is in the SAME query as the id — another company's
     enquiry must be indistinguishable from one that does not exist. */
  const companyClause = { companyId: ctx.companyId };
  const enquiry = oid(enquiryId)
    ? await Enquiry.findOne({ _id: enquiryId, ...companyClause })
      .select("enquiryId accountId companyId freight").lean()
    : null;

  if (!enquiry) {
    return {
      arrangement: null, treatment: null, origin: null, destination: null,
      mode: null, deliveryCount: null, shipment: null,
      missing: [{
        code: CODES.ARRANGEMENT_MISSING, owner: OWNER.SALES,
        message: "This costing has no enquiry in this company, so nothing states how the order is delivered.",
      }],
    };
  }

  const freight = enquiry.freight || {};

  /* ── THE ENQUIRY'S OWN TERMS, AND ONLY THOSE ──────────────────────────
     This used to load `Account.freightArrangement` and fall back to it when
     the enquiry said nothing. That made the customer's standing term a live
     input to every costing run: editing the account in November changed the
     arrangement an existing draft had been built on, retrospectively, with
     nothing recorded to say it had happened — the very thing `paymentTerms`
     was designed to prevent one record earlier.

     The account's terms are now OFFERED to Sales on the enquiry screen and
     COPIED onto the enquiry when saved, with their provenance
     (services/sales/deliveryTermsResolution.service.js). So this reads the
     snapshot: an enquiry nobody has answered is unanswered, and the gap below
     names Sales rather than borrowing a term nobody applied to this order. */
  const arrangement = resolveArrangement({ enquiryFreight: freight });
  if (arrangement.arrangement && str(freight.source) === "ACCOUNT") {
    /* Saved from the customer's standing terms rather than agreed for this
       order — a different claim, and the costing freezes which was made. */
    arrangement.source = "ACCOUNT";
    arrangement.sourceLabel = "The customer's usual terms, applied to this enquiry";
  }
  let treatment = arrangement.arrangement ? TREATMENT[arrangement.arrangement] : null;
  /* ── THE ANSWERED PREPAID QUESTION CHANGES THE OUTCOME ──────────────
     Asking Sales which it is and then treating both alike would make the
     question decorative. `IN_PRICE` is an ordinary borne cost;
     `RECOVERED_SEPARATELY` is costed, frozen and billed on at cost. */
  if (treatment === "DECISION_REQUIRED" && PREPAID_TREATMENT[str(freight.prepaidTreatment)]) {
    treatment = PREPAID_TREATMENT[str(freight.prepaidTreatment)];
  }

  if (!arrangement.arrangement) {
    gap(CODES.ARRANGEMENT_MISSING, OWNER.SALES,
      "Nobody has said who bears the delivery cost on this order — the customer collecting and the company delivering are different garment costs.");
  } else if (treatment === "DECISION_REQUIRED" && !str(freight.prepaidTreatment)) {
    /* ── THE ONE THE CODES CANNOT ANSWER ──────────────────────────────
       "Prepaid (we pay)" says the company pays the carrier. It does not say
       whether that is inside the price or billed on, and those two readings
       differ by the whole freight amount. Asked, never assumed. */
    gap(CODES.PREPAID_UNDECIDED, OWNER.SALES,
      "This order is prepaid: the company pays the carrier. Say whether that freight is inside the quoted price or recovered from the customer separately — the two are different garment costs.");
  }

  /* ── THE DESTINATION, CHOSEN AND RE-READ ────────────────────────────────
     Scoped through the account this enquiry belongs to, so an address on
     somebody else's account is not found at all. */
  let destination = null;
  let destinationReason = null;
  const addressId = oid(freight.shippingAddressId);
  if (addressId && enquiry.accountId) {
    /* ── RE-CHECKED HERE TOO, NOT TRUSTED FROM THE SAVE ──────────────
       The address could have been archived, re-typed as billing, or moved to
       another account since Sales chose it. A costing freezes a lane; it has
       to prove the lane at the moment it freezes it. */
    const resolved = await resolveShippingDestination(ctx.companyId, {
      addressId, accountId: enquiry.accountId,
    });
    destination = resolved.destination;
    destinationReason = resolved.reason;
  }

  /* ── THE ORIGIN ─────────────────────────────────────────────────────── */
  let origin = null;
  const warehouseId = oid(freight.originWarehouseId);
  if (warehouseId) {
    const doc = await Warehouse.findOne({
      _id: warehouseId, companyId: ctx.companyId, status: "Active",
    }).select("name shortName addressDetail status").lean();
    if (doc) {
      origin = {
        warehouseId: String(doc._id),
        name: doc.name || "",
        code: doc.shortName || "",
        city: doc.addressDetail?.city || "",
        region: doc.addressDetail?.state || "",
        country: doc.addressDetail?.country || "",
      };
    }
  }

  /* Only a company-borne arrangement needs a lane; an ex-works order has no
     destination to ask about, and demanding one would block a costing that
     is complete. */
  /* Both prepaid outcomes need a real lane and a real quotation: the company
     pays the carrier either way, and "we bill it on" is not a price. */
  const needsLane = treatment === "COMPANY_BEARS" || treatment === "RECOVERED_SEPARATELY";
  if (needsLane) {
    if (!destination) {
      gap(CODES.DESTINATION_MISSING, OWNER.SALES,
        destinationReason === SHIPPING_REASON.NOT_SHIPPING
          ? "The address chosen for this order is not a shipping address. A billing or office address is not a delivery destination."
          : "This order is delivered, and no shipping address has been chosen for it. The billing address is not used as a destination.");
    }
    if (!origin) {
      gap(CODES.ORIGIN_MISSING, OWNER.STORE_ADMIN,
        "No active dispatch warehouse is recorded for this order, so a freight lane has no starting point.");
    }
    if (!str(freight.mode)) {
      gap(CODES.DESTINATION_MISSING, OWNER.SALES,
        "Say how this order travels. Road and air on one lane are different rates from different transporters.");
    }
  }

  const shipment = style?.sample?.shipment
    ? {
      packedWeightGrams: style.sample.shipment.packedWeightGrams ?? null,
      garmentsPerCarton: style.sample.shipment.garmentsPerCarton ?? null,
      notes: style.sample.shipment.notes || "",
    }
    : { packedWeightGrams: null, garmentsPerCarton: null, notes: "" };

  return {
    enquiryRef: enquiry.enquiryId || "",
    accountId: enquiry.accountId ? String(enquiry.accountId) : null,
    arrangement: arrangement.arrangement,
    arrangementSource: arrangement.source,
    arrangementSourceLabel: arrangement.sourceLabel,
    treatment,
    prepaidTreatment: str(freight.prepaidTreatment) || null,
    mode: str(freight.mode) || null,
    /* Null, never 1: nothing here schedules deliveries, so a consignment
       count that nobody recorded is unknown rather than "one". */
    deliveryCount: Number.isFinite(freight.deliveryCount) ? freight.deliveryCount : null,
    origin,
    destination,
    shipment,
    /* Copied onto the enquiry when its delivery terms were saved, for the
       same reason the arrangement is. */
    incoterm: str(freight.incoterm) || null,
    missing,
  };
}

module.exports = { readFreightSource };
