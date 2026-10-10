// services/storePurchase/mrfNumber.service.js
//
// A NUMBER FOR A NEW MATERIAL REQUEST THAT NO REQUEST ALREADY CARRIES.
//
// `documentSequence.allocate` is atomic: two requests raised in the same
// moment can never be handed the same number. What it cannot know is whether
// the numbers it hands out are already in use — and they are, whenever the
// counter is BEHIND the requests: a database copied or restored with its
// requests but an older counter (9 Oct 2026: the local copy's counter said 8
// while MRF/2026-27/0009 and 0010 existed). Every new request then failed on
// the unique index with a raw "E11000 duplicate key" on the requester's form,
// and each attempt burnt one number, so they failed until the counter crept
// past the last request on its own.
//
// So a number that is already taken is not handed out: the counter is moved
// past the highest number in use — forward only, `$max` — and a fresh one is
// allocated. The check is global, not per company, because the legacy global
// `mrfNumber_1` unique index still exists on deployments that have not retired
// it (scripts/migrations/store-purchase-mrf-number-index.js); a number another
// company holds collides there just the same.
"use strict";

const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const documentSequence = require("./documentSequence.service");
const { fail } = require("./errors");

const DOCUMENT_TYPE = "MATERIAL_REQUEST";
/* One repair is the normal case; more than a few means something keeps
   writing numbers behind the counter's back, which a loop must not hide. */
const MAX_REPAIRS = 3;

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The highest sequence any request already carries under this prefix. */
async function highestInUse(prefix) {
  const rows = await MRF.find({ mrfNumber: { $regex: `^${escapeRx(prefix)}\\d+$` } })
    .select("mrfNumber").lean();
  return rows.reduce(
    (top, r) => Math.max(top, parseInt(String(r.mrfNumber).slice(prefix.length), 10) || 0),
    0,
  );
}

/**
 * Allocate a material-request number that is free.
 *
 * Same arguments and result as `documentSequence.allocate` for
 * `MATERIAL_REQUEST` — `{ number, sequence, fiscalYear }`.
 */
async function allocate({ companyId, siteId = null, at = new Date() }) {
  for (let repairs = 0; ; repairs += 1) {
    const allocated = await documentSequence.allocate({ companyId, documentType: DOCUMENT_TYPE, siteId, at });
    if (!(await MRF.exists({ mrfNumber: allocated.number }))) return allocated;

    if (repairs >= MAX_REPAIRS) {
      throw fail("LIFECYCLE_BLOCKED",
        "A free material request number could not be found — the numbering counter keeps landing on numbers that are already used. Ask IT to check the material request counter.",
        { reason: "MRF_NUMBER_COUNTER_BEHIND", lastTried: allocated.number });
    }
    const prefix = `${documentSequence.DOCUMENT_TYPES[DOCUMENT_TYPE].prefix}/${allocated.fiscalYear}/`;
    const top = await highestInUse(prefix);
    console.warn(
      `[mrfNumber] ${allocated.number} is already used — the counter was behind; moving it to ${top}.`,
    );
    await documentSequence.advanceTo({
      companyId, documentType: DOCUMENT_TYPE, fiscalYear: allocated.fiscalYear, siteId, sequence: top,
    });
  }
}

module.exports = { allocate, highestInUse };
