// services/inventory/variantIdentity.js
//
// WHICH STORED VARIANT AN INCOMING ROW IS, AND ONE IDENTITY EACH  (9 Oct 2026)
//
// The raw-item update route rebuilds the variant list from the form's rows
// and keeps each row's stored identity (_id) so its balance, aliases and
// conversions survive. It matched a row by id, else by combination, and
// wrote `_id: existing._id` — so when two rows resolved to ONE stored
// variant (a renamed row still carrying the id, and a fresh row with the
// old combination), the item was saved with the same _id on two variants,
// and the stored balance on both. From then on every edit was refused:
// "variants[78] repeats a variant already listed" (the owner, 8–9 Oct 2026,
// RAW-BUT-BUT-977 on production).
//
// `assignIds(rows, stored)` pairs every row with at most one stored variant
// and every stored variant with at most one row:
//
//   pass 1  a row whose COMBINATION is a stored variant's claims it — the
//           combination is what the person sees, so "Green" is the stored
//           Green whatever id the form sent;
//   pass 2  a row carrying the ID of a still-unclaimed stored variant claims
//           it — a true rename ("Green" → "Green Khaki", no Green left);
//   pass 3  a row KIN to a still-unclaimed stored variant claims it: an
//           attribute was added or removed, so every combination changed
//           length (["Fancy Corner","Green"] → ["Fancy Corner","Green","18L"]);
//           the first row built from the old variant keeps its identity and
//           balance, the other sizes are new. Without this, adding Size to an
//           item gave every variant a fresh id and dropped its stock — and
//           stickers, aliases and conversions are stored against those ids
//           (the owner, 9 Oct 2026).
//   else    the row is a NEW variant: fresh id, no balance, no aliases.
//
// A stored variant that nobody claims is dropped, as before. An item saved
// with one id on two variants is matched row by row by combination (pass
// 1) and comes out of its next save with one id each.
"use strict";

const mongoose = require("mongoose");

const sid = (v) => (v === null || v === undefined ? "" : String(v));
const combo = (v) => (Array.isArray(v?.combination) ? v.combination.map((c) => sid(c).trim()) : []);
const sameCombination = (a, b) => {
  const x = combo(a), y = combo(b);
  return x.length > 0 && x.length === y.length && x.every((c, i) => c === y[i]);
};
/** The shorter combination is the longer one with values inserted, in order. */
const kinCombination = (a, b) => {
  const x = combo(a).filter(Boolean), y = combo(b).filter(Boolean);
  if (!x.length || !y.length || x.length === y.length) return false;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  let i = 0;
  for (const v of long) if (i < short.length && v === short[i]) i += 1;
  return i === short.length;
};

/**
 * @returns {Array<{ incoming, existing, _id }>} in the incoming order; `existing`
 *   is the stored variant the row keeps (balance, aliases, conversions) or null.
 */
function assignIds(rows = [], stored = []) {
  const list = Array.isArray(stored) ? stored : [];
  const input = Array.isArray(rows) ? rows : [];
  const claimed = new Set();           // indexes into `list`
  const pairing = new Array(input.length).fill(null);

  input.forEach((incoming, i) => {
    const at = list.findIndex((e, k) => !claimed.has(k) && sameCombination(e, incoming));
    if (at >= 0) { claimed.add(at); pairing[i] = at; }
  });
  input.forEach((incoming, i) => {
    if (pairing[i] !== null) return;
    const id = sid(incoming?._id);
    if (!id) return;
    const at = list.findIndex((e, k) => !claimed.has(k) && sid(e?._id) === id);
    if (at >= 0) { claimed.add(at); pairing[i] = at; }
  });
  input.forEach((incoming, i) => {
    if (pairing[i] !== null) return;
    const at = list.findIndex((e, k) => !claimed.has(k) && kinCombination(e, incoming));
    if (at >= 0) { claimed.add(at); pairing[i] = at; }
  });

  const used = new Set();
  return input.map((incoming, i) => {
    const existing = pairing[i] === null ? null : list[pairing[i]];
    let _id = existing?._id ? sid(existing._id) : "";
    if (!_id || used.has(_id)) _id = sid(new mongoose.Types.ObjectId());
    used.add(_id);
    return { incoming, existing, _id: new mongoose.Types.ObjectId(_id) };
  });
}

/** Stored variants that share an id — what an item saved before this fix may hold. */
function duplicateIds(stored = []) {
  const seen = new Map();
  for (const v of Array.isArray(stored) ? stored : []) {
    const id = sid(v?._id);
    if (id) seen.set(id, (seen.get(id) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}

module.exports = { assignIds, duplicateIds, sameCombination, kinCombination };
