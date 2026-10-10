// services/mongoPaths.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const { flattenToPaths } = require("./mongoPaths");

/* THE BUG, STATED AS A TEST.
   The employee form saves one section at a time. The Documents section sends
   the identity NUMBERS always, but the file objects only when a fresh upload
   is in browser state, and `additionalDocuments` never. Under
   `$set: { documents: {...} }` that payload replaced the sub-document and the
   files went with it. */
test("a partial sub-document merges instead of replacing it", () => {
  const paths = flattenToPaths({ documents: { aadharNumber: "A1" } });
  assert.deepEqual(paths, { "documents.aadharNumber": "A1" });
  // The thing that matters: nothing addresses `documents` itself, so no
  // sibling key is in the write at all.
  assert.ok(!("documents" in paths));
});

test("the leave cap's address branch survives an unrelated address edit", () => {
  // address.permanent.state is what the 7/10-day monthly leave cap is judged
  // on (services/leaveHomeState.service.js). A whole-object replace carrying
  // only `current` silently moved somebody between the two caps.
  const paths = flattenToPaths({ address: { current: { city: "Bhubaneswar" } } });
  assert.deepEqual(paths, { "address.current.city": "Bhubaneswar" });
  assert.ok(!Object.keys(paths).some((k) => k.startsWith("address.permanent")));
});

test("arrays are values, not branches", () => {
  // Flattening to arr.0 / arr.1 would leave the tail of a shortened array in
  // place — a different data-loss bug.
  const paths = flattenToPaths({
    fieldsNotAvailable: ["a", "b"],
    documents: { additionalDocuments: [{ name: "x" }] },
  });
  assert.deepEqual(paths.fieldsNotAvailable, ["a", "b"]);
  assert.deepEqual(paths["documents.additionalDocuments"], [{ name: "x" }]);
});

test("dates and ObjectIds are written whole", () => {
  const when = new Date("2026-10-10T00:00:00Z");
  const oid = new mongoose.Types.ObjectId();
  const paths = flattenToPaths({ updatedAt: when, departmentId: oid });
  assert.equal(paths.updatedAt, when);
  assert.equal(paths.departmentId, oid);
  assert.ok(!Object.keys(paths).some((k) => k.includes("updatedAt.")));
});

test("an empty sub-object says nothing about the sub-document", () => {
  // `bankDetails: {}` is what the form sends when every bank key is undefined
  // (an editor cannot read them, so the inputs are blank). It must not be
  // read as "empty the bank details".
  assert.deepEqual(flattenToPaths({ bankDetails: {} }), {});
});

test("clearing a value is still possible, by sending a leaf", () => {
  const paths = flattenToPaths({ workShift: { start: "", end: "", punches: null } });
  assert.deepEqual(paths, {
    "workShift.start": "",
    "workShift.end": "",
    "workShift.punches": null,
  });
});

test("the whole employee-form section payload flattens as expected", () => {
  const paths = flattenToPaths({
    identityId: "I-2",
    documents: { aadharNumber: "A", panNumber: "P" },
    address: { permanent: { state: "Odisha" }, current: { city: "BBSR" } },
    updatedBy: "u1",
  });
  assert.deepEqual(paths, {
    identityId: "I-2",
    "documents.aadharNumber": "A",
    "documents.panNumber": "P",
    "address.permanent.state": "Odisha",
    "address.current.city": "BBSR",
    updatedBy: "u1",
  });
});
