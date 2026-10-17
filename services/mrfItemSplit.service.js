// services/mrfItemSplit.service.js
//
// SPLITTING ONE REQUESTED LINE INTO SEVERAL  (13 Oct 2026, owner)
//
// A requester writes what they need in their own words — "Button (18L & 14L)
// highlander, 2 Pcs" — and that is one line. To the Store it is two products:
// one 18L button and one 14L button, each a different raw item or variant,
// each issued from its own shelf. The Store splits the line:
//
//   · the line keeps its _id, its history and its approval, and becomes part 1;
//   · the other parts are new lines inserted right after it;
//   · the parts' quantities add up to exactly what the line asked for;
//   · each part may be matched to its own inventory product straight away, or
//     later with Search to Match, and from then on every part is an ordinary
//     line — matched, reserved, issued and returned on its own.
//
// Rules, each stated where it is enforced:
//
//   · only a line the Store can still change: approved, UNMATCHED or matched
//     (APPROVED), nothing issued, returned or consumed, no stock reserved for
//     it, no purchase form or purchase order raised from it, not customer-
//     supplied (that routes to a customer-material expectation keyed by the
//     line). Each refusal says what to do instead.
//   · the total is kept: the parts must add up to the line's quantity.
//   · "Undo split" puts the original line back exactly as it was — while
//     nothing has been issued, reserved, bought or rejected on any part.
//
// Pure where it can be: the route reads reservations and purchase orders and
// hands their line ids in, and these functions decide.
"use strict";

const { lineApproval, DECISION } = require("./mrfItemApproval.service");

const SPLITTABLE = Object.freeze(["UNMATCHED", "APPROVED"]);
const MAX_PARTS = 20;
const TOL = 0.0001;

const str = (v) => String(v ?? "").trim();
const idStr = (v) => (v ? String(v._id || v) : "");
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const plainOf = (line) => (line && typeof line.toObject === "function" ? line.toObject({ depopulate: true }) : { ...(line || {}) });

/** Every line of a split group, in request order — or [line] for one never split. */
function groupLines(mrf, line) {
  const gid = idStr(line?.split?.groupId);
  if (!gid) return line ? [line] : [];
  return (mrf.items || []).filter((l) => idStr(l.split?.groupId) === gid);
}

/** The original line of a group (the one whose _id is the group's id). */
function rootOf(mrf, groupId) {
  return (mrf.items || []).find((l) => idStr(l._id) === idStr(groupId)) || null;
}

/**
 * Why this line cannot be split, or null.
 *
 * @param ctx.reservedLineIds  Set of line ids holding an ACTIVE stock reservation
 * @param ctx.orderedLineIds   Set of line ids a live purchase order line names
 */
function splitRefusal(mrf, line, { reservedLineIds = new Set(), orderedLineIds = new Set() } = {}) {
  if (!line) return { reason: "NOT_FOUND", message: "That item is not on this request." };
  const id = idStr(line._id);
  if ((line.issuedQty || 0) > 0 || (line.returnedQty || 0) > 0 || (line.consumedQty || 0) > 0) {
    return { reason: "ISSUED", message: "Something has already been issued on this item, so it can no longer be split." };
  }
  if (!SPLITTABLE.includes(line.itemStatus)) {
    return { reason: "STATUS", message: `This item is ${str(line.itemStatus).toLowerCase().replace(/_/g, " ")}, so it can no longer be split.` };
  }
  if (lineApproval(line, mrf).decision !== DECISION.APPROVED) {
    return { reason: "NOT_APPROVED", message: "This item has not been approved, so the Store cannot split it." };
  }
  if (line.supplySource === "CUSTOMER_SUPPLIED") {
    return { reason: "CUSTOMER_SUPPLIED", message: "The customer is supplying this item, so it is received against their delivery and cannot be split here." };
  }
  if (line.purchaseFormRaised || line.purchaseRequisitionId || (line.buyQty || 0) > 0) {
    return { reason: "PURCHASE_FORM", message: `A purchase form${line.purchaseRequisitionNumber ? ` (${line.purchaseRequisitionNumber})` : ""} was raised for this item, so it cannot be split.` };
  }
  if (orderedLineIds.has(id)) {
    return { reason: "ON_PURCHASE_ORDER", message: "A purchase order was raised from this item, so it cannot be split." };
  }
  if (reservedLineIds.has(id)) {
    return { reason: "RESERVED", message: "Stock is reserved for this item. Release the reservation under Reservations & picking, then split it." };
  }
  if (!(Number(line.requestedQty) > 0)) {
    return { reason: "NOTHING", message: "This item asks for nothing, so there is nothing to split." };
  }
  return null;
}

/**
 * The parts as the Store typed them, checked: 2 to 20, each a positive
 * quantity, adding up to exactly what the line asks for. A part may name a
 * product to match to (`rawItemId`, `variantId`).
 */
function readParts(line, input) {
  const list = Array.isArray(input) ? input : [];
  if (list.length < 2) return { error: { reason: "TOO_FEW", message: "Split into at least two lines." } };
  if (list.length > MAX_PARTS) return { error: { reason: "TOO_MANY", message: `Split into at most ${MAX_PARTS} lines.` } };
  const parts = [];
  for (let i = 0; i < list.length; i += 1) {
    const q = r4(parseFloat(list[i]?.quantity));
    if (!(q > 0)) return { error: { reason: "QUANTITY", message: `Line ${i + 1} needs a quantity above zero.` } };
    parts.push({
      quantity: q,
      rawItemId: str(list[i]?.rawItemId) || null,
      variantId: str(list[i]?.variantId) || null,
    });
  }
  const total = r4(parts.reduce((s, p) => s + p.quantity, 0));
  const asked = r4(line.requestedQty);
  if (Math.abs(total - asked) > TOL) {
    return {
      error: {
        reason: "TOTAL",
        message: `The lines add up to ${total} ${str(line.unit)}; the item asks for ${asked} ${str(line.unit)}. The total must stay the same.`,
        total, asked,
      },
    };
  }
  return { parts };
}

/**
 * The same assignment PATCH /:id/items/:itemId/match makes — the matched
 * product's own unit wins, the line becomes APPROVED (ready to issue), and the
 * requester's free-text category and attributes are dropped. One function, so
 * a part matched while splitting and a line matched later read the same.
 */
function applyCatalogueMatch(item, rawItem, { variantId = null, variantCombination = [] } = {}) {
  const unit = rawItem.customUnit || rawItem.unit || "unit";
  item.rawItem = rawItem._id;
  item.rawItemName = rawItem.name;
  item.rawItemSku = rawItem.sku || "";
  item.variantId = variantId || null;
  item.variantCombination = variantCombination || [];
  item.unit = unit;
  item.baseUnit = unit;
  item.itemStatus = "APPROVED";
  item.category = "";
  item.attributes = [];
  return item;
}

/** Whether a variant belongs to this product, and its combination as strings. */
function variantFor(rawItem, variantId) {
  const v = (rawItem?.variants || []).find((x) => idStr(x._id) === str(variantId));
  if (!v) return null;
  return { _id: v._id, combination: (v.combination || []).map((c) => str(c?.value ?? c)).filter(Boolean) };
}

/**
 * Check every product a part names: it must exist, and a product with
 * variants needs one of ITS variants. Answers Map(partIndex → { rawItem, variant }).
 *
 * @param rawItemsById Map(rawItemId → lean RawItem with name sku unit customUnit variants)
 */
function readMatches(parts, rawItemsById) {
  const matches = new Map();
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (!p.rawItemId) continue;
    const rawItem = rawItemsById.get(p.rawItemId);
    if (!rawItem) return { error: { reason: "PRODUCT", message: `Line ${i + 1}: that product is not in the inventory.` } };
    const hasVariants = (rawItem.variants || []).length > 0;
    let variant = null;
    if (hasVariants) {
      if (!p.variantId) return { error: { reason: "VARIANT", message: `Line ${i + 1}: ${rawItem.name} has variants — pick one.` } };
      variant = variantFor(rawItem, p.variantId);
      if (!variant) return { error: { reason: "VARIANT", message: `Line ${i + 1}: that variant is not one of ${rawItem.name}'s.` } };
    }
    matches.set(i, { rawItem, variant });
  }
  return { matches };
}

/* The fields a new part copies from the line it was split from. Everything
   about what happened to the line (issues, returns, purchase forms,
   reservation attempts, the availability report, store notes) starts fresh:
   it described the WHOLE line, not this part of it. */
const COPIED = Object.freeze([
  "rawItem", "rawItemName", "rawItemSku", "variantId", "variantCombination",
  "category", "attributes", "description", "specifications", "images",
  "unit", "baseUnit", "itemStatus", "supplySource", "warehouseId",
]);
const SNAPSHOT = Object.freeze([
  "rawItem", "rawItemName", "rawItemSku", "variantId", "variantCombination",
  "category", "attributes", "unit", "baseUnit", "itemStatus", "requestedQty", "approval",
]);

function resetWork(item) {
  item.availability = "UNREVIEWED";
  item.availableQty = null;
  item.availabilityNote = "";
  item.availabilityUpdatedAt = null;
  item.availabilityUpdatedBy = null;
  item.availabilityUpdatedByName = "";
  item.autoReserve = { attemptedAt: null, outcome: null, reason: "", message: "", reservedQty: 0, shortQty: 0, trigger: "", actorName: "", attempts: 0 };
}

/**
 * Split the line in place. `mrf` is a mongoose document; nothing is saved here.
 *
 * @param parts    from readParts
 * @param matches  from readMatches
 * @returns { groupId, lineIds } — the parts in order, the original line first
 */
function applySplit(mrf, lineId, parts, matches = new Map(), { actorId = null, actorName = "", now = new Date() } = {}) {
  const line = mrf.items.id(lineId);
  if (!line) throw new Error("line not found");
  const before = plainOf(line);
  const total = r4(parts.reduce((s, p) => s + p.quantity, 0));

  /* The group is the ORIGINAL line's: a part split again joins the same group,
     so "Undo split" always goes back to what the requester asked for. */
  const groupId = line.split?.groupId || line._id;
  if (!line.split) {
    const original = {};
    for (const k of SNAPSHOT) original[k] = before[k] === undefined ? null : before[k];
    line.split = {
      groupId, originalQty: r4(before.requestedQty), originalUnit: str(before.unit), originalName: str(before.rawItemName),
      at: now, by: actorId, byName: str(actorName), original,
    };
  }

  /* The manager's figures stay true across the group: approved quantities add
     up to what was approved, and what the requester asked for and what the
     manager cut stay on the original line. */
  const a = before.approval && before.approval.decision ? before.approval : null;
  const others = r4(total - parts[0].quantity);
  if (a) {
    line.approval = {
      ...a,
      requestedQty: r4(Math.max(parts[0].quantity, (a.requestedQty ?? before.requestedQty) - others)),
      approvedQty: parts[0].quantity,
    };
  }
  line.requestedQty = parts[0].quantity;
  resetWork(line);

  const created = [];
  for (let i = 1; i < parts.length; i += 1) {
    const doc = {};
    for (const k of COPIED) if (before[k] !== undefined) doc[k] = before[k];
    Object.assign(doc, {
      requestedQty: parts[i].quantity,
      issuedQty: 0, returnedQty: 0, consumedQty: 0,
      buyQty: 0, purchaseFormRaised: false, purchaseRequisitionId: null, purchaseRequisitionNumber: "", purchaseFormRaisedAt: null,
      returnHistory: [], issueHistory: [], storeNotes: "",
      split: { groupId, originalQty: line.split.originalQty, originalUnit: line.split.originalUnit, originalName: line.split.originalName, at: now, by: actorId, byName: str(actorName) },
      ...(a ? {
        approval: {
          decision: DECISION.APPROVED,
          requestedQty: parts[i].quantity, approvedQty: parts[i].quantity, rejectedQty: 0,
          reason: "", decidedBy: a.decidedBy ?? null, decidedByName: a.decidedByName || "", decidedById: a.decidedById || "", decidedAt: a.decidedAt || null,
        },
      } : {}),
    });
    const sub = mrf.items.create(doc);
    resetWork(sub);
    created.push(sub);
  }
  const at = mrf.items.findIndex((l) => idStr(l._id) === idStr(line._id));
  mrf.items.splice(at + 1, 0, ...created);

  const lines = [line, ...created];
  for (const [i, m] of matches) {
    applyCatalogueMatch(lines[i], m.rawItem, { variantId: m.variant?._id || null, variantCombination: m.variant?.combination || [] });
  }
  return { groupId, lineIds: lines.map((l) => idStr(l._id)) };
}

/** Why the group cannot be put back together, or null. */
function undoRefusal(mrf, groupId, { reservedLineIds = new Set(), orderedLineIds = new Set() } = {}) {
  const root = rootOf(mrf, groupId);
  if (!root || !root.split?.original) return { reason: "NOT_SPLIT", message: "This item was not split, so there is nothing to undo." };
  const lines = (mrf.items || []).filter((l) => idStr(l.split?.groupId) === idStr(groupId));
  for (const l of lines) {
    const name = `"${str(l.rawItemName)}"`;
    if ((l.issuedQty || 0) > 0 || (l.returnedQty || 0) > 0 || (l.consumedQty || 0) > 0) {
      return { reason: "ISSUED", message: `${name} has already been issued, so the split cannot be undone.` };
    }
    if (!SPLITTABLE.includes(l.itemStatus)) {
      return { reason: "STATUS", message: `${name} is ${str(l.itemStatus).toLowerCase().replace(/_/g, " ")}, so the split cannot be undone.` };
    }
    if (l.purchaseFormRaised || l.purchaseRequisitionId || (l.buyQty || 0) > 0 || orderedLineIds.has(idStr(l._id))) {
      return { reason: "PURCHASE", message: `${name} is being bought, so the split cannot be undone.` };
    }
    if (reservedLineIds.has(idStr(l._id))) {
      return { reason: "RESERVED", message: `Stock is reserved for ${name}. Release it under Reservations & picking first.` };
    }
  }
  return null;
}

/** Put the original line back exactly as it was before the split. */
function applyUndo(mrf, groupId) {
  const root = rootOf(mrf, groupId);
  const original = root.split.original || {};
  const removed = [];
  for (let i = mrf.items.length - 1; i >= 0; i -= 1) {
    const l = mrf.items[i];
    if (idStr(l.split?.groupId) === idStr(groupId) && idStr(l._id) !== idStr(groupId)) {
      removed.push(idStr(l._id));
      mrf.items.splice(i, 1);
    }
  }
  for (const k of SNAPSHOT) {
    if (k === "approval") { root.approval = original.approval || undefined; continue; }
    const v = original[k];
    root[k] = v === null || v === undefined ? (["variantCombination", "attributes"].includes(k) ? [] : null) : v;
  }
  resetWork(root);
  root.split = undefined;
  return { lineId: idStr(root._id), removed };
}

/**
 * What the Store page shows per line: whether Split is offered and why not,
 * and, on the original line of a group, whether Undo split is.
 */
function splitStanding(mrf, ctx = {}) {
  const out = new Map();
  for (const l of mrf.items || []) {
    const refusal = splitRefusal(mrf, l, ctx);
    const isRoot = Boolean(l.split?.original) && idStr(l._id) === idStr(l.split?.groupId);
    const undo = isRoot ? undoRefusal(mrf, l._id, ctx) : null;
    out.set(idStr(l._id), {
      canSplit: !refusal,
      reason: refusal?.message || "",
      ...(isRoot ? { canUndo: !undo, undoReason: undo?.message || "" } : {}),
    });
  }
  return out;
}

module.exports = {
  SPLITTABLE,
  MAX_PARTS,
  groupLines,
  rootOf,
  splitRefusal,
  readParts,
  readMatches,
  variantFor,
  applyCatalogueMatch,
  applySplit,
  undoRefusal,
  applyUndo,
  splitStanding,
};
