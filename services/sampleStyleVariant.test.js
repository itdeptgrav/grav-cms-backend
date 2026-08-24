// services/sampleStyleVariant.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { variantKeyFrom, variantStyleCode, buildVariantDoc } = require("./sampleStyleVariant");

test("variantKeyFrom slugs a label into a comparable key", () => {
  assert.equal(variantKeyFrom("White PC"), "white-pc");
  assert.equal(variantKeyFrom("Heavier 220 GSM"), "heavier-220-gsm");
  assert.equal(variantKeyFrom("  Contrast   Collar!!  "), "contrast-collar");
});

test("two labels that mean the same thing collide, which is the point", () => {
  assert.equal(variantKeyFrom("white pc"), variantKeyFrom("White  PC"));
});

test("a label with no usable characters yields the empty key, never a silent base collision", () => {
  // "" is the BASE variant's key. The route must reject these rather than
  // create a second style that fights the base for the unique index.
  for (const junk of ["", "   ", "!!!", "—", null, undefined]) {
    assert.equal(variantKeyFrom(junk), "", `expected "" for ${JSON.stringify(junk)}`);
  }
});

test("variantStyleCode letters siblings off the base code", () => {
  assert.equal(variantStyleCode("SC-SJ-2026-0003-01", 0), "SC-SJ-2026-0003-01B");
  assert.equal(variantStyleCode("SC-SJ-2026-0003-01", 1), "SC-SJ-2026-0003-01C");
});

test("variantStyleCode branches off the BASE even when given a sibling's code", () => {
  // Raising a variant from a variant must not produce -01BB.
  assert.equal(variantStyleCode("SC-SJ-2026-0003-01B", 1), "SC-SJ-2026-0003-01C");
});

test("variantStyleCode does not throw past the alphabet", () => {
  assert.equal(variantStyleCode("SC-SJ-2026-0003-01", 25), "SC-SJ-2026-0003-01-27");
});

const parent = () => ({
  _id: "base-id",
  journeyId: "j1",
  enquiryId: "e1",
  enquiryProductId: "p1",
  accountId: "a1",
  productName: "Gardener Shirt",
  styleCode: "SC-SJ-2026-0003-01",
  variantKey: "",
  ownerId: "o1",
  ownerName: "Sales Department",
  brief: { colour: "Navy", fabricComposition: "65/35 PC", gsm: "180", note: "As per sample" },
  materials: { status: "selected", items: ["Fabric X"] },
  techSheet: { status: "approved", approvedAt: new Date(), revisions: [{ note: "again" }] },
  sample: { status: "approved", rounds: [{ roundNo: 1, type: "fit" }], revisions: [{ note: "sleeve" }] },
  history: [{ kind: "route" }],
  status: "completed",
});

test("a variant inherits the brief so the requirement is not retyped", () => {
  const d = buildVariantDoc(parent(), { label: "White PC", styleCode: "X", actor: { name: "R" } });
  assert.equal(d.brief.fabricComposition, "65/35 PC");
  assert.equal(d.brief.note, "As per sample");
  assert.equal(d.productName, "Gardener Shirt");
  assert.equal(d.enquiryProductId, "p1");
});

test("overrides are what makes it a variant", () => {
  const d = buildVariantDoc(parent(), { label: "White PC", brief: { colour: "White" }, styleCode: "X", actor: {} });
  assert.equal(d.brief.colour, "White");
  assert.equal(d.brief.gsm, "180", "unrelated brief fields still carry over");
});

test("a variant inherits NO phase — copying an approval would claim Sales saw it", () => {
  const d = buildVariantDoc(parent(), { label: "White PC", styleCode: "X", actor: {} });
  assert.equal(d.stage, "brief");
  assert.equal(d.materials.status, "pending");
  assert.deepEqual(d.materials.items, []);
  assert.equal(d.techSheet.status, "pending");
  assert.deepEqual(d.techSheet.revisions, []);
  assert.equal(d.sample.status, "not_started");
  assert.deepEqual(d.sample.rounds, []);
  assert.deepEqual(d.sample.revisions, []);
  assert.deepEqual(d.history, []);
  assert.equal(d.status, "active");
  assert.equal(d.variantChosen, false);
});

test("variants of one product are a flat set, not a chain", () => {
  const base = parent();
  const sibling = { ...base, _id: "sib-id", variantKey: "white-pc", variantOf: "base-id" };
  const d = buildVariantDoc(sibling, { label: "Heavier GSM", styleCode: "X", actor: {} });
  assert.equal(d.variantOf, "base-id", "branching off a sibling still points at the base");
});

test("branching off the base points at the base", () => {
  const d = buildVariantDoc(parent(), { label: "White PC", styleCode: "X", actor: {} });
  assert.equal(d.variantOf, "base-id");
});

test("the key and the label are both stored — one to compare, one to read", () => {
  const d = buildVariantDoc(parent(), { label: "  White PC  ", styleCode: "X", actor: {} });
  assert.equal(d.variantKey, "white-pc");
  assert.equal(d.variantLabel, "White PC");
});
