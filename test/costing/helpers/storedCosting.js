// test/costing/helpers/storedCosting.js
//
// THE STORED SHAPE OF A COSTING, READ IN ONE PLACE.
//
// ── THE MISTAKE THIS EXISTS TO PREVENT ──────────────────────────────────────
// A `CostingVersion` holds `inputs` and `sourceReferences` at its TOP LEVEL.
// `services/centralCosting/visibility.js` nests them under `cost` when it
// publishes — so `version.cost.inputs` is the API shape and `version.inputs`
// is the stored one, and they are not interchangeable.
//
// Reading the published path off a stored document does not throw. It returns
// `undefined`, which `|| []` turns into an empty list, which makes every
// assertion below it pass VACUOUSLY: "no material line was changed" is trivially
// true of a list you failed to read. A preservation test written that way
// proves nothing and looks green doing it.
//
// So the stored shape is read here and only here. A test that wants the API
// shape uses the API response; it does not reach into a document and hope.
"use strict";

const CostingVersion = require("../../../models/CMS_Models/Costing/CostingVersion");
const Costing = require("../../../models/CMS_Models/Costing/Costing");

/** Every stored version of one costing, oldest first. */
const versionsOf = (costingId) =>
  CostingVersion.find({ costingId }).sort({ versionNumber: 1 }).lean();

/** How many there are. */
const versionCountOf = (costingId) => CostingVersion.countDocuments({ costingId });

/** The stored cost lines of one version. Top level, never `cost.inputs`. */
const inputsOf = (version) => (version && Array.isArray(version.inputs) ? version.inputs : null);

/** The stored source references of one version. Top level, never `cost.*`. */
const referencesOf = (version) =>
  (version && Array.isArray(version.sourceReferences) ? version.sourceReferences : null);

/** Every stored line with this key, across one version. Never "the first". */
const linesWithKey = (version, lineKey) =>
  (inputsOf(version) || []).filter((l) => l.lineKey === lineKey);

/** The versions that carry a line with this key. */
const versionsCarrying = (versions, lineKey) =>
  (versions || []).filter((v) => linesWithKey(v, lineKey).length > 0);

/**
 * A material source reference, found by the item name frozen inside it.
 *
 * By content rather than by key: how references are keyed is a detail this
 * folder has already guessed wrong several times, and the item's own name is
 * on the snapshot by construction.
 */
const materialReferencesFor = (version, itemName) =>
  (referencesOf(version) || []).filter(
    (r) => (r.snapshot || []).some((f) => f.key === "itemName" && f.text === itemName),
  );

/** A reference's snapshot as a plain object, so a test reads facts by name. */
const snapshotOf = (reference) =>
  Object.fromEntries((reference?.snapshot || []).map((f) => [f.key, f.text ?? f.num]));

/**
 * Everything a preservation test has to compare, frozen as one string.
 *
 * The WHOLE documents: a comparison that named fields would miss the one that
 * moved, which is the only field that matters.
 */
async function snapshotEverything(costingId) {
  return JSON.stringify({
    versions: await versionsOf(costingId),
    costing: await Costing.findById(costingId).lean(),
  });
}


/**
 * The frozen source-fingerprint parts of one version, as stored.
 *
 * `provenance.sourceFingerprintParts`, never a top-level field and never the
 * live binding: these are what the version was CALCULATED from, which is the
 * only thing that can answer "have the inputs moved since?".
 */
const fingerprintPartsOf = (version) =>
  (version && Array.isArray(version.provenance?.sourceFingerprintParts)
    ? version.provenance.sourceFingerprintParts
    : null);

/** One frozen part by key, e.g. `ie:version`, or null. */
const fingerprintPart = (version, key) =>
  (fingerprintPartsOf(version) || []).find((p) => p.key === key) || null;

/**
 * The identity half of a frozen part's token.
 *
 * `ie:version` is `<bulletinVersionId>:<versionNo>` and
 * `ie:technicalRevision` is `<revision>:<key>`, so a caller comparing one id
 * does not have to know how the token was composed.
 */
const fingerprintId = (version, key) =>
  String(fingerprintPart(version, key)?.token || "").split(":")[0];

module.exports = {
  fingerprintPartsOf, fingerprintPart, fingerprintId,
  versionsOf, versionCountOf, inputsOf, referencesOf,
  linesWithKey, versionsCarrying, materialReferencesFor, snapshotOf,
  snapshotEverything,
};
