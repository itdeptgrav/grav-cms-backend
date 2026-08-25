// services/sampleStyleVariant.js
//
// Branching one enquiry product into several styles developed side by side.
//
// A variant is NOT a lighter kind of style. It is a full SampleStyle with its
// own tech sheet, its own sample ladder and its own two gates, because that is
// what it is in the building: a different garment being made. The only thing
// that makes two styles siblings is sharing a journey and a product name.
//
// This file holds the parts worth testing on their own — the key, the code and
// the shape of a branched record — so the route stays a thin transaction.

"use strict";

/**
 * A stable, comparable key from a human label.
 *
 * The empty string is reserved for the BASE variant (the one provisioning
 * raises from the enquiry), so a label that slugs to nothing is rejected rather
 * than silently colliding with it.
 *
 * @param {string} label
 * @returns {string} slug, or "" if the label carries no usable characters
 */
function variantKeyFrom(label) {
  return String(label || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * The next style code for a branch.
 *
 * The base keeps the code provisioning gave it (SC-SJ-2026-0003-01) and each
 * variant appends a letter, so a code still sorts next to its siblings and
 * still says which product it belongs to: -01B, -01C, …
 *
 * Past 25 siblings it falls back to a number, which will not happen but should
 * not throw if it does.
 *
 * @param {string} baseCode        the base variant's styleCode
 * @param {number} siblingCount    how many variants already exist (base excluded)
 */
function variantStyleCode(baseCode, siblingCount) {
  const base = String(baseCode || "SC").replace(/[A-Z]$/, "");
  const n = Number(siblingCount) || 0;
  return n < 25 ? `${base}${String.fromCharCode(66 + n)}` : `${base}-${n + 2}`;
}

/**
 * The document for a new variant, branched from an existing style.
 *
 * WHAT CARRIES OVER: the linkage (journey, enquiry, product, account), the
 * owner, and the brief — because a variant is "the same thing, but…", so
 * starting from a blank brief would make whoever raises it retype the customer's
 * requirement to change one line of it. `overrides` is that one line.
 *
 * WHAT DOES NOT: every phase. Materials go back to pending, the tech sheet and
 * the sample start from nothing, and the history starts empty. Copying an
 * approval across would be claiming Sales approved something nobody has seen.
 *
 * @param {object} parent      the style being branched from (base or sibling)
 * @param {object} p
 * @param {string} p.label     human variant name, e.g. "White PC"
 * @param {string} [p.note]    why this variant exists
 * @param {object} [p.brief]   brief fields to override on the copy
 * @param {string} p.styleCode from variantStyleCode()
 * @param {object} p.actor     audit stamp
 */
function buildVariantDoc(parent, { label, note, brief, styleCode, actor }) {
  const base = parent.toObject ? parent.toObject() : parent;
  return {
    journeyId: base.journeyId,
    enquiryId: base.enquiryId,
    enquiryProductId: base.enquiryProductId,
    accountId: base.accountId,
    productName: base.productName,
    styleCode,

    variantKey: variantKeyFrom(label),
    variantLabel: String(label).trim(),
    variantNote: note ? String(note).trim() : undefined,
    // Always the BASE, never a sibling-of-a-sibling: variants of one product
    // are a flat set, and a chain would imply an order they do not have.
    variantOf: base.variantKey ? base.variantOf || base._id : base._id,
    variantChosen: false,

    ownerId: base.ownerId,
    ownerName: base.ownerName,
    brief: { ...(base.brief || {}), ...(brief || {}) },

    // A branch starts at the beginning of the ladder, whatever the parent has
    // reached. See the note above.
    stage: "brief",
    materials: { status: "pending", items: [] },
    techSheet: { status: "pending", revisions: [] },
    sample: { status: "not_started", rounds: [], revisions: [] },
    history: [],
    status: "active",

    createdBy: actor,
    updatedBy: actor,
  };
}

module.exports = { variantKeyFrom, variantStyleCode, buildVariantDoc };
