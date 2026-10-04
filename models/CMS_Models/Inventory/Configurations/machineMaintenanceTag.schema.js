// models/CMS_Models/Inventory/Configurations/machineMaintenanceTag.schema.js
//
// THE MAINTENANCE TAG ON A MACHINE — embedded, no new collection.
//
//   maintenanceTag.code       MCH-XXXXXXXX, the token printed on the label
//   maintenanceTag.issuedAt   when it was issued
//   maintenanceTag.issuedBy   who issued it, from the session
//
// ── WHY ON THE MACHINE, AND NOT IN A COLLECTION OF ITS OWN ──────────────────
// The rule is "one machine, one tag, for ever". Stored on the machine, the
// machine has exactly one place a tag can go, so a second identity for the
// same machine is not something to detect — it cannot be written. The unique
// partial index below makes the converse true at the database: no two
// machines can carry one code. A separate tag collection would need both
// directions enforced by indexes AND would cost a collection the cluster does
// not have (it is at its 500-collection cap).
//
// ── WRITE GUARD ─────────────────────────────────────────────────────────────
// The same device machineProductionAssignment.schema.js uses. Every write that
// names `maintenanceTag` is refused unless the maintenance tag service marked
// the query with MACHINE_MAINTENANCE_TAG_WRITE_OPTION, and the service's own
// write is filtered on "no tag yet", so a tag is written once and never
// changed. `select: false` keeps it out of the Machine register's reads, so
// that form can never echo it back. Replacing a machine document is already
// refused by the production guard.
"use strict";

const mongoose = require("mongoose");

const { ObjectId } = mongoose.Schema.Types;

const MACHINE_MAINTENANCE_TAG_WRITE_OPTION = "machineMaintenanceTagWrite";
const TAG_PATH = "maintenanceTag";

/* Declared on the schema so syncIndexes keeps it, and built explicitly by the
   tag service before its first write — autoIndex is off in production.
   Frozen as a DEFINITION only: mongoose writes into the options it is given
   (it adds `background`), so every consumer is handed a fresh copy through
   `tagIndexSpec()`, never this object. */
const TAG_INDEX = Object.freeze({
  key: Object.freeze({ "maintenanceTag.code": 1 }),
  options: Object.freeze({
    name: "maintenanceTag_code_unique",
    unique: true,
    partialFilterExpression: { "maintenanceTag.code": { $type: "string" } },
  }),
});

/** A fresh, mutable `[key, options]` pair for schema.index / createIndex. */
function tagIndexSpec() {
  return [
    { ...TAG_INDEX.key },
    { ...TAG_INDEX.options, partialFilterExpression: { ...TAG_INDEX.options.partialFilterExpression } },
  ];
}

const REFUSAL =
  "A machine's maintenance tag is written only by the maintenance tag service, once, and is never changed.";

const tagActorSchema = new mongoose.Schema(
  {
    id: { type: ObjectId, default: null },
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const maintenanceTagSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true },
    issuedAt: { type: Date, required: true },
    issuedBy: { type: tagActorSchema, required: true },
  },
  { _id: false },
);

function addMaintenanceTagPaths(schema) {
  schema.add({ [TAG_PATH]: { type: maintenanceTagSchema, default: undefined, select: false } });
  schema.index(...tagIndexSpec());
}

const namesTag = (key) => String(key).split(".")[0] === TAG_PATH;

function updateTouchesTag(update) {
  if (!update) return false;
  if (Array.isArray(update)) {
    return update.some((stage) => Object.entries(stage || {}).some(([op, body]) => {
      if (["$replaceRoot", "$replaceWith", "$project"].includes(op)) return true;
      if (op === "$unset") return [].concat(body).some(namesTag);
      return Object.keys(body || {}).some(namesTag);
    }));
  }
  return Object.entries(update).some(([key, value]) => {
    if (!key.startsWith("$")) return namesTag(key);
    if (value && typeof value === "object") return Object.keys(value).some(namesTag);
    return false;
  });
}

function installMaintenanceTagGuard(schema) {
  schema.pre(["updateOne", "updateMany", "findOneAndUpdate"], function guardTagUpdate(next) {
    if (this.getOptions()?.[MACHINE_MAINTENANCE_TAG_WRITE_OPTION] === true) return next();
    if (updateTouchesTag(this.getUpdate())) return next(new Error(REFUSAL));
    return next();
  });
  schema.pre("insertMany", function guardTagInsertMany(next, docs) {
    const list = Array.isArray(docs) ? docs : [docs];
    if (list.some((d) => d?.[TAG_PATH] != null)) return next(new Error(REFUSAL));
    return next();
  });
  /* A machine is never CREATED with a tag, and a loaded machine's tag is never
     changed through `save()`. An unselected path is not "modified", so the
     register's findById → save() round trip passes untouched. */
  schema.pre("validate", function guardTagDocument(next) {
    const touched = this.isNew ? this.get(TAG_PATH) != null : this.isModified(TAG_PATH);
    if (touched) this.invalidate(TAG_PATH, REFUSAL);
    next();
  });
}

module.exports = {
  MACHINE_MAINTENANCE_TAG_WRITE_OPTION,
  TAG_PATH,
  TAG_INDEX,
  tagIndexSpec,
  addMaintenanceTagPaths,
  installMaintenanceTagGuard,
  updateTouchesTag,
};
