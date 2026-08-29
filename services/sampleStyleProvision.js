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
   * NO LONGER DECIDES THE WAIVER (26 Aug 2026) — picking a registered product
   * does, on its own. This now only sharpens the HISTORY WORDING, so a waiver
   * backed by a real production record is distinguishable from one backed
   * only by the register link. Omitting it costs nothing but that detail.
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
    // PICKING AN EXISTING PRODUCT IS THE WAIVER (26 Aug 2026, explicit
    // request, reversing the 22 Aug narrowing below).
    //
    // History, because this has now moved twice. The first cut waived on
    // `Boolean(p.stockItemId)`. On 22 Aug that was judged too loose — a stock
    // item exists the moment someone types a name, so a garment nobody had cut
    // could skip both steps on the strength of appearing in a dropdown — and
    // the test was narrowed to whether it had actually BEEN MADE (a prior
    // approved sample, or operations with measured times; see
    // services/developmentRecord.js).
    //
    // That is now reversed by an explicit product decision: "at the time of
    // creating the product in the enquiry stage, if the user just select for
    // any existing one product then no need to ask for the sampling process
    // and all... no need to sent to the r&d team and all, approvals and all".
    // Selecting off the register is the salesperson SAYING this is a known
    // garment; the system takes them at their word.
    //
    // The 22 Aug concern is real and is not dismissed — it is handled by
    // recording WHICH of the two grounds applied, so "why was this never
    // sampled" still has a truthful answer six months later, and by leaving
    // the waiver reversible (both notApplicable statuses transition back into
    // in_progress — see SAMPLE_TECHSHEET_TRANSITIONS / SAMPLE_SAMPLING_
    // TRANSITIONS in constants/crm.js) so a known garment in an unknown fabric
    // can still be sampled on request.
    //
    // Applied only where the style is CREATED. Re-provisioning must never
    // reach into a style already being sampled and cancel it.
    //
    // "SELECTING" MEANS PICKING ONE THAT ALREADY EXISTED, NOT REGISTERING A
    // NEW ONE HERE (26 Aug 2026, bug fix — the waiver's own intent, stated
    // two paragraphs up, was never actually enforced). `p.stockItemId` is set
    // in BOTH cases: picking an existing register entry, and registering a
    // brand-new one for this exact enquiry via RegisterProductForm. A
    // freshly-registered product is precisely the new-garment case sampling
    // exists for — it had no waiver until this fix, having a `stockItemId`
    // was enough to skip R&D and sampling entirely for a garment nobody had
    // ever made. `p.pickedFromRegister` (set only by the frontend's
    // MasterCombo `onPick`, never by registration) is the actual signal.
    const registered = Boolean(p.stockItemId);
    const proven = registered && assessDevelopment
      ? Boolean((await assessDevelopment(p))?.proven)
      : false;
    const waive = registered && Boolean(p.pickedFromRegister);

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
          // The product is now normally registered AT the enquiry stage (see
          // routes/CMS_Routes/Sales/enquiries.js's product-wise requirement —
          // 24 Aug 2026, explicit request), not later through R&D's own
          // Production wizard — so the style already knows which stock item
          // it's developing INTO from the moment it's raised. This is
          // `production.stockItemId` (the TARGET, filled in as development
          // happens), not `sourceStockItemId` above (a DIFFERENT, older
          // product this style proves against) — the two answer different
          // questions and can both be set. R&D's wizard skips straight to
          // Quantities once this is here (see its own `step` computation).
          production: p.stockItemId
            ? {
              stockItemId: p.stockItemId,
              status: "stock_item_linked",
              log: [{
                kind: "stock_item_linked",
                note: `Registered at the enquiry stage${p.stockItemReference ? ` (${p.stockItemReference})` : ""}.`,
                by: actor,
                at: new Date(),
              }],
            }
            : undefined,
          techSheet: waive ? { status: "notApplicable", revisions: [] } : undefined,
          sample: waive ? { status: "notApplicable", rounds: [], revisions: [] } : undefined,
          // Recorded in the shared timeline, because "why was this never
          // sampled" is exactly the question somebody asks six months later —
          // and it names WHICH ground applied, so a waiver backed by a real
          // production record reads differently from one backed only by the
          // salesperson picking a registered product.
          history: waive
            ? [{
              kind: "development_waived",
              note: proven
                ? `Already made before${p.stockItemReference ? ` (${p.stockItemReference})` : ""} — no tech sheet or sample needed.`
                : `Raised from an existing registered product${p.stockItemReference ? ` (${p.stockItemReference})` : ""} — no tech sheet or sample needed. Not previously made through this system.`,
              by: actor,
              at: new Date(),
            }]
            : undefined,
          createdBy: actor,
          updatedBy: actor,
        });
        created += 1;
        if (waive) waived += 1;
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
      // Backfill for a row registered AFTER its style already existed (the
      // salesperson added the product first, came back and registered it
      // later) — never overwrites a stockItemId R&D's own wizard already set
      // by hand, and never touches anything past that first link.
      if (p.stockItemId && !style.production?.stockItemId) {
        if (!style.production) style.production = {};
        style.production.stockItemId = p.stockItemId;
        if (!style.production.status || style.production.status === "not_started") style.production.status = "stock_item_linked";
        style.production.log = style.production.log || [];
        style.production.log.push({
          kind: "stock_item_linked",
          note: `Registered at the enquiry stage${p.stockItemReference ? ` (${p.stockItemReference})` : ""}.`,
          by: actor,
          at: new Date(),
        });
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
