// models/CMS_Models/PPC/PpcPlanningCommand.js
//
// THE PLANNING FILE'S COMMAND LEDGER — WRITTEN IN THE SAME TRANSACTION AS THE
// EFFECT IT RECORDS.
//
// ── WHY NOT THE SHARED LEDGER ───────────────────────────────────────────────
// `services/ppc/commandOnce.js` writes `MerchandisingCommandLedger` AFTER the
// command has run, and says so: two concurrent requests carrying one key both
// reach the command, and the caller's own unique index is left to decide. That
// is right for the pack and IE-release receipts, which have such an index, and
// those accepted flows are not changed.
//
// A planning file's lifecycle commands have no such index — two identical
// "mark planned" requests would both pass the revision check if they arrived
// in sequence, and the second would read as a stale conflict rather than as the
// replay it is. So planning commands keep their own ledger, and write it INSIDE
// the transaction that makes the change: the ledger row and the business effect
// commit together or not at all. A command that happened always has its row,
// a row always has its command, and a lost reply is answered from the row.
//
// ── WHAT A ROW HOLDS ────────────────────────────────────────────────────────
// The exact public envelope the first request answered with — `created`, the
// state, the revision and the planning file's reference included — because a
// replay has to say what the first answer said, not what the record says now.
// It holds nothing that is not already PPC's own: the envelope is a projection
// of PPC's planning file, with no upstream content and no receipt identity.
"use strict";

const mongoose = require("mongoose");

const commandSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    /* One record's commands share a scope, so one key does one thing to it. */
    scope: { type: String, required: true, trim: true, immutable: true },
    idempotencyKey: { type: String, required: true, trim: true, immutable: true },
    requestHash: { type: String, required: true, trim: true, immutable: true },
    command: { type: String, required: true, trim: true, immutable: true },
    planningFileId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
    envelope: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
    at: { type: Date, required: true, immutable: true },
  },
  { collection: "ppc_planning_commands", minimize: false },
);

commandSchema.index(
  { companyId: 1, scope: 1, idempotencyKey: 1 },
  { unique: true, name: "ppc_planning_command_once" },
);

/* ── INSERT-ONLY ─────────────────────────────────────────────────────────
   A ledger row is the answer a command gave. There is no state in which
   rewriting it is correct. */
const refuse = () => {
  const err = new Error("A PPC planning command record is written once and never changed.");
  err.name = "PpcPlanningCommandImmutable";
  err.code = "PPC_PLANNING_COMMAND_IMMUTABLE";
  return err;
};
commandSchema.pre("save", function onlyInsert(next) { return next(this.isNew ? undefined : refuse()); });
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace",
  "bulkWrite", "insertMany"]) {
  commandSchema.pre(op, function refuseWrite(next) { return next(refuse()); });
}
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
  commandSchema.pre(op, { query: true, document: false }, function refuseDelete(next) { return next(refuse()); });
}
commandSchema.pre("deleteOne", { document: true, query: false }, function refuseDocDelete(next) {
  return next(refuse());
});

module.exports = {
  PpcPlanningCommand: mongoose.models.PpcPlanningCommand
    || mongoose.model("PpcPlanningCommand", commandSchema),
};
