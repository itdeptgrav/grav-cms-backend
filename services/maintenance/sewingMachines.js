// services/maintenance/sewingMachines.js
//
// WHICH MACHINES IN THE REGISTER ARE SEWING MACHINES.
//
// The Machine register has no category field — `type` is free text typed by
// whoever registered the machine, and this factory spells the same machine
// several ways (4THO/L, 4TH O/L, 4T-O/L). So "is this a sewing machine" is
// answered here, once, from the type string, and nowhere else: the list, the
// detail page and the tag service all ask this module.
//
// ── WHAT COUNTS (owner's decision, 3 Oct 2026) ──────────────────────────────
// Stitching machines, plus embroidery and snap button:
//
//   SNLS DNLS SNEC  3/4/5THO/L  F/L  FOA  KANSAI  BH  EYELET_BH  BA  BT
//   EMBROIDERY  SNAP BUTTON
//
// and NOT the irons, washers, tables or the fusing machine.
//
// ── WHY NOT THE FLOOR DESIGNER'S CATALOGUE ──────────────────────────────────
// `tracker/factory/assets.js` in the CMS resolves type strings for drawing,
// and it reads `F/M` as feed-of-the-arm. The one `F/M` machine in this
// register is FUSING_MACHINE_1. It also leaves FOA and KANSAI unresolved. A
// drawing that is slightly wrong is a cosmetic fault; a maintenance list that
// offers a fusing press as a sewing machine, or hides a Kansai, is a wrong
// answer. So the rule lives here, matched against the live register.
//
// Pure: no database, no mongoose. `sewingMachines.test.js` pins it against
// every type string the register held on 3 Oct 2026.
"use strict";

/** Upper case, drop a trailing `*N` head count, drop spaces / - _ . / */
function normaliseType(raw) {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/\*\d+\s*$/, "")
    .replace(/[\s\-_.\/]/g, "");
}

/* Order matters only where one token contains another: EYELET and KEYHOLE are
   tested before the bare BH buttonhole. Every pattern is anchored or names a
   whole word, so `FM` (the fusing machine) matches nothing. */
const FAMILIES = Object.freeze([
  { key: "snls", label: "Single needle lockstitch", match: /^SNLS$/ },
  { key: "dnls", label: "Double needle lockstitch", match: /^DNLS$/ },
  { key: "snec", label: "Single needle edge cutter", match: /^SNEC$/ },
  { key: "overlock3", label: "Overlock, 3 thread", match: /^3T(H)?OL$/ },
  { key: "overlock4", label: "Overlock, 4 thread", match: /^4T(H)?OL$/ },
  { key: "overlock5", label: "Overlock, 5 thread", match: /^5T(H)?OL$/ },
  { key: "overlock", label: "Overlock", match: /OVERLOCK/ },
  { key: "flatlock", label: "Flatlock", match: /^FL$|FLATLOCK/ },
  { key: "feedOffArm", label: "Feed-off-the-arm", match: /^FOA$|FEEDOF/ },
  { key: "kansai", label: "Kansai multi-needle", match: /KANSAI/ },
  { key: "eyeletButtonhole", label: "Eyelet buttonhole", match: /EYELET/ },
  { key: "keyhole", label: "Keyhole buttonhole", match: /KEYHOLE/ },
  { key: "buttonhole", label: "Buttonhole", match: /^BH$|BUTTONHOLE/ },
  { key: "buttonAttach", label: "Button attach", match: /^BA$|BUTTONATTACH/ },
  { key: "bartack", label: "Bartack", match: /^BT$|BARTACK/ },
  { key: "snapButton", label: "Snap button", match: /SNAPBUTTON/ },
  { key: "embroidery", label: "Embroidery", match: /EMBROIDERY|EMBROIDARY|EMBRIODORY/ },
]);

/** The sewing family a type string belongs to, or null when it is not one. */
function sewingFamilyOf(type) {
  const token = normaliseType(type);
  if (!token) return null;
  const family = FAMILIES.find((f) => f.match.test(token));
  return family ? { key: family.key, label: family.label } : null;
}

function isSewingMachineType(type) {
  return sewingFamilyOf(type) !== null;
}

module.exports = { normaliseType, sewingFamilyOf, isSewingMachineType, FAMILIES };
