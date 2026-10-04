// services/maintenance/machineTag.js
//
// THE MAINTENANCE TAG ON A SEWING MACHINE — what it says, and how a scan is
// read.
//
// A tag is `MCH-` and eight characters, e.g. `MCH-7KQ2XW9P`. It is a random
// token, not the machine's name, serial number or database id: the name and
// the serial can both be edited in the Machine register, and a label that
// encoded either would silently start pointing at nothing — or at another
// machine — the day somebody corrected a typo. The token means nothing on its
// own; it resolves through the unique `maintenanceTag.code` on the machine.
//
// The alphabet has no 0/O or 1/I, so a code read aloud or typed off a worn
// label cannot be mistaken, and 32^8 (~10^12) codes leave collisions to the
// unique index, which the issuing service retries on.
//
// ── KEPT APART FROM EVERY OTHER LABEL IN THE FACTORY ────────────────────────
// The Store prints `itemid=<24 hex>` raw-item stickers (and the item-info URL
// form), store locations are `loc=LOC-XXXXXXXX`, garment pieces `WO-…`, and
// the floor scanners read `ops:` / `opsgp:` configuration codes. None of their
// parsers accepts `MCH-`, and this reader accepts none of theirs. It does not
// import them either: it only RECOGNISES their shapes, so that scanning the
// wrong label says which label it was instead of "not found" alone.
//
// Pure: no database. `machineTag.test.js` pins it.
"use strict";

const crypto = require("crypto");

const TAG_PREFIX = "MCH-";
const TAG_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TAG_BODY_LENGTH = 8;
const TAG_PATTERN = /^MCH-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

/** A fresh, random tag code. `randomInt` is injectable for tests only. */
function mintTagCode(randomInt = crypto.randomInt) {
  let body = "";
  for (let i = 0; i < TAG_BODY_LENGTH; i += 1) body += TAG_ALPHABET[randomInt(TAG_ALPHABET.length)];
  return `${TAG_PREFIX}${body}`;
}

function isTagCode(value) {
  return typeof value === "string" && TAG_PATTERN.test(value);
}

/* Labels that belong to other parts of the CMS, recognised only to name them. */
const FOREIGN = Object.freeze([
  { kind: "store-item", test: /(^|[?&])itemid=|item-info|^[0-9a-f]{24}$/i,
    reason: "This is a Store item label, not a machine tag." },
  { kind: "store-location", test: /(^|[?&])loc=|^LOC-/i,
    reason: "This is a store location label, not a machine tag." },
  { kind: "garment-piece", test: /^WO-/i,
    reason: "This is a garment piece label, not a machine tag." },
  { kind: "scanner-config", test: /^ops(gp)?:/i,
    reason: "This is a scanner configuration code, not a machine tag." },
]);

/**
 * What a scan says. Never throws.
 *   { ok: true, code }                 a well-formed machine tag
 *   { ok: false, kind, reason }        empty, another label, or unreadable
 *
 * A well-formed code is not yet a machine — only the lookup can say whether
 * a machine carries it.
 */
function readScannedCode(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, kind: "empty", reason: "Nothing was scanned." };
  const code = text.toUpperCase();
  if (TAG_PATTERN.test(code)) return { ok: true, code };
  const foreign = FOREIGN.find((f) => f.test.test(text));
  if (foreign) return { ok: false, kind: foreign.kind, reason: foreign.reason };
  return { ok: false, kind: "unknown", reason: "This code is not a machine tag." };
}

module.exports = {
  TAG_PREFIX,
  TAG_ALPHABET,
  TAG_BODY_LENGTH,
  TAG_PATTERN,
  mintTagCode,
  isTagCode,
  readScannedCode,
};
