// models/CMS_Models/Inventory/Configurations/Warehouse.js
//
// Store & Purchase — Chunk B3. Warehouses and their internal locations.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
// The previous schema was a flat configuration record: a name, a globally
// unique `shortName`, a free-text address, `capacity` as a STRING, a stored
// `itemsCount`, and no company at all. Every field below that changed is
// changed for a reason:
//
//   · No `companyId`. Any signed-in employee read and rewrote every company's
//     warehouses, because there was nothing to scope a query by.
//   · `shortName` was globally unique, so the second company to want a "MAIN"
//     warehouse could not have one. Uniqueness has to match the numbering
//     scope, and the scope is the company.
//   · `capacity: "10000 sq ft"` cannot be compared, summed or converted, and
//     the old UI edited it through a browser prompt. A structured value, unit
//     and DIMENSION sit beside it now — floor area, storage volume or storage
//     positions, whichever the unit actually measures. None of them is stock.
//   · `itemsCount` was a stored number presented as inventory. Nothing keeps
//     it current, and stock is not held per warehouse at all yet.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
// This establishes warehouse and location IDENTITY. There are no balances
// here, no transfers, no valuation and no lots. Location-level stock arrives
// with the movement engine; nothing in this file should be read as claiming
// otherwise.

const mongoose = require("mongoose");

/* The operational locations a warehouse contains, per the product plan's
   Warehouse → Receiving / Inspection / Usable stock / Quarantine / Returns /
   Scrap / racks and bins. */
const LOCATION_TYPES = Object.freeze([
  "RECEIVING",
  "INSPECTION",
  "USABLE_STOCK",
  "QUARANTINE",
  "RETURNS",
  "SCRAP",
  "RACK_BIN",
  "OTHER",
]);

/** The set every new warehouse starts with, in the order they are worked. */
const STANDARD_LOCATIONS = Object.freeze([
  { code: "RECV", name: "Receiving", type: "RECEIVING" },
  { code: "INSP", name: "Inspection", type: "INSPECTION" },
  { code: "STOCK", name: "Usable stock", type: "USABLE_STOCK" },
  { code: "QUAR", name: "Quarantine", type: "QUARANTINE" },
  { code: "RETN", name: "Returns", type: "RETURNS" },
  { code: "SCRAP", name: "Scrap", type: "SCRAP" },
]);

const LIFECYCLE = Object.freeze(["Active", "Inactive", "Archived"]);

const locationSchema = new mongoose.Schema(
  {
    /* Unique WITHIN its warehouse. A subdocument array cannot carry its own
       unique index, so the route enforces this atomically on write — see the
       `locations.code` guard in warehouses.js. */
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: LOCATION_TYPES, required: true },

    /* Another location in the SAME warehouse. Cross-warehouse parents, self
       parents and cycles are refused by the route. */
    parent: { type: mongoose.Schema.Types.ObjectId, default: null },

    status: { type: String, enum: LIFECYCLE, default: "Active" },
    barcode: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },

    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    archiveReason: { type: String, trim: true, default: "" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
  },
  { timestamps: true, _id: true },
);

const warehouseSchema = new mongoose.Schema(
  {
    /* ── Tenancy ─────────────────────────────────────────────────────────
       Server-owned, from the resolved tenant context and never from the
       request body. Absent on every warehouse created before this boundary —
       those are legacy-global, readable only under the legacy-read policy and
       never writable until migrated. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      index: true,
    },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    name: { type: String, required: true, trim: true },

    /* ── THE WAREHOUSE CODE ──────────────────────────────────────────────
       Still `shortName`, so existing documents stay readable and existing
       callers keep working. What changed is its uniqueness: it is scoped to
       the company below, because two companies may each legitimately have a
       "MAIN". The API presents it as `code`. */
    shortName: { type: String, required: true, uppercase: true, trim: true },

    /* Kept as written, so nothing that already reads it breaks. New records
       fill the structured fields; both are returned. */
    address: { type: String, trim: true, default: "" },
    addressDetail: {
      line1: { type: String, trim: true, default: "" },
      line2: { type: String, trim: true, default: "" },
      city: { type: String, trim: true, default: "" },
      state: { type: String, trim: true, default: "" },
      postalCode: { type: String, trim: true, default: "" },
      country: { type: String, trim: true, default: "" },
    },

    contactPerson: {
      name: { type: String, trim: true, default: "" },
      phone: { type: String, trim: true, default: "" },
      email: { type: String, trim: true, default: "" },
    },

    /* ── CAPACITY: ADDITIVE, NOT REDEFINED ───────────────────────────────
       The original schema stored `capacity` as a String, and documents in the
       database still hold one there. Redefining that same path as an object
       is not an additive change: every existing measurement would have to be
       read through a shape it was never written in, and the untouched legacy
       form still POSTs a string to it.

       So the original path keeps its original type and its original data. The
       structured value lives beside it under a NEW name. Nothing is parsed
       across: "about 10,000 sq ft" is a sentence somebody wrote, not a number
       to be guessed at, and converting it silently would invent a precision
       nobody recorded.

       ── AND IT IS NOT FLOOR SPACE ────────────────────────────────────────
       Pallet positions, racks and bins are counts; cubic metres are a volume.
       Calling any of them "floor space" is wrong, so the dimension is
       recorded explicitly and the wording follows it. None of it is stock,
       utilisation or occupancy — this is what the FACILITY holds, not what is
       in it. */
    capacity: { type: String, trim: true, default: "" },
    capacityDetail: {
      value: { type: Number, default: null, min: 0 },
      unit: { type: String, trim: true, default: "" },
      dimension: {
        type: String,
        enum: ["AREA", "VOLUME", "POSITIONS", "UNKNOWN"],
        default: "UNKNOWN",
      },
    },

    status: { type: String, enum: LIFECYCLE, default: "Active" },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    archiveReason: { type: String, trim: true, default: "" },

    description: { type: String, trim: true, default: "" },

    locations: [locationSchema],

    /* ── LEGACY, AND NOT A FACT ──────────────────────────────────────────
       A stored counter that nothing maintains, from a time when the UI showed
       it as live inventory. Stock is not held per warehouse at all yet. It is
       retained only so existing documents are not silently altered; the API
       returns it under `legacyItemsCount` and never as a stock figure. */
    itemsCount: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },

    /* ── THE STRUCTURAL VERSION ──────────────────────────────────────────
       Locations live in an embedded array, so every structural change is a
       read, a decision taken against that snapshot, and a write. Between the
       decision and the write the array can change underneath it: two renames
       both see a code as free, or a parent is archived after it was checked
       and before a child is attached to it.

       Every structural write therefore carries the version it was decided
       against and increments it atomically. A write whose precondition no
       longer holds matches no document and is refused as a conflict — the
       caller re-reads and decides again. It is never retried invisibly with
       the older intent, because that intent may no longer be valid. */
    structureVersion: { type: Number, default: 0 },

    /* ── THE RECORD VERSION ──────────────────────────────────────────────
       `structureVersion` guards the LOCATION ARRAY. It says nothing about
       the warehouse's own fields, so two people editing the same warehouse
       in different browser tabs both wrote and the later one silently
       replaced the earlier one's changes — with no conflict, no warning and
       an audit trail that recorded both as successful edits.

       An ordinary edit therefore declares the version it was composed
       against, the write is conditioned on it, and it increments. A write
       whose declared version is stale matches nothing, is refused as a
       conflict, and — this is the point — never reaches history or the
       idempotency effect marker, because it never happened. */
    recordVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

/* ── UNIQUENESS IS PER COMPANY ─────────────────────────────────────────────
   The partial filter keeps legacy-global records (no companyId) out of the
   constraint entirely: they were written before the boundary and may well
   collide with each other, and refusing to load them would help nobody.

   MIGRATION NOTE — this does NOT drop the pre-existing global `shortName_1`
   unique index. Mongoose builds missing indexes; it never removes one. Until
   an authorised migration drops it, a second company still cannot create a
   warehouse whose code another company already uses. See the final report. */
warehouseSchema.index(
  { companyId: 1, shortName: 1 },
  {
    unique: true,
    name: "warehouse_code_per_company",
    partialFilterExpression: { companyId: { $type: "objectId" } },
  },
);
warehouseSchema.index({ companyId: 1, status: 1, name: 1 });
warehouseSchema.index({ companyId: 1, "locations.code": 1 });

warehouseSchema.statics.LOCATION_TYPES = LOCATION_TYPES;
warehouseSchema.statics.STANDARD_LOCATIONS = STANDARD_LOCATIONS;
warehouseSchema.statics.LIFECYCLE = LIFECYCLE;

module.exports =
  mongoose.models.Warehouse || mongoose.model("Warehouse", warehouseSchema);
module.exports.LOCATION_TYPES = LOCATION_TYPES;
module.exports.STANDARD_LOCATIONS = STANDARD_LOCATIONS;
module.exports.LIFECYCLE = LIFECYCLE;
