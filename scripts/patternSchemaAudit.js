/**
 * PHASE 5 (read-only) — what the real Mongoose schema keeps, drops or changes.
 *
 * Builds a measurement group carrying every field the Desktop can author, hands it to the REAL model, and reads it
 * back through the schema. Nothing is saved: `new Model(...)` + `toObject()` runs the full cast/strip pipeline in
 * memory, which is exactly where fields are lost, so this answers the question without touching the database.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
require("../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig.js");
const Model = mongoose.model(mongoose.modelNames().find((n) => /PatternGrading/i.test(n)));

/* every field the Desktop is capable of putting on a group today */
const authored = {
  groupId: "g-sleevecap", clientId: "g-sleevecap", name: "SleeveCapCurve", groupName: "SleeveCapCurve",
  partKey: "__custom__sleevecap", assignedSize: "XS",
  catalogId: "sleeve.cap.curve",
  multiplier: 1, measurementOffset: 0.25,
  ref1: { pathIdx: 1, segIdx: 4 }, ref2: { pathIdx: 1, segIdx: 0 },
  baseFullInches: 14.58, targetFullInches: 14.58,
  gradingMode: "parametric",
  measureMode: "curve",
  measurementType: "BOUNDARY_CURVE",
  boundaryTraversal: "backward",
  boundaryRunId: "run-sleeve-cap",
  bindingBefore: { measureMode: "auto", inches: 12.75 },
  bindingVersion: 2,
  needsReview: false,
  contractVersion: 1,
  rawValue: 14.58,
  garmentValue: 14.58,
  loosingEnabled: false, loosingValueInches: 0, loosingSide: "both",
  loosingValueRef1Inches: 0, loosingValueRef2Inches: 0, conditionsFollowLoosing: false,
  nestedConditions: [], keyframes: [],
  color: "#ff0000", tuned: true,
};

const doc = new Model({
  stockItemName: "audit (not saved)",
  sizePatterns: [{ sizeName: "XS", keyframeGroups: [authored] }],
});
const back = doc.toObject().sizePatterns[0].keyframeGroups[0];

const kept = [], dropped = [], changed = [];
for (const [k, v] of Object.entries(authored)) {
  if (!(k in back) || back[k] === undefined) { dropped.push(k); continue; }
  const a = JSON.stringify(v), b = JSON.stringify(back[k]);
  if (a === b) kept.push(k); else changed.push([k, a, b]);
}

console.log("MONGOOSE FIELD AUDIT — real schema, nothing written\n");
console.log(`kept unchanged (${kept.length}): ${kept.join(", ")}\n`);
console.log(`DROPPED ENTIRELY (${dropped.length}):`);
for (const k of dropped) console.log("   ", k);
console.log(`\nCHANGED (${changed.length}):`);
for (const [k, a, b] of changed) console.log(`    ${k}: sent ${a} -> stored ${b}`);
console.log("\nsize-pattern level:");
const spSent = { sizeName: "XS", svgRevision: 4, svgChecksum: "abc123", contractVersion: 1, bytes: 1495,
  originalFilename: "shirt36.svg", svgPublicId: "x", svgFileUrl: "y", unitsPerInch: 25.4, groupsNeedReview: ["a"] };
const spDoc = new Model({ stockItemName: "audit", sizePatterns: [spSent] }).toObject().sizePatterns[0];
for (const k of Object.keys(spSent)) {
  const there = k in spDoc && spDoc[k] !== undefined;
  console.log("   ", k.padEnd(20), there ? "kept" : "DROPPED");
}
process.exit(0);
