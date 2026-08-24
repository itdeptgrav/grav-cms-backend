// services/sampleStyleProvision.js
//
// Raising the R&D styles for a journey — one SampleStyle per enquiry product.
//
// WHY THIS IS A SERVICE AND NOT A ROUTE BODY
//
// This logic used to live inside `GET /sample-styles/by-journey/:journeyRef`,
// which meant a style only came into existence once somebody happened to OPEN
// that journey. Three consequences, all bad:
//
//   • The cross-journey R&D board (`GET /sample-styles`) could not show work
//     nobody had opened yet — R&D's own queue was blind to its own backlog.
//   • Two concurrent opens raced to create the same style.
//   • A plain read mutated data, so any cache, prefetch, or double-render
//     silently wrote to the database.
//
// It is called from the journey's stage transition (the real handoff moment)
// and from an explicit POST for re-sync. The GET is now read-only.
//
// Idempotent: safe to call repeatedly. Matching is by enquiry product _id, with
// a name fallback for styles raised before that field existed.

const { createWithRef } = require("./sampleStyleRef");

/**
 * Ensure a SampleStyle exists for every product on the journey's active enquiry.
 *
 * @param {object}   deps
 * @param {Model}    deps.SampleStyle
 * @param {object}   deps.journey      SalesJourney document (needs _id, journeyId, accountId, ownerId, ownerName)
 * @param {object}   deps.enquiry      Enquiry document/lean object with `products`
 * @param {Function} deps.briefFromProduct  (product) => brief subdocument
 * @param {object}   deps.actor        { employeeId, name } audit stamp
 * @returns {Promise<{styles: Array, created: number, renamed: number, backfilled: number, waived: number}>}
 */
async function provisionJourneyStyles({
  SampleStyle,
  journey,
  enquiry,
  briefFromProduct,
  actor,
  /**
   * `(product) => Promise<{proven: boolean}>` — has this garment actually been
   * made before? Injected so this service stays DB-free and unit-testable.
   *
   * OMITTED MEANS NOTHING IS WAIVED, deliberately. Failing closed costs a
   * sample nobody needed; failing open sends an unmade garment to a customer
   * with no sample and no tech sheet, which costs an order.
   */
  assessDevelopment = null,
}) {
  const products = (enquiry?.products || []).filter((p) => p && p.product);

  // BASE VARIANTS ONLY.
  //
  // A product can now be developed as several styles at once (see the
  // `variantKey` field on SampleStyle). Provisioning owns exactly one of them:
  // the base, raised straight from the enquiry product. If it saw the variants
  // too it would match one of them by name, overwrite its brief with the
  // enquiry's on every sync, and undo the very thing that makes it a variant.
  //
  // It also must not CREATE anything for a product that already has a base, so
  // the maps are built from base rows and the "not found" path stays correct.
  const existing = await SampleStyle.find({
    journeyId: journey._id,
    isActive: true,
    $or: [{ variantKey: "" }, { variantKey: { $exists: false } }],
  });
  const byProductId = new Map(
    existing.filter((s) => s.enquiryProductId).map((s) => [String(s.enquiryProductId), s]),
  );
  const byName = new Map(existing.map((s) => [s.productName, s]));

  const out = [];
  let created = 0;
  let renamed = 0;
  let backfilled = 0;
  let waived = 0;

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const pid = p._id ? String(p._id) : null;

    // Identity first, name only as a fallback for pre-existing rows.
    let style = (pid && byProductId.get(pid)) || byName.get(p.product);

    // SAMPLING IS WAIVED BY THE PRODUCT, NOT BY THE CUSTOMER (22 Aug 2026).
    //
    // A row linked to a registered stock item names a garment that has been
    // made before — it carries a costed bill of materials and a measured SAM,
    // so a physical sample would establish nothing that is not already known.
    // A row typed by hand names something new, and that is what sampling is
    // for. The journey's business type says nothing about this either way: a
    // repeat customer can perfectly well ask for a garment nobody has made,
    // which is why the old businessType check in salesJourneys.js was removed.
    //
    // Applied only where the style is CREATED. Re-provisioning must never reach
    // into a style already being sampled and cancel it.
    //
    // BEING REGISTERED IS NOT ENOUGH (22 Aug 2026, corrected same day).
    //
    // The first cut of this waived the step on `Boolean(p.stockItemId)` alone.
    // That is too loose: a stock item is created the moment someone types a
    // name, so a garment nobody has ever cut would skip both the tech sheet and
    // the sample on the strength of existing in a dropdown.
    //
    // The test is now whether it has actually BEEN MADE — a prior approved
    // sample, or operations with measured times. See services/developmentRecord
    // .js for why a bill of materials does not count.
    //
    // A registered-but-unproven product still gets its register link recorded,
    // so the stage can show what IS known while asking for the sample anyway.
    const registered = Boolean(p.stockItemId);
    const proven = registered && assessDevelopment
      ? Boolean((await assessDevelopment(p))?.proven)
      : false;

    if (!style) {
      try {
        style = await createWithRef(SampleStyle, {
          journeyId: journey._id,
          enquiryId: enquiry?._id,
          enquiryProductId: p._id || undefined,
          accountId: journey.accountId,
          productName: p.product,
          styleCode: `SC-${journey.journeyId}-${String(i + 1).padStart(2, "0")}`,
          ownerId: journey.ownerId,
          ownerName: journey.ownerName,
          brief: briefFromProduct(p),
          sourceStockItemId: p.stockItemId || undefined,
          sourceStockItemReference: p.stockItemReference || undefined,
          techSheet: proven ? { status: "notApplicable", revisions: [] } : undefined,
          sample: proven ? { status: "notApplicable", rounds: [], revisions: [] } : undefined,
          // Recorded in the shared timeline, because "why was this never
          // sampled" is exactly the question somebody asks six months later.
          history: proven
            ? [{
              kind: "development_waived",
              note: `Already made before${p.stockItemReference ? ` (${p.stockItemReference})` : ""} — no tech sheet or sample needed.`,
              by: actor,
              at: new Date(),
            }]
            : undefined,
          createdBy: actor,
          updatedBy: actor,
        });
        created += 1;
        if (proven) waived += 1;
      } catch (err) {
        // Two callers racing to provision the same journey (React StrictMode's
        // double effect-invoke, or Sales and R&D opening it within
        // milliseconds of each other) both pass the "doesn't exist yet" read
        // above before either commits. The {journeyId, productName} unique
        // index (see the model) means only one of the two concurrent inserts
        // can land — the loser re-reads the winner's doc instead of failing
        // the whole request (19 Aug 2026, bug fix; this IS the race that
        // produced duplicate SampleStyle rows before this index existed).
        const isDuplicateProduct =
          err?.code === 11000 && JSON.stringify(err?.keyPattern || {}).includes("productName");
        if (!isDuplicateProduct) throw err;
        style = await SampleStyle.findOne({ journeyId: journey._id, productName: p.product, isActive: true });
        if (!style) throw err; // genuinely unexpected — surface the original error
      }
      if (pid) byProductId.set(pid, style);
      byName.set(style.productName, style);
    } else {
      // Adopt the identity key if this style predates the field.
      if (pid && !style.enquiryProductId) {
        style.enquiryProductId = p._id;
        backfilled += 1;
      }
      // The rename case this whole change exists for: the product's text moved,
      // so carry the style with it instead of stranding it.
      if (style.productName !== p.product) {
        // Carry the SIBLINGS too. productName is what groups a family, so
        // renaming only the base would split it: the variants would keep the
        // old name, stop appearing under the product, and be free to collide
        // with a future style of that name.
        await SampleStyle.updateMany(
          { journeyId: journey._id, productName: style.productName, variantKey: { $nin: ["", null] } },
          { $set: { productName: p.product } },
        );
        style.productName = p.product;
        renamed += 1;
      }
      style.brief = briefFromProduct(p);
      style.updatedBy = actor;
      await style.save();
    }
    out.push(style);
  }

  return { styles: out, created, renamed, backfilled, waived };
}

module.exports = { provisionJourneyStyles };
