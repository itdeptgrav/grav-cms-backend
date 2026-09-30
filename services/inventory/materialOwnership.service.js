"use strict";
// services/inventory/materialOwnership.service.js
//
// A MATERIAL'S DEFAULT OWNERSHIP — THE ONE RULE, USED BY EVERY DOOR.
//
// Store's item form, the Development BOM's registration drawer, the edit
// route and the receiving reads that show the default all read this file, so
// none of them can accept a word the others refuse.
//
// ── WHAT THIS DECIDES, AND WHAT IT NEVER TOUCHES ────────────────────────────
// One catalogue field: `defaultOwnership`, COMPANY_OWNED or CUSTOMER_OWNED.
// It returns that field and nothing else — no quantity, no movement, no lot,
// no valuation — so a caller that assigns exactly what it returns cannot move
// stock by accident. Physical ownership stays where it has always been
// decided: on the receipt, the lot and each movement.
const {
  DEFAULT_OWNERSHIP, OWNERSHIP_WORDS, isDefaultOwnership,
} = require("../../models/CMS_Models/Inventory/Products/materialOwnership");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const { fail } = require("../storePurchase/errors");
const tenantContext = require("../storePurchase/tenantContext.service");
const mongoose = require("mongoose");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/* ── THE PAYLOAD, READ ONCE ───────────────────────────────────────────────────
   `present` says whether the caller spoke about ownership at all. An absent
   field on an edit means "not part of this change"; on a create it means the
   default. An unknown word — including an empty one — is refused, never
   guessed. */
function normaliseOwnershipInput(payload = {}) {
  if (payload.defaultOwnership === undefined) return { present: false, defaultOwnership: undefined };
  const word = str(payload.defaultOwnership).toUpperCase();
  if (!isDefaultOwnership(word)) {
    throw fail("VALIDATION",
      `Ownership must be ${DEFAULT_OWNERSHIP.COMPANY_OWNED} or ${DEFAULT_OWNERSHIP.CUSTOMER_OWNED}.`,
      { field: "defaultOwnership", allowed: Object.values(DEFAULT_OWNERSHIP) });
  }
  return { present: true, defaultOwnership: word };
}

/**
 * The one field a create or an edit should assign, and NOTHING else.
 * `stored` is the material as it is (null on a create); a payload that says
 * nothing keeps it, and a create that says nothing is company owned.
 *
 * @returns {{ changed: boolean, defaultOwnership: string }}
 */
function resolveOwnership({ stored = null, payload = {} } = {}) {
  const input = normaliseOwnershipInput(payload);
  const current = isDefaultOwnership(stored?.defaultOwnership)
    ? str(stored.defaultOwnership).toUpperCase()
    : DEFAULT_OWNERSHIP.COMPANY_OWNED;
  if (!input.present) return { changed: false, defaultOwnership: current };
  return { changed: input.defaultOwnership !== current, defaultOwnership: input.defaultOwnership };
}

/* ── WHAT A SCREEN READS ──────────────────────────────────────────────────────
   One shape for the list, the detail, the pickers and the receiving screens:
   the word and its label. An item written before the field existed reads as
   company owned rather than as nothing. */
function ownershipView(item) {
  const code = isDefaultOwnership(item?.defaultOwnership)
    ? str(item.defaultOwnership).toUpperCase()
    : DEFAULT_OWNERSHIP.COMPANY_OWNED;
  return { defaultOwnership: code, label: OWNERSHIP_WORDS[code] };
}

/**
 * The defaults of several materials at once — for a receiving screen that
 * shows, beside each line, what the catalogue says the goods normally are.
 * Read within the company; a foreign or missing id is simply absent from the
 * map, and the screen then says nothing rather than guessing.
 */
async function materialDefaultsFor(tenant, rawItemIds = [], session = null) {
  const ids = [...new Set((rawItemIds || []).map(str).filter(isId))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = await RawItem.find({ ...tenantContext.tenantFilter(tenant), _id: { $in: ids } })
    .select("_id defaultOwnership").session(session).lean();
  for (const r of rows) out.set(str(r._id), ownershipView(r));
  return out;
}

module.exports = {
  DEFAULT_OWNERSHIP, OWNERSHIP_WORDS,
  normaliseOwnershipInput, resolveOwnership, ownershipView, materialDefaultsFor,
};
