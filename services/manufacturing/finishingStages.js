// services/manufacturing/finishingStages.js
//
// THE FINISHING STAGES A GARMENT PASSES THROUGH BEFORE PACKING.
//
// Printing, washing, trimming and ironing — each a department with its own
// portal, its own people and its own book of scans, but the same shape of
// work: a piece is scanned, and that piece is DONE at that stage, by that
// person, at that moment. So one model, one access rule and one set of routes
// serve all of them, keyed by `stage`.
//
// A stage's `slug` is its department slug everywhere: the AccessDepartment
// row, the DepartmentRole grant, the token's deptSlug, the URL prefix.
//
// ORDER MATTERS: the keys are declared in production order, and Find Piece
// walks a garment's journey in this order. Adding a stage means adding it here
// in its place, seeding its department (ensureAccessDepartments.js) and
// mirroring it in the CMS (lib/finishing/stages.js).
"use strict";

const STAGES = Object.freeze({
  printing: Object.freeze({
    slug: "printing",
    name: "Printing",
    doneLabel: "Printed",
    action: "Mark printed",
    description: "Screen and transfer printing, piece by piece.",
    legacyRoles: Object.freeze(["printing"]),
    dashboardPath: "/printing/dashboard",
    sortOrder: 93,
  }),
  washing: Object.freeze({
    slug: "washing",
    name: "Washing",
    doneLabel: "Washed",
    action: "Mark washed",
    description: "Garment washing and drying, piece by piece.",
    legacyRoles: Object.freeze(["washing"]),
    dashboardPath: "/washing/dashboard",
    sortOrder: 94,
  }),
  trimming: Object.freeze({
    slug: "trimming",
    name: "Trimming",
    /* What the button says and what the record is called. */
    doneLabel: "Trimmed",
    action: "Mark trimmed",
    description: "Thread trimming and finishing checks, piece by piece.",
    /* Legacy session shapes that ARE this department. No legacy collection
       ever existed, so the slug is the only one. */
    legacyRoles: Object.freeze(["trimming"]),
    dashboardPath: "/trimming/dashboard",
    sortOrder: 95,
  }),
  ironing: Object.freeze({
    slug: "ironing",
    name: "Ironing",
    doneLabel: "Ironed",
    action: "Mark ironed",
    description: "Pressing and folding, piece by piece.",
    legacyRoles: Object.freeze(["ironing"]),
    dashboardPath: "/ironing/dashboard",
    sortOrder: 96,
  }),
});

const STAGE_KEYS = Object.freeze(Object.keys(STAGES));

/** The stage for a slug, or null. Never throws. */
function stageOf(slug) {
  return STAGES[String(slug || "").toLowerCase().trim()] || null;
}

module.exports = { STAGES, STAGE_KEYS, stageOf };
