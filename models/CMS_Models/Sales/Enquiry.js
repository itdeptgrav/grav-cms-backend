// models/CMS_Models/Sales/Enquiry.js
//
// Enquiry / RFQ — ONE specific business opportunity within a Sales Journey's
// Enquiry stage. "What does this customer want, this time?"
//
// WHY ITS OWN COLLECTION (not a field on SalesJourney):
//   The SalesJourney model deliberately refuses to embed later-stage data (see
//   its header). An enquiry carries products, pricing, qualification and a
//   status lifecycle of its own — real module data — so it lives in its own
//   record, linked back by `journeyId`, exactly as CRMActivity links to the
//   modules it annotates. One enquiry per journey (unique index on journeyId):
//   a second requirement for the same customer is a second Journey.
//
// WHAT IS NOT DUPLICATED HERE:
//   • The customer is `accountId` → CRMAccount. No company name/address copied.
//   • The contact is `primaryContactId` → CRMContact.
//   • The salesperson is `ownerId`/`ownerName`, same shape the Journey uses.
//   Display names are resolved by populating on read, never stored twice.
//
// Built in chunks: Chunk 1 is identity + header + status. Products, indicative
// pricing, qualification and lost-reason land in later chunks as additive
// fields — nothing here needs migrating when they do.

const mongoose = require("mongoose");
const {
  ENQUIRY_STATUS_CODES,
  ENQUIRY_SOURCE_CODES,
  ENQUIRY_LOST_REASON_CODES,
  GARMENT_GENDER_CODES,
  ENQUIRY_PRIORITY_CODES,
  CUSTOMER_SERIOUSNESS_CODES,
  ENQUIRY_REFERENCE_TYPE_CODES,
} = require("../../../constants/crm");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const enquirySchema = new mongoose.Schema(
  {
    // ── Identity ────────────────────────────────────────────────────────────
    // The human reference the customer and audit trail see. Minted by
    // services/enquiryRef.js under an atomic counter; immutable once set.
    enquiryId: { type: String, required: true, unique: true, immutable: true, trim: true },

    // The Journey this enquiry belongs to. Unique — one enquiry per journey.
    journeyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesJourney",
      required: true,
      unique: true,
      index: true,
    },

    // The customer and the specific person we're dealing with — references, not
    // copies. accountId is indexed so "this account's enquiries" is cheap.
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", required: true, index: true },
    primaryContactId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMContact" },

    // The salesperson who owns this opportunity.
    ownerId: { type: mongoose.Schema.Types.ObjectId, index: true },
    ownerName: { type: String, trim: true },

    // The Lead this opportunity grew out of, when it was converted from one.
    sourceLeadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead" },

    // Salesperson-facing title, e.g. "New staff uniforms for ITC Bhubaneswar".
    title: { type: String, trim: true },

    // ── Dates & source ──────────────────────────────────────────────────────
    enquiryDate: { type: Date, default: Date.now },
    source: { type: String, enum: ENQUIRY_SOURCE_CODES },
    expectedClosingDate: { type: Date },
    requirementDeadline: { type: Date },

    // Free-text summary of what the customer is asking for — the plain-language
    // brief that complements the structured products below.
    summary: { type: String, trim: true },

    // ── Products (Chunk 2) + per-product garment spec (Chunk 3) ─────────────
    // The product-wise requirement. Quantities are APPROXIMATE at enquiry stage
    // — not PO-level final. Seeded from the converting Lead's requirementItems.
    // Every spec field is optional: at enquiry stage the customer's brief is
    // rarely complete, and a half-filled spec is more useful than a blocked one.
    products: [
      new mongoose.Schema(
        {
          product: { type: String, trim: true, required: true },
          /**
           * The item-master record this row names, when it names one.
           *
           * `product` stays the identity and stays required: an enquiry
           * routinely asks for a garment nobody has entered into the master
           * yet, and a row that could not be typed would stop the work. The
           * picker is an OPTION, so this is optional too.
           *
           * What it buys when it is set: everything downstream can join on an
           * id instead of a name. Style provisioning, the costing sheet and the
           * work order all match products by trimmed text today, which breaks
           * on a rename and on two spellings of one garment.
           */
          stockItemId: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", index: true, sparse: true },
          /** The master's own code, kept for display without a populate. */
          stockItemReference: { type: String, trim: true },
          /**
           * Was `stockItemId` set by PICKING an already-existing item-master
           * entry, as opposed to registering a brand-new one right here?
           * (26 Aug 2026, bug fix.)
           *
           * `stockItemId` alone can't answer that: the frontend's
           * RegisterProductForm sets it too, the moment a fresh product is
           * created for THIS enquiry — deliberately, so every other
           * downstream consumer (the customer's assignedStockItems link,
           * production linking) can treat "just registered" and "already
           * existed" identically, because for those purposes they are.
           *
           * Style provisioning's sampling waiver is the one consumer that
           * must NOT: "pick an existing product, skip the sample" only means
           * something for a product that already existed before this
           * enquiry. A freshly registered one is exactly the new-garment case
           * sampling exists for. This field is that distinction, set true
           * only by the frontend's MasterCombo `onPick`.
           */
          pickedFromRegister: { type: Boolean, default: false },
          quantity: { type: Number, min: 0 },
          note: { type: String, trim: true },

          // Garment spec
          gender: { type: String, enum: GARMENT_GENDER_CODES },
          colour: { type: String, trim: true },
          fabricPreference: { type: String, trim: true },
          fabricComposition: { type: String, trim: true },
          gsm: { type: String, trim: true }, // "180 GSM" or a bare number — free text, only "if specified"
          fit: { type: String, trim: true },
          sizeRange: { type: String, trim: true },

          // Branding / decoration
          logo: { type: Boolean, default: false },
          embroidery: { type: Boolean, default: false },
          printing: { type: Boolean, default: false },
          brandingPlacement: { type: String, trim: true },

          // Construction & context
          trims: { type: String, trim: true },
          specialConstruction: { type: String, trim: true },
          existingUniform: { type: String, trim: true }, // existing garment details / what they wear now

          /**
           * Specification the fixed fields above have no room for — the
           * salesperson names the question AND answers it (24 Aug 2026,
           * explicit request: "in the product specification input ask for the
           * custom input also, so the sales person will define the inputs and
           * he will fill the answers").
           *
           * Deliberately free-form label/value pairs rather than an ever-
           * growing list of named columns: every customer asks for something
           * the last one didn't (a pantone reference, a collar style, a
           * washing standard), and each of those becoming a schema field is
           * how this subdocument reaches sixty fields nobody fills in. These
           * ride through to R&D with the rest of the brief — see
           * briefFromProduct in routes/CMS_Routes/Sales/sampleStyles.js.
           */
          customSpecs: [
            new mongoose.Schema(
              {
                label: { type: String, trim: true, required: true },
                value: { type: String, trim: true, default: "" },
              },
              { _id: false },
            ),
          ],

          // Reference images — what the garment should look like, so Merchandising
          // + Industrial Engineering can cost it. Previewed inline. Uploaded via
          // Cloudinary (`publicId` set) since 19 Aug 2026 — see
          // grav-clothing/lib/driveImage.js. Older rows uploaded to Google Drive
          // via /api/upload-to-drive (`fileId` set) still resolve and render.
          images: [
            new mongoose.Schema(
              {
                fileId: { type: String, trim: true }, // Drive file id (legacy)
                publicId: { type: String, trim: true }, // Cloudinary public id
                name: { type: String, trim: true },
                url: { type: String, trim: true }, // direct image URL
              },
              { _id: false },
            ),
          ],
        },
        { _id: true },
      ),
    ],

    // ── Cost ledger — what Sales keyed, and what they quoted ────────────────
    //
    // MOVED OFF THE BROWSER (22 Aug 2026). This lived in localStorage under
    // `crm_pnl_<journeyId>`, so a deal's cost, price and margin existed only on
    // the machine that typed them: a second salesperson saw an empty stage, the
    // same person on another laptop saw an empty stage, and no report, approval
    // or margin standard could ever read them. A number management is supposed
    // to hold people to cannot live in one browser.
    //
    // KEYED BY PRODUCT NAME, and top-level, for exactly the reason the costing
    // sheets below are: sanitizeProducts() in routes/.../enquiries.js rebuilds
    // the whole `products` array on every requirement save and reassigns each
    // row a fresh _id, so anything stored ON a row is lost on the next quantity
    // edit. Name survives that — and a rename is carried across by the same
    // `renames` hint the sheets use.
    //
    // NOT the costing itself. The build-up is `costingSheets`; this is the one
    // figure Sales reads off the Master tab plus the price they decided to
    // quote. Deliberately two plain numbers — see docs/enquiry-costing-sheet-plan.md
    // for why the cost is keyed by a person and never auto-scraped.
    costLedger: [
      new mongoose.Schema(
        {
          productName: { type: String, trim: true, required: true },
          /** Unit cost, as read off the costing workbook's Master tab. */
          cost: { type: Number, min: 0 },
          /** Unit price being quoted. Margin is derived, never stored. */
          price: { type: Number, min: 0 },
          updatedBy: {
            id: { type: mongoose.Schema.Types.ObjectId },
            name: { type: String, trim: true },
          },
          updatedAt: { type: Date },
        },
        { _id: false },
      ),
    ],

    // ── Costing sheets — NATIVE, keyed by PRODUCT NAME (19 Aug 2026) ────────
    // Not embedded on the product row above, and not keyed by that row's
    // _id: routes/CMS_Routes/Sales/enquiries.js's sanitizeProducts() rebuilds
    // the entire `products` array from client input on every "Save
    // requirement" (Chunk 2), which reassigns a fresh _id to every row and
    // carries through only its own known field list. A pointer stored on or
    // keyed by that row would be silently orphaned the next time somebody
    // edited a quantity. Product NAME survives that rewrite — it's the field
    // a requirement edit actually preserves — so it is what this joins on.
    // If a product is later renamed, its costing sheet is not auto-migrated;
    // it still exists, just no longer linked from this row until re-linked.
    //
    // FORMERLY a pointer into a CoWork Firestore workbook (cowork_documents/
    // cowork_document_bodies). Moved fully native (19 Aug 2026, explicit
    // request): raw items and production cost are now defined directly here —
    // `materials`/`operations` ARE the costing, not a mirror of one. No
    // Firestore round trip, no CoWork document, no "Open in CoWork" escape
    // hatch. `members`/`assignee` keep the exact same access-control shape
    // CoWork's own documents used (owner|editor|viewer), just enforced here
    // instead of by a Firestore document's member list.
    //
    // A product still has ONE SHEET PER CONTRIBUTOR: `part` says which half a
    // row set is, and (productName, part) is the key.
    //
    //   raw        → the merchandiser's raw-materials rows
    //   operations → the industrial engineer's operation rows
    //   combined   → a pre-split sheet holding both. Rows written before the
    //                split have no `part` at all and default to this.
    costingSheets: [
      new mongoose.Schema(
        {
          productName: { type: String, trim: true, required: true },
          part: { type: String, trim: true, enum: ["raw", "operations", "combined"], default: "combined" },
          // Whose sheet this is — the one person expected to fill it in, held
          // separately from `members` because "has access" and "is responsible
          // for it" are different questions and the second one is the one Sales
          // chases.
          assignee: {
            employeeId: { type: String, trim: true },
            name: { type: String, trim: true },
          },
          createdAt: { type: Date, default: Date.now },
          createdBy: actorRef(),
          // Bumped on every save of this sheet's rows — the optimistic-
          // concurrency anchor a client's `expectedUpdatedAt` is checked
          // against, same purpose the CoWork document's own `updatedAt` served.
          updatedAt: { type: Date, default: Date.now },
          members: [
            {
              employeeId: { type: String, trim: true },
              name: { type: String, trim: true },
              role: { type: String, trim: true, enum: ["owner", "editor", "viewer"] },
            },
          ],
          // Raw-materials rows (part: "raw", or both halves of "combined").
          // Each gets its own _id, used client-side as the row's stable key —
          // no more spreadsheet row-number bookkeeping.
          materials: [
            new mongoose.Schema(
              {
                category: { type: String, trim: true },
                item: { type: String, trim: true },
                // Set only when `item` was picked from the Store raw-item
                // master (searchRawItems) rather than typed free-text — lets
                // the row's own "info" button pull that item's full record
                // (21 Aug 2026, "keep the info button for each and every raw
                // item" extended to this sheet). A typed line with no master
                // match simply has no id here, which is expected, not a bug.
                rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
                vendor: { type: String, trim: true },
                unitCost: { type: String, trim: true },
                // The unit consumption is counted in — a name from the Unit
                // master (Store's raw-item register), not a free-cost figure.
                // Added 20 Aug 2026 so a costing line can say "0.4" and mean
                // something, instead of leaving the reader to guess metres vs
                // pieces vs kilograms.
                unit: { type: String, trim: true },
                consumption: { type: String, trim: true },
                // Only set when this row was seeded from an R&D-approved
                // sample's consumption (see enquiries.js's
                // seedMaterialsFromApprovedSample) — the wastage/buffer % R&D
                // planned around, shown to Sales read-only alongside
                // Consumption (which already has it baked in) so the number
                // isn't opaque (20 Aug 2026, explicit request).
                allowancePercent: { type: String, trim: true },
              },
              { _id: true },
            ),
          ],
          // Operation rows (part: "operations", or both halves of "combined").
          operations: [
            new mongoose.Schema(
              {
                detail: { type: String, trim: true },
                sam: { type: String, trim: true },
                rate: { type: String, trim: true },
              },
              { _id: true },
            ),
          ],
          // Miscellaneous cost rows (19 Aug 2026) — a straight name + price
          // line, for whatever doesn't fit the raw-materials or operations
          // shape: testing, handling, a courier fee, wastage allowance. Lives
          // on the "raw"/merchandiser sheet (and "combined" pre-split sheets),
          // same edit rights as `materials` — a plain cost line needs no
          // vendor lookup or SAM measurement, just what it's called and what
          // it costs.
          miscellaneous: [
            new mongoose.Schema(
              {
                name: { type: String, trim: true },
                price: { type: String, trim: true },
              },
              { _id: true },
            ),
          ],
        },
        { _id: false },
      ),
    ],

    // ── Costing change log — Merchandiser/PM propose, Sales decides (19 Aug
    // 2026, explicit request) ────────────────────────────────────────────────
    //
    // Merchandiser and Project Manager/IE are NOT restricted to their own
    // part anymore — either can fill raw materials, operations or
    // miscellaneous. What replaces field-level restriction is this: a save
    // from either of those two roles does not touch `costingSheets` directly
    // — it lands here instead, as a PROPOSED full snapshot of whichever
    // field(s) they changed, `status: "pending"`. Sales (or an admin/CEO)
    // reviews it, and Approve copies the snapshot onto the real
    // `costingSheets` entry; Reject just marks it rejected and changes
    // nothing. A Sales save is never staged — it applies immediately, same
    // as always, since Sales IS the approver.
    costingChangeLog: [
      new mongoose.Schema(
        {
          productName: { type: String, trim: true, required: true },
          part: { type: String, trim: true, enum: ["raw", "operations", "combined"], default: "combined" },
          // Only the field(s) actually submitted are set — applying a
          // decision only ever touches what's present here, never blanks a
          // field the submitter didn't propose changing.
          materials: [
            new mongoose.Schema(
              {
                category: { type: String, trim: true },
                item: { type: String, trim: true },
                rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
                vendor: { type: String, trim: true },
                unitCost: { type: String, trim: true },
                unit: { type: String, trim: true },
                consumption: { type: String, trim: true },
                allowancePercent: { type: String, trim: true },
              },
              { _id: false },
            ),
          ],
          operations: [
            new mongoose.Schema(
              {
                detail: { type: String, trim: true },
                sam: { type: String, trim: true },
                rate: { type: String, trim: true },
              },
              { _id: false },
            ),
          ],
          miscellaneous: [
            new mongoose.Schema(
              {
                name: { type: String, trim: true },
                price: { type: String, trim: true },
              },
              { _id: false },
            ),
          ],
          status: { type: String, trim: true, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
          submittedBy: actorRef(),
          submittedAt: { type: Date, default: Date.now },
          decidedBy: actorRef(),
          decidedAt: { type: Date, default: null },
        },
        { timestamps: false },
      ),
    ],

    // ── Costing lifecycle — the three steps after a product is costed (20 Aug
    // 2026, explicit request, replacing the removed PI/quotation workflow on
    // the Cost & Quote screen): sent to the customer, the customer's
    // approve/reject, and asking Store to add the finished product as an
    // Inventory Stock Item. Deliberately its own array keyed by PRODUCT NAME —
    // same reasoning as costingSheets above: a "Save requirement" rewrite of
    // `products[]` reassigns every row a fresh _id, so anything that has to
    // survive that can only join on the name.
    //
    // "Stock item requested" is a FLAG, not a StockItem creation — Store still
    // does that themselves, with the SKU/category/BOM decisions a request
    // can't make for them. This just records that Sales asked and when.
    costingLifecycle: [
      new mongoose.Schema(
        {
          productName: { type: String, trim: true, required: true },
          sentToCustomerAt: { type: Date },
          sentToCustomerBy: actorRef(),

          // ── The customer's own review link (24 Aug 2026, explicit request:
          // "via mail the verification request will sent to the customer").
          // Same shape as Cowork's external-share tokens — a random value
          // whose hash alone is stored, so a leaked database yields no usable
          // link — but Mongo-backed here since this record already is.
          // Single-use: cleared the moment a decision is recorded through it
          // (below), so a link can't be replayed to flip a decision after
          // the fact; sending again mints a fresh one.
          customerApprovalTokenHash: { type: String, index: true },
          customerApprovalTokenExpiresAt: { type: Date },

          // ── Customer approval — a LOG, not a switch (20 Aug 2026, explicit
          // request: "it seems like u are making it just normally so that the
          // user can change anytime he want ok, so don't do that ok, keep an
          // proper log and all like the reason and all"). Every decision
          // (first one and any later reversal) is APPENDED here, never
          // overwritten — the full history of who decided what, when, and
          // why is what "proper" meant. `customerApproved` etc. below are a
          // cache of the LAST entry, kept only so a reader doesn't have to
          // walk the log for the common case; the log is the source of truth.
          customerApprovalLog: [
            new mongoose.Schema(
              {
                approved: { type: Boolean, required: true },
                decidedAt: { type: Date, default: Date.now },
                decidedBy: actorRef(),
                // Required when this entry REVERSES the previous one (the
                // route enforces this — a first decision can be quick, a
                // change of mind has to say why).
                note: { type: String, trim: true },
              },
              { _id: false },
            ),
          ],
          // null = no decision yet; a real boolean once the customer answers.
          // Cache of customerApprovalLog[last] — see that field's comment.
          customerApproved: { type: Boolean, default: null },
          customerApprovedAt: { type: Date },
          customerApprovedBy: actorRef(),
          customerDecisionNote: { type: String, trim: true },

          stockItemRequestedAt: { type: Date },
          stockItemRequestedBy: actorRef(),
          // Merchandising's own decision on the request (app/merchandiser
          // /products' "Requests" view) — separate from the customer's
          // approval above, and from an actual StockItem existing: approving
          // here just means Merchandising accepts the ask and will create
          // the Stock Item themselves (SKU/BOM decisions stay theirs).
          stockItemRequestStatus: { type: String, trim: true, enum: ["none", "pending", "approved", "rejected"], default: "none" },
          stockItemRequestDecidedAt: { type: Date },
          stockItemRequestDecidedBy: actorRef(),
          stockItemRequestDecisionNote: { type: String, trim: true },
        },
        { _id: false },
      ),
    ],

    // ── Product sheets — free-form, CoWork-backed, per product (19 Aug 2026) ─
    //
    // Not costing. This is the general-purpose "communicate in a sheet"
    // surface the salesperson raises per product and shares with whoever
    // needs it — a place to work something out together beyond the
    // structured costing/requirement fields, without leaving this page. It is
    // the exact mechanism costing used to use (a CoWork
    // cowork_documents/cowork_document_bodies "sheet" document, native
    // grid + "Open in CoWork"), freed up once costing went native and
    // repointed at this instead — see services/coworkSheets.service.js.
    //
    // Keyed by (productName), one sheet per product. `members` is the whole
    // access-control story: the creator is always `owner`; the salesperson
    // decides who else gets `editor` (can change it) or `viewer` (can only
    // read it) — see PATCH /:id/product-sheet/members.
    productSheets: [
      new mongoose.Schema(
        {
          productName: { type: String, trim: true, required: true },
          documentId: { type: String, trim: true, required: true }, // cowork_documents doc id
          title: { type: String, trim: true },
          createdAt: { type: Date, default: Date.now },
          createdBy: actorRef(),
          members: [
            {
              employeeId: { type: String, trim: true },
              name: { type: String, trim: true },
              role: { type: String, trim: true, enum: ["owner", "editor", "viewer"] },
            },
          ],
        },
        { _id: false },
      ),
    ],

    // ── Product chat — per product, CoWork group underneath (19 Aug 2026) ───
    //
    // A real conversation, product by product, shown on this page instead of
    // sending anyone to CoWork to find it. Backed by an ordinary CoWork group
    // (cowork_groups + its messages subcollection) created via
    // services/cowork.service.js — the same mechanism CoWork's own group chat
    // uses, just minted from here. Membership is who the salesperson has
    // added; there is no separate "role" here the way the sheet has one —
    // being in the conversation IS the access.
    productThreads: [
      new mongoose.Schema(
        {
          productName: { type: String, trim: true, required: true },
          groupId: { type: String, trim: true, required: true }, // cowork_groups doc id
          createdAt: { type: Date, default: Date.now },
          createdBy: actorRef(),
          members: [
            {
              employeeId: { type: String, trim: true },
              name: { type: String, trim: true },
            },
          ],
        },
        { _id: false },
      ),
    ],

    // The CustomerRequest this enquiry's quotation / proforma invoice lives on.
    //
    // It is also the ONLY reliable route from a journey to its production: work
    // orders carry `customerRequestId`, so without this link the CMS has to
    // guess by matching the customer's NAME, which breaks on a rename and on
    // two similarly-named accounts. Recorded the first time the quotation is
    // opened, and back-filled by the production route when it has to resolve
    // one itself, so the guess happens at most once per enquiry.
    customerRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null, index: true },


    // ── Off-schedule dispatch asks (17 Aug 2026) ────────────────────────────
    //
    // ON-SCHEDULE DISPATCH IS NOT SALES' JOB. The dispatch team works the
    // schedule themselves and needs nothing from this app. The one thing only
    // Sales knows is when a CUSTOMER wants some of the order early — a manager
    // needs eight shirts for an inspection on Friday — and that is an exception
    // to the schedule, so it is a REQUEST with a reason, not a dispatch.
    //
    // `reason` is required and free text. A dropdown of canned reasons would
    // turn "why are we breaking the schedule" into a shrug, and dispatch has to
    // read a sentence to decide.
    earlyDispatchRequests: [
      new mongoose.Schema(
        {
          pieces: { type: Number, required: true, min: 1 },
          reason: { type: String, required: true, trim: true },
          neededBy: { type: Date, default: null },
          status: {
            type: String,
            enum: ["requested", "accepted", "declined", "dispatched"],
            default: "requested",
          },
          requestedAt: { type: Date, default: Date.now },
          requestedBy: actorRef(),
          decidedAt: { type: Date, default: null },
          decidedBy: actorRef(),
          decisionNote: { type: String, trim: true, default: "" },
        },
        { timestamps: false },
      ),
    ],

    // Who this enquiry's costings go to. Chosen once and reused for every
    // product on the enquiry, overridable per product at creation — a costing
    // team is a standing arrangement, not a per-sheet decision, and re-picking
    // the same two people for each of five products is how the wrong person
    // ends up on one of them.
    costingTeam: {
      merchandiser: {
        employeeId: { type: String, trim: true },
        name: { type: String, trim: true },
      },
      industrialEngineer: {
        employeeId: { type: String, trim: true },
        name: { type: String, trim: true },
      },
    },

    // ── Indicative pricing (Chunk 4) ────────────────────────────────────────
    // INDICATIVE only — NOT the formal quote (that's the Cost & Quote stage).
    // `targetPrice` is what the customer says their budget is; `estimatedPrice
    // Min/Max` is our rough "we usually make this for…", subject to sampling and
    // final costing. Seeded from the lead's estimated unit price.
    pricingCurrency: { type: String, trim: true, uppercase: true, default: "INR" },
    targetPrice: { type: Number, min: 0 }, // customer's stated budget per unit
    estimatedPriceMin: { type: Number, min: 0 },
    estimatedPriceMax: { type: Number, min: 0 },
    pricingNote: { type: String, trim: true },

    // ── What the Lead believed, at the moment it converted ──────────────────
    //
    // The same commercial fact is stated four times across a journey, each time
    // with more certainty behind it:
    //
    //   Lead        researched annual quantity / revenue / unit price, each
    //               carrying HOW it was arrived at (assumed → document_confirmed)
    //   Enquiry     an indicative range and a derived opportunity size
    //   Cost&Quote  a costed, quotable number
    //   Closing     what was actually invoiced and received
    //
    // Until now only the bare unit price survived the first hop — it was copied
    // into estimatedPriceMin/Max and everything that made it MEAN something was
    // dropped. So the enquiry showed a number nobody could account for, and the
    // Lead's careful "researched vs assumed" distinction died at conversion.
    //
    // A SNAPSHOT, not a live join. `sourceLeadId` still points at the Lead and
    // the Lead stays editable; what belongs here is what was believed when this
    // enquiry was opened, so that a later refinement can be read AGAINST it.
    // A live read would make the baseline move with the thing it is a baseline
    // for, which is the one thing it must not do.
    leadEstimate: {
      annualQuantity: { type: Number, min: 0 },
      annualQuantityConfidence: { type: String, trim: true },
      annualQuantitySource: { type: String, trim: true },
      annualRevenue: { type: Number, min: 0 },
      annualRevenueConfidence: { type: String, trim: true },
      annualRevenueSource: { type: String, trim: true },
      unitPrice: { type: Number, min: 0 },
      unitPriceConfidence: { type: String, trim: true },
      unitPriceSource: { type: String, trim: true },
      /** Stamped at conversion so the baseline can be dated in the UI. */
      capturedAt: { type: Date },
      capturedFromLeadRef: { type: String, trim: true },
    },

    // ── Sales qualification (Chunk 4) ───────────────────────────────────────
    // Is this worth pursuing, and how hard? Opportunity size is a whole-deal
    // value (restricted-commercial in spirit; kept simple here). Probability is
    // 0–100. Seriousness is the Hot/Warm/Cold read.
    opportunitySize: { type: Number, min: 0 },
    winProbability: { type: Number, min: 0, max: 100 },
    priority: { type: String, enum: ENQUIRY_PRIORITY_CODES },
    seriousness: { type: String, enum: CUSTOMER_SERIOUSNESS_CODES },
    expectedOrderDate: { type: Date },

    // ── References (Chunk 6) ────────────────────────────────────────────────
    // The supporting material for the brief. Binary file upload is deferred
    // until the platform file service is connected to the CRM; until then a
    // reference is a LINK (Pinterest, drive, etc.) or a NOTE about a physical
    // sample, tagged by type. When uploads land, `fileUrl`/`fileName` join this
    // sub-schema with no migration.
    references: [
      new mongoose.Schema(
        {
          label: { type: String, trim: true },
          type: { type: String, enum: ENQUIRY_REFERENCE_TYPE_CODES, default: "other" },
          url: { type: String, trim: true }, // a link to the reference (drive, Pinterest, …)
          note: { type: String, trim: true }, // e.g. "physical sample couriered 12 Aug"
        },
        { _id: true },
      ),
    ],

    // ── Lifecycle ───────────────────────────────────────────────────────────
    status: { type: String, enum: ENQUIRY_STATUS_CODES, default: "new", index: true },
    // Required only when status === "lost"; enforced in the route, not the
    // schema, so a mid-edit save isn't blocked before the reason is picked.
    lostReason: { type: String, enum: ENQUIRY_LOST_REASON_CODES },
    lostReasonNote: { type: String, trim: true },

    // ── Audit / lifecycle metadata, matching the other CRM models ───────────
    createdBy: actorRef(),
    updatedBy: actorRef(),
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

module.exports = mongoose.models.Enquiry || mongoose.model("Enquiry", enquirySchema);
