import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveNativeSeamOwnership, classifyDxfLocation, arcEvidence,
  internalLineEvidence, internalLineArcEvidence } = require("./rnd-clo-seam-ownership.js");

function record(pair, left, right) {
  return { pair, nativeOwnerIndices: [left, right] };
}
function candidate(pair, status, best = null, closeCutPieceCandidates = [], auxiliaryHints = []) {
  return { pair, status, best, closeCutPieceCandidates, auxiliaryHints };
}
function edge(left, right, meanGapMm = 0.1) {
  return { left, right, meanGapMm };
}

test("native IDs disambiguate mirrored and overlapping cut-piece matches", () => {
  const native = { records: [record(1, 1, 2), record(2, 3, 4),
    record(3, 1, 3), record(4, 1, 4), record(5, 5, 4)] };
  const geometry = { pairs: [
    candidate(1, "candidate-unique", edge("Front", "Back")),
    candidate(2, "candidate-unique", edge("Placket", "Sleeve")),
    candidate(3, "unresolved", null, [edge("Front", "Placket"), edge("Front", "Sleeve")]),
    candidate(4, "unresolved", null, [edge("Front", "Placket"), edge("Front", "Sleeve")]),
    candidate(5, "unresolved", null, [edge("OtherSleeve", "Sleeve"), edge("OtherSleeve", "Back")]),
  ] };
  const report = resolveNativeSeamOwnership(native, geometry);
  assert.deepEqual(report.pairs.slice(2, 4).map(pair => pair.right), ["Placket", "Sleeve"]);
  assert.equal(report.pairs[4].left, "OtherSleeve");
  assert.equal(report.resolvedOwnerPairs, 5);
  assert.equal(report.readyForDrape, false);
});

test("auxiliary trim and same-piece paths remain explicitly separate from cut seams", () => {
  const native = { records: [record(1, 0, 1), record(2, 0, 12), record(3, 1, 1)] };
  const geometry = { pairs: [
    candidate(1, "candidate-unique", edge("Collar", "Body")),
    candidate(2, "unresolved", null, [], [edge("Collar", "Piping", 1.2)]),
    candidate(3, "unresolved"),
  ] };
  const report = resolveNativeSeamOwnership(native, geometry);
  assert.equal(report.pairs[1].pathEvidence, "near-coincident-auxiliary-boundary");
  assert.equal(report.pairs[2].pathEvidence, "same-piece-path-unverified");
  assert.equal(report.nearGlbBoundaryPairs, 1);
});

test("conflicting native-to-mesh anchors fail rather than assigning a side arbitrarily", () => {
  const native = { records: [record(1, 2, 5), record(2, 2, 6)] };
  const geometry = { pairs: [candidate(1, "candidate-unique", edge("Front", "Back")),
    candidate(2, "candidate-unique", edge("Sleeve", "Collar"))] };
  assert.throws(() => resolveNativeSeamOwnership(native, geometry), /conflicts/);
});

test("missing native owner IDs cannot be called a resolved seam", () => {
  const native = { records: [record(1, 2, 5), { pair: 2, nativeOwnerIndices: [] }] };
  const geometry = { pairs: [candidate(1, "candidate-unique", edge("Front", "Back")),
    candidate(2, "unresolved")] };
  assert.throws(() => resolveNativeSeamOwnership(native, geometry), /two local owner indices/);
});

test("an internal GLB opening is not misreported as a DXF outer cut", () => {
  const pair = { left: "Pocket", right: "Front", pathEvidence: "near-coincident-glb-boundary" };
  assert.equal(classifyDxfLocation(pair, [{ maxMm: 0.1 }, { maxMm: 90 }]),
    "interior-attachment");
  assert.equal(classifyDxfLocation(pair, [{ maxMm: 0.1 }, { maxMm: 0.3 }]),
    "both-on-outer-cut");
  assert.equal(classifyDxfLocation({ left: "Sleeve", right: "Sleeve" },
    [{ maxMm: 0 }, { maxMm: 0 }]), "same-piece");
  assert.equal(classifyDxfLocation(pair, [{ maxMm: 0.1 }, null]),
    "auxiliary-not-in-dxf");
});

test("arc evidence preserves exact endpoints and flags a missing mid-edge anchor", () => {
  const outline = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const exact = arcEvidence([[0, 0], [10, 0]], outline);
  assert.equal(exact.start.index, 0);
  assert.equal(exact.end.index, 1);
  assert.equal(exact.closestArcErrorMm, 0);
  assert.equal(exact.requiresInterpolatedAnchor, false);

  const middle = arcEvidence([[0, 0], [5, 0]], outline);
  assert.equal(middle.end.distanceMm, 5);
  assert.equal(middle.endSegment.segment, 0);
  assert.equal(middle.endSegment.t, 0.5);
  assert.equal(middle.endSegment.distanceMm, 0);
  assert.equal(middle.requiresInterpolatedAnchor, true);
  assert.equal(middle.closestArcErrorMm, 5);
});

test("internal-line evidence distinguishes one match, duplicated marks and no match", () => {
  const path = [[2, 5], [5, 5], [8, 5]];
  const line = [[0, 5], [10, 5]];
  const other = [[0, 20], [10, 20]];
  const single = internalLineEvidence(path, [other, line]);
  assert.equal(single.status, "single-close-line");
  assert.equal(single.best.index, 1);
  assert.equal(single.best.maxMm, 0);
  assert.equal(single.candidateCount, 1);
  const duplicated = internalLineEvidence(path, [line, line]);
  assert.equal(duplicated.status, "ambiguous-close-lines");
  assert.equal(duplicated.candidateCount, 2);
  assert.equal(internalLineEvidence(path, [other]).status, "no-close-line");
});

test("a closed internal line reports the source path's actual measured side", () => {
  const rectangle = [[0, 0], [5, 0], [5, 1], [0, 1], [0, 0]];
  const forward = internalLineArcEvidence([[1, 0], [4, 0]], rectangle);
  assert.equal(forward.start.segment, 0);
  assert.equal(forward.end.segment, 0);
  assert.equal(forward.direction, "forward");
  assert.equal(forward.lengthErrorMm, 0);
  const reverse = internalLineArcEvidence([[4, 0], [1, 0]], rectangle);
  assert.equal(reverse.direction, "backward");
  assert.equal(reverse.lengthErrorMm, 0);
  assert.equal(internalLineArcEvidence([[1, 0], [4, 0]], rectangle.slice(0, -1)), null);
});
