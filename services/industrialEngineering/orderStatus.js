// services/industrialEngineering/orderStatus.js
//
// WHICH BUCKET A WORK ORDER'S STATUS FALLS IN — one answer, for the endpoint
// and for the audit.
//
// The lists are `WorkOrder`'s own enum, not a paraphrase of it. A status the
// model declares later and nobody adds here becomes `UNRECOGNISED` rather than
// being silently counted as open, which matters because "open" is the
// denominator every coverage figure and every lifecycle warning rests on.
"use strict";

const str = (v) => String(v ?? "").trim();

const OPERATIONAL_STATUSES = Object.freeze([
  "pending", "planned", "scheduled", "ready_to_start",
  "in_progress", "paused", "delayed", "partial_allocation", "forwarded",
]);
const COMPLETED_STATUSES = Object.freeze(["completed"]);
const CANCELLED_STATUSES = Object.freeze(["cancelled"]);

const STATUS_CLASS = Object.freeze({
  OPERATIONAL: "OPERATIONAL",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  /* Absent, blank, or a value the enum does not declare. Reported on its own
     rather than folded into "open". */
  UNRECOGNISED: "UNRECOGNISED",
});

function statusClassOf(order) {
  const status = str(order?.status);
  if (!status) return STATUS_CLASS.UNRECOGNISED;
  if (OPERATIONAL_STATUSES.includes(status)) return STATUS_CLASS.OPERATIONAL;
  if (COMPLETED_STATUSES.includes(status)) return STATUS_CLASS.COMPLETED;
  if (CANCELLED_STATUSES.includes(status)) return STATUS_CLASS.CANCELLED;
  return STATUS_CLASS.UNRECOGNISED;
}

module.exports = {
  STATUS_CLASS, OPERATIONAL_STATUSES, COMPLETED_STATUSES, CANCELLED_STATUSES, statusClassOf,
};
